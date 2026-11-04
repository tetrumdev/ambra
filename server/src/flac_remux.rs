//! Turns FLAC carried in fragmented MP4 (Tidal's segmented hi-res streams) into a plain,
//! seekable FLAC file for downloads.
//!
//! In MP4, each sample is one FLAC frame and the stream's metadata blocks sit in the `dfLa`
//! box. A native file is `fLaC`, those blocks, then the frames in order. The frames are
//! written as segments arrive; the header comes last, once the total length and a seek table
//! are known, so callers write it before the frames when assembling the file.

use std::io::{self, Write};

const STREAMINFO: u8 = 0;
const PADDING: u8 = 1;
const SEEKTABLE: u8 = 3;
/// Roughly how far apart seek points are, in seconds.
const SEEK_POINT_EVERY_SECONDS: u64 = 5;

/// A box's type, payload range and the end of the whole box, within `data`.
struct Mp4Box {
    kind: [u8; 4],
    start: usize,
    payload: usize,
    end: usize,
}

fn boxes(data: &[u8], mut offset: usize, end: usize) -> Vec<Mp4Box> {
    let mut found = Vec::new();
    while offset + 8 <= end {
        let size = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = data[offset + 4..offset + 8].try_into().unwrap();
        let (header, size) = match size {
            0 => (8, end - offset),
            1 if offset + 16 <= end => (16, u64::from_be_bytes(data[offset + 8..offset + 16].try_into().unwrap()) as usize),
            1 => break,
            size => (8, size),
        };
        if size < header || offset + size > end {
            break;
        }
        found.push(Mp4Box { kind, start: offset, payload: offset + header, end: offset + size });
        offset += size;
    }
    found
}

fn child<'a>(list: &'a [Mp4Box], kind: &[u8; 4]) -> Option<&'a Mp4Box> {
    list.iter().find(|item| &item.kind == kind)
}

fn be32(data: &[u8], offset: usize) -> Option<u32> {
    data.get(offset..offset + 4).map(|bytes| u32::from_be_bytes(bytes.try_into().unwrap()))
}

fn be64(data: &[u8], offset: usize) -> Option<u64> {
    data.get(offset..offset + 8).map(|bytes| u64::from_be_bytes(bytes.try_into().unwrap()))
}

/// Follows `path` from the top level of `data`.
fn find(data: &[u8], path: &[&[u8; 4]]) -> Option<(usize, usize)> {
    let (mut start, mut end) = (0, data.len());
    for kind in path {
        let list = boxes(data, start, end);
        let found = child(&list, kind)?;
        start = found.payload;
        end = found.end;
    }
    Some((start, end))
}

pub struct Remuxer {
    /// Metadata blocks from `dfLa`: type and data, without seek tables or padding.
    blocks: Vec<(u8, Vec<u8>)>,
    sample_rate: u64,
    default_duration: Option<u32>,
    default_size: Option<u32>,
    total_samples: u64,
    frame_bytes: u64,
    /// Sample number, byte offset from the first frame, samples in that frame.
    seek_points: Vec<(u64, u64, u16)>,
}

impl Remuxer {
    /// Reads the init segment; `None` when the stream is not FLAC.
    pub fn new(init: &[u8]) -> Option<Self> {
        let (stsd_start, stsd_end) = find(init, &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd"])?;
        // Full box header and entry count precede the sample entries.
        let entries = boxes(init, stsd_start + 8, stsd_end);
        let entry = child(&entries, b"fLaC")?;
        // An audio sample entry has 28 bytes of fields before its child boxes.
        let sample_rate = u64::from(be32(init, entry.payload + 24)? >> 16);
        let children = boxes(init, entry.payload + 28, entry.end);
        let dfla = child(&children, b"dfLa")?;
        let mut blocks = Vec::new();
        let mut offset = dfla.payload + 4;
        while offset + 4 <= dfla.end {
            let kind = init[offset] & 0x7f;
            let last = init[offset] & 0x80 != 0;
            let length = (usize::from(init[offset + 1]) << 16) | (usize::from(init[offset + 2]) << 8) | usize::from(init[offset + 3]);
            let data = init.get(offset + 4..offset + 4 + length)?.to_vec();
            if kind != SEEKTABLE && kind != PADDING {
                blocks.push((kind, data));
            }
            offset += 4 + length;
            if last {
                break;
            }
        }
        let streaminfo = blocks.iter().find(|(kind, _)| *kind == STREAMINFO)?;
        if streaminfo.1.len() != 34 {
            return None;
        }
        // STREAMINFO's own rate is exact even where the sample entry's 16-bit field overflows.
        let packed = u64::from_be_bytes(streaminfo.1[10..18].try_into().unwrap());
        let sample_rate = match packed >> 44 {
            0 => sample_rate,
            rate => rate,
        };
        let (default_duration, default_size) = find(init, &[b"moov", b"mvex", b"trex"])
            .map(|(start, _)| (be32(init, start + 12), be32(init, start + 16)))
            .unwrap_or((None, None));
        Some(Self {
            blocks,
            sample_rate: sample_rate.max(1),
            default_duration: default_duration.filter(|value| *value > 0),
            default_size: default_size.filter(|value| *value > 0),
            total_samples: 0,
            frame_bytes: 0,
            seek_points: Vec::new(),
        })
    }

    /// Writes the FLAC frames in one media segment (`moof` + `mdat`) to `frames`.
    pub fn push_segment(&mut self, segment: &[u8], frames: &mut impl Write) -> io::Result<()> {
        let invalid = |message: &str| io::Error::new(io::ErrorKind::InvalidData, format!("Tidal segment: {message}"));
        let top = boxes(segment, 0, segment.len());
        let mut wrote_any = false;
        for (index, moof) in top.iter().enumerate().filter(|(_, item)| &item.kind == b"moof") {
            // Where samples start when a run gives no offset: the next media data box.
            let mdat_payload = top[index + 1..].iter().find(|item| &item.kind == b"mdat").map(|item| item.payload);
            for traf in boxes(segment, moof.payload, moof.end).iter().filter(|item| &item.kind == b"traf") {
                let parts = boxes(segment, traf.payload, traf.end);
                let tfhd = child(&parts, b"tfhd").ok_or_else(|| invalid("missing tfhd"))?;
                let flags = be32(segment, tfhd.payload).ok_or_else(|| invalid("short tfhd"))? & 0x00ff_ffff;
                let mut cursor = tfhd.payload + 8;
                let mut base = moof.start as u64;
                if flags & 0x01 != 0 {
                    base = be64(segment, cursor).ok_or_else(|| invalid("short tfhd"))?;
                    cursor += 8;
                }
                if flags & 0x02 != 0 {
                    cursor += 4;
                }
                let mut default_duration = self.default_duration;
                let mut default_size = self.default_size;
                if flags & 0x08 != 0 {
                    default_duration = be32(segment, cursor);
                    cursor += 4;
                }
                if flags & 0x10 != 0 {
                    default_size = be32(segment, cursor);
                }
                let mut next_data: Option<u64> = None;
                for trun in parts.iter().filter(|item| &item.kind == b"trun") {
                    let flags = be32(segment, trun.payload).ok_or_else(|| invalid("short trun"))? & 0x00ff_ffff;
                    let count = be32(segment, trun.payload + 4).ok_or_else(|| invalid("short trun"))?;
                    let mut cursor = trun.payload + 8;
                    let mut data = if flags & 0x01 != 0 {
                        let offset = be32(segment, cursor).ok_or_else(|| invalid("short trun"))? as i32;
                        cursor += 4;
                        base.checked_add_signed(i64::from(offset)).ok_or_else(|| invalid("bad data offset"))?
                    } else if let Some(next) = next_data {
                        next
                    } else {
                        mdat_payload.ok_or_else(|| invalid("missing mdat"))? as u64
                    };
                    if flags & 0x04 != 0 {
                        cursor += 4;
                    }
                    for _ in 0..count {
                        let duration = if flags & 0x100 != 0 {
                            let value = be32(segment, cursor);
                            cursor += 4;
                            value
                        } else {
                            default_duration
                        }
                        .ok_or_else(|| invalid("unknown frame duration"))?;
                        let size = if flags & 0x200 != 0 {
                            let value = be32(segment, cursor);
                            cursor += 4;
                            value
                        } else {
                            default_size
                        }
                        .ok_or_else(|| invalid("unknown frame size"))?;
                        if flags & 0x400 != 0 {
                            cursor += 4;
                        }
                        if flags & 0x800 != 0 {
                            cursor += 4;
                        }
                        let start = usize::try_from(data).map_err(|_| invalid("bad data offset"))?;
                        let frame = segment.get(start..start + size as usize).ok_or_else(|| invalid("frame past the segment"))?;
                        let due = self.seek_points.last().map_or(0, |(sample, _, _)| sample + SEEK_POINT_EVERY_SECONDS * self.sample_rate);
                        if self.seek_points.is_empty() || self.total_samples >= due {
                            self.seek_points.push((self.total_samples, self.frame_bytes, duration.min(u32::from(u16::MAX)) as u16));
                        }
                        frames.write_all(frame)?;
                        self.total_samples += u64::from(duration);
                        self.frame_bytes += u64::from(size);
                        data += u64::from(size);
                        wrote_any = true;
                    }
                    next_data = Some(data);
                }
            }
        }
        if !wrote_any {
            return Err(invalid("no audio frames"));
        }
        Ok(())
    }

    /// `fLaC`, the stream's metadata with its true length, and a seek table.
    pub fn header(&self) -> Vec<u8> {
        let mut header = b"fLaC".to_vec();
        for (kind, data) in &self.blocks {
            let mut data = data.clone();
            if *kind == STREAMINFO {
                let packed = u64::from_be_bytes(data[10..18].try_into().unwrap());
                let total = self.total_samples & 0x0000_000f_ffff_ffff;
                data[10..18].copy_from_slice(&((packed & !0x0000_000f_ffff_ffff) | total).to_be_bytes());
            }
            push_block(&mut header, *kind, false, &data);
        }
        let mut table = Vec::with_capacity(self.seek_points.len() * 18);
        for (sample, offset, samples) in &self.seek_points {
            table.extend_from_slice(&sample.to_be_bytes());
            table.extend_from_slice(&offset.to_be_bytes());
            table.extend_from_slice(&samples.to_be_bytes());
        }
        push_block(&mut header, SEEKTABLE, true, &table);
        header
    }
}

fn push_block(header: &mut Vec<u8>, kind: u8, last: bool, data: &[u8]) {
    let length = data.len().min(0x00ff_ffff);
    header.push(kind | if last { 0x80 } else { 0 });
    header.extend_from_slice(&[(length >> 16) as u8, (length >> 8) as u8, length as u8]);
    header.extend_from_slice(&data[..length]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(payload);
        bytes
    }

    fn streaminfo(rate: u32) -> Vec<u8> {
        let mut data = vec![0; 34];
        data[0..2].copy_from_slice(&4096_u16.to_be_bytes());
        data[2..4].copy_from_slice(&4096_u16.to_be_bytes());
        // Rate (20 bits), channels - 1 (3), bits - 1 (5), total samples (36) = 0.
        let packed = (u64::from(rate) << 44) | (1 << 41) | (23 << 36);
        data[10..18].copy_from_slice(&packed.to_be_bytes());
        data
    }

    fn init(rate: u32) -> Vec<u8> {
        let mut dfla = vec![0, 0, 0, 0];
        dfla.push(0x80);
        dfla.extend_from_slice(&[0, 0, 34]);
        dfla.extend_from_slice(&streaminfo(rate));
        let mut entry = vec![0; 28];
        entry[24..28].copy_from_slice(&((rate.min(65_535)) << 16).to_be_bytes());
        entry.extend(mp4_box(b"dfLa", &dfla));
        let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
        stsd.extend(mp4_box(b"fLaC", &entry));
        let stbl = mp4_box(b"stbl", &mp4_box(b"stsd", &stsd));
        let trak = mp4_box(b"trak", &mp4_box(b"mdia", &mp4_box(b"minf", &stbl)));
        let mut moov_payload = trak;
        moov_payload.extend(mp4_box(b"mvex", &mp4_box(b"trex", &[0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
        let mut bytes = mp4_box(b"ftyp", b"iso6");
        bytes.extend(mp4_box(b"moov", &moov_payload));
        bytes
    }

    /// One fragment whose run gives each frame's size and points its data offset at the mdat.
    fn segment(frames: &[&[u8]]) -> Vec<u8> {
        let tfhd = mp4_box(b"tfhd", &[0, 0x02, 0, 0, 0, 0, 0, 1]);
        let build = |offset: u32| {
            let mut trun = vec![0, 0, 0x02, 0x01];
            trun.extend_from_slice(&(frames.len() as u32).to_be_bytes());
            trun.extend_from_slice(&offset.to_be_bytes());
            for frame in frames {
                trun.extend_from_slice(&(frame.len() as u32).to_be_bytes());
            }
            let mut traf = tfhd.clone();
            traf.extend(mp4_box(b"trun", &trun));
            mp4_box(b"moof", &mp4_box(b"traf", &traf))
        };
        let moof_len = build(0).len() as u32;
        let mut bytes = build(moof_len + 8);
        bytes.extend(mp4_box(b"mdat", &frames.concat()));
        bytes
    }

    #[test]
    fn rebuilds_a_native_flac_stream_with_length_and_seek_table() {
        let mut remuxer = Remuxer::new(&init(192_000)).expect("FLAC init");
        let mut frames = Vec::new();
        remuxer.push_segment(&segment(&[b"AAAA", b"BB"]), &mut frames).unwrap();
        remuxer.push_segment(&segment(&[b"CCC"]), &mut frames).unwrap();
        assert_eq!(frames, b"AAAABBCCC");
        let header = remuxer.header();
        assert_eq!(&header[..4], b"fLaC");
        assert_eq!(header[4], STREAMINFO);
        let packed = u64::from_be_bytes(header[8 + 10..8 + 18].try_into().unwrap());
        assert_eq!(packed >> 44, 192_000);
        assert_eq!(packed & 0xf_ffff_ffff, 3 * 4096);
        // The seek table closes the metadata.
        let table = 8 + 34;
        assert_eq!(header[table], 0x80 | SEEKTABLE);
        assert_eq!(&header[table + 4..table + 4 + 8], &0_u64.to_be_bytes());
    }

    #[test]
    fn other_codecs_are_left_alone() {
        let mut bytes = init(44_100);
        let position = bytes.windows(4).position(|window| window == b"fLaC").unwrap();
        bytes[position..position + 4].copy_from_slice(b"mp4a");
        assert!(Remuxer::new(&bytes).is_none());
    }
}
