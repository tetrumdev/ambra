//! A FLAC file served as HLS with fragmented-MP4 segments, for Apple's player.
//!
//! AVPlayer can't seek inside a plain FLAC file: it reads from somewhere else in the file
//! while reporting the time it was asked for, so the phone shows one place and plays another.
//! It seeks HLS segments exactly, as with Tidal's segmented FLAC. The frames go into each
//! segment unchanged (FLAC in ISO-BMFF: a `fLaC` sample entry, one sample per frame); the
//! segments start at the file's seek points, or at frames found by reading the file through.

/// Roughly how long each segment is, at least.
const SEGMENT_SECONDS: u64 = 6;

#[derive(Clone, Debug)]
pub struct Header {
    streaminfo: [u8; 34],
    pub sample_rate: u32,
    pub total_samples: u64,
    /// Where the first frame starts in the file.
    pub frames_start: u64,
    /// The block size of a fixed-blocksize stream (all frames but the last), else 0.
    fixed_block: u32,
    /// From the file's SEEKTABLE: (first sample, byte offset from `frames_start`).
    seek_points: Vec<(u64, u64)>,
}

/// One HLS segment: whole frames from `start` to `end` (byte offsets in the file).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    pub start: u64,
    pub end: u64,
    pub first_sample: u64,
    pub samples: u64,
}

/// Reads the metadata blocks. `Err(Some(n))`: the first `n` bytes are needed to finish;
/// `Err(None)`: not a FLAC file this can serve (no length, or a malformed header).
pub fn parse_header(bytes: &[u8]) -> Result<Header, Option<usize>> {
    if bytes.len() < 8 {
        return Err(Some(8));
    }
    if &bytes[..4] != b"fLaC" {
        return Err(None);
    }
    let (mut offset, mut streaminfo, mut seek_points) = (4usize, None, Vec::new());
    loop {
        let Some(head) = bytes.get(offset..offset + 4) else { return Err(Some(offset + 4)) };
        let last = head[0] & 0x80 != 0;
        let kind = head[0] & 0x7f;
        let length = (usize::from(head[1]) << 16) | (usize::from(head[2]) << 8) | usize::from(head[3]);
        let Some(body) = bytes.get(offset + 4..offset + 4 + length) else { return Err(Some(offset + 4 + length)) };
        match kind {
            0 if length == 34 => streaminfo = Some(<[u8; 34]>::try_from(body).unwrap()),
            3 => {
                for point in body.chunks_exact(18) {
                    let sample = u64::from_be_bytes(point[..8].try_into().unwrap());
                    // Placeholder points mark room left for later; they point nowhere.
                    if sample != u64::MAX {
                        seek_points.push((sample, u64::from_be_bytes(point[8..16].try_into().unwrap())));
                    }
                }
            }
            127 => return Err(None),
            _ => {}
        }
        offset += 4 + length;
        if last {
            break;
        }
    }
    let streaminfo = streaminfo.ok_or(None)?;
    let packed = u64::from_be_bytes(streaminfo[10..18].try_into().unwrap());
    let sample_rate = (packed >> 44) as u32;
    let total_samples = packed & ((1 << 36) - 1);
    if sample_rate == 0 || total_samples == 0 {
        return Err(None);
    }
    let (min_block, max_block) = (u16::from_be_bytes([streaminfo[0], streaminfo[1]]), u16::from_be_bytes([streaminfo[2], streaminfo[3]]));
    seek_points.sort_unstable();
    seek_points.dedup_by_key(|point| point.0);
    Ok(Header {
        streaminfo,
        sample_rate,
        total_samples,
        frames_start: offset as u64,
        fixed_block: if min_block == max_block { u32::from(max_block) } else { 0 },
        seek_points,
    })
}

impl Header {
    /// Segments from the file's seek table; `None` when it has none to go by.
    pub fn segments(&self, file_length: u64) -> Option<Vec<Segment>> {
        let points: Vec<(u64, u64)> = self.seek_points.iter().map(|&(sample, offset)| (sample, self.frames_start + offset)).collect();
        if points.len() < 2 {
            return None;
        }
        segments_from(&points, self.total_samples, file_length, self.sample_rate)
    }
}

fn segments_from(points: &[(u64, u64)], total_samples: u64, file_length: u64, sample_rate: u32) -> Option<Vec<Segment>> {
    let every = SEGMENT_SECONDS * u64::from(sample_rate);
    let mut starts: Vec<(u64, u64)> = Vec::new();
    for &(sample, offset) in points {
        if sample >= total_samples || offset >= file_length {
            break;
        }
        match starts.last() {
            None if sample != 0 => return None,
            Some(&(last, last_offset)) if sample < last + every || offset <= last_offset => continue,
            _ => starts.push((sample, offset)),
        }
    }
    let segments: Vec<Segment> = starts.iter().enumerate().map(|(index, &(sample, offset))| {
        let (end_sample, end) = starts.get(index + 1).copied().unwrap_or((total_samples, file_length));
        Segment { start: offset, end, first_sample: sample, samples: end_sample - sample }
    }).collect();
    (!segments.is_empty()).then_some(segments)
}

/// The media playlist; `query` (with its `?`, or empty) is added to every URI.
pub fn playlist(segments: &[Segment], sample_rate: u32, query: &str) -> String {
    let seconds = |samples: u64| samples as f64 / f64::from(sample_rate);
    let target = segments.iter().map(|segment| seconds(segment.samples).ceil() as u64).max().unwrap_or(1).max(1);
    let mut text = format!("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"dash/init{query}\"\n");
    for (index, segment) in segments.iter().enumerate() {
        text.push_str(&format!("#EXTINF:{:.6},\ndash/{index}{query}\n", seconds(segment.samples)));
    }
    text.push_str("#EXT-X-ENDLIST\n");
    text
}

/// Finds segment starts by reading the frames, for a file without a seek table: give it the
/// bytes from `wanted()` on, until `done()`.
pub struct Scan {
    header: Header,
    file_length: u64,
    next: u64,
    previous: Option<FrameHead>,
    points: Vec<(u64, u64)>,
    finished: bool,
}

impl Scan {
    pub fn new(header: &Header, file_length: u64) -> Self {
        Self { header: header.clone(), file_length, next: header.frames_start, previous: None, points: Vec::new(), finished: false }
    }

    /// Where the next bytes should start.
    pub fn wanted(&self) -> u64 {
        self.next
    }

    pub fn done(&self) -> bool {
        self.finished
    }

    /// `data` starts at `wanted()`; give at least `2 * MAX_FRAME` bytes unless the file ends
    /// sooner. Returns false when the frames can't be followed.
    pub fn feed(&mut self, data: &[u8]) -> bool {
        let eof = self.next + data.len() as u64 >= self.file_length;
        let every = SEGMENT_SECONDS * u64::from(self.header.sample_rate);
        let Some(found) = frames(data, self.previous, eof) else { return false };
        // A frame longer than any real one: not followable.
        if found.consumed == 0 && !eof && data.len() >= 2 * MAX_FRAME {
            return false;
        }
        for frame in &found.frames {
            let sample = frame.head.first_sample(self.header.fixed_block);
            if self.points.last().is_none_or(|&(last, _)| sample >= last + every) {
                self.points.push((sample, self.next + frame.start as u64));
            }
        }
        if let Some(last) = found.frames.last() {
            self.previous = Some(last.head);
        }
        self.next += found.consumed as u64;
        if eof {
            self.finished = true;
        }
        true
    }

    pub fn segments(&self) -> Option<Vec<Segment>> {
        if !self.finished {
            return None;
        }
        segments_from(&self.points, self.header.total_samples, self.file_length, self.header.sample_rate)
    }
}

/// The initialization section: one FLAC track, its STREAMINFO in `dfLa`.
pub fn init_segment(header: &Header) -> Vec<u8> {
    let rate = header.sample_rate;
    let channels = u16::from((header.streaminfo[12] >> 1) & 0x07) + 1;
    let bits = ((u16::from(header.streaminfo[12] & 0x01) << 4) | u16::from(header.streaminfo[13] >> 4)) + 1;
    let matrix = [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000].iter().flat_map(|value| value.to_be_bytes()).collect::<Vec<u8>>();

    let mut mvhd = full(0, 0);
    mvhd.extend([0u8; 8]); // creation, modification
    mvhd.extend(rate.to_be_bytes());
    mvhd.extend(0u32.to_be_bytes()); // duration: in mehd
    mvhd.extend(0x0001_0000u32.to_be_bytes());
    mvhd.extend(0x0100u16.to_be_bytes());
    mvhd.extend([0u8; 10]);
    mvhd.extend(&matrix);
    mvhd.extend([0u8; 24]);
    mvhd.extend(2u32.to_be_bytes());

    let mut tkhd = full(0, 7);
    tkhd.extend([0u8; 8]);
    tkhd.extend(1u32.to_be_bytes());
    tkhd.extend([0u8; 4]);
    tkhd.extend(0u32.to_be_bytes());
    tkhd.extend([0u8; 8]);
    tkhd.extend(0u16.to_be_bytes()); // layer
    tkhd.extend(0u16.to_be_bytes()); // alternate group
    tkhd.extend(0x0100u16.to_be_bytes());
    tkhd.extend([0u8; 2]);
    tkhd.extend(&matrix);
    tkhd.extend([0u8; 8]); // width, height

    let mut mdhd = full(0, 0);
    mdhd.extend([0u8; 8]);
    mdhd.extend(rate.to_be_bytes());
    mdhd.extend(0u32.to_be_bytes());
    mdhd.extend(0x55c4u16.to_be_bytes()); // "und"
    mdhd.extend([0u8; 2]);

    let mut hdlr = full(0, 0);
    hdlr.extend([0u8; 4]);
    hdlr.extend(*b"soun");
    hdlr.extend([0u8; 12]);
    hdlr.extend(b"SoundHandler\0");

    // FLAC in ISO-BMFF: STREAMINFO, flagged as the last metadata block.
    let mut dfla = full(0, 0);
    dfla.extend([0x80, 0, 0, 34]);
    dfla.extend(header.streaminfo);
    let mut entry = vec![0u8; 6];
    entry.extend(1u16.to_be_bytes()); // data reference index
    entry.extend([0u8; 8]);
    entry.extend(channels.to_be_bytes());
    entry.extend(bits.to_be_bytes());
    entry.extend([0u8; 4]);
    // 16.16 fixed point; a rate past 65535 can't be written there and is read from dfLa.
    entry.extend((if rate <= 0xffff { rate << 16 } else { 0 }).to_be_bytes());
    entry.extend(bx(b"dfLa", &dfla));
    let mut stsd = full(0, 0);
    stsd.extend(1u32.to_be_bytes());
    stsd.extend(bx(b"fLaC", &entry));
    let empty = |kind: &[u8; 4], extra: usize| bx(kind, &[full(0, 0), vec![0u8; extra]].concat());
    let stbl = [bx(b"stsd", &stsd), empty(b"stts", 4), empty(b"stsc", 4), empty(b"stsz", 8), empty(b"stco", 4)].concat();
    let url = full(0, 1); // self-contained
    let mut dref = full(0, 0);
    dref.extend(1u32.to_be_bytes());
    dref.extend(bx(b"url ", &url));
    let minf = [bx(b"smhd", &[full(0, 0), vec![0u8; 4]].concat()), bx(b"dinf", &bx(b"dref", &dref)), bx(b"stbl", &stbl)].concat();
    let mdia = [bx(b"mdhd", &mdhd), bx(b"hdlr", &hdlr), bx(b"minf", &minf)].concat();
    let trak = [bx(b"tkhd", &tkhd), bx(b"mdia", &mdia)].concat();

    let mut mehd = full(1, 0);
    mehd.extend(header.total_samples.to_be_bytes());
    let mut trex = full(0, 0);
    trex.extend(1u32.to_be_bytes()); // track
    trex.extend(1u32.to_be_bytes()); // sample description
    trex.extend([0u8; 12]);
    let mvex = [bx(b"mehd", &mehd), bx(b"trex", &trex)].concat();

    let mut ftyp = b"iso6".to_vec();
    ftyp.extend(0u32.to_be_bytes());
    ftyp.extend(b"iso6mp41");
    [bx(b"ftyp", &ftyp), bx(b"moov", &[bx(b"mvhd", &mvhd), bx(b"trak", &trak), bx(b"mvex", &mvex)].concat())].concat()
}

/// One media segment from `data`, the bytes `segment.start..segment.end` of the file.
pub fn media_segment(header: &Header, index: usize, segment: &Segment, data: &[u8]) -> Option<Vec<u8>> {
    let _ = header;
    let found = frames(data, None, true)?;
    if found.consumed != data.len() || found.frames.is_empty() {
        return None;
    }
    let mut trun_rows = Vec::with_capacity(found.frames.len() * 8);
    let mut remaining = segment.samples;
    for (position, frame) in found.frames.iter().enumerate() {
        let end = found.frames.get(position + 1).map_or(data.len(), |next| next.start);
        let duration = u64::from(frame.head.block_size).min(remaining);
        remaining -= duration;
        trun_rows.extend((duration as u32).to_be_bytes());
        trun_rows.extend(((end - frame.start) as u32).to_be_bytes());
    }
    let mut mfhd = full(0, 0);
    mfhd.extend((index as u32 + 1).to_be_bytes());
    let mut tfhd = full(0, 0x02_0000); // default-base-is-moof
    tfhd.extend(1u32.to_be_bytes());
    let mut tfdt = full(1, 0);
    tfdt.extend(segment.first_sample.to_be_bytes());
    // Sizes are known before the data offset, which counts from the moof's start to the media.
    let trun_size = 8 + 4 + 4 + 4 + trun_rows.len();
    let traf_size = 8 + (8 + tfhd.len()) + (8 + tfdt.len()) + trun_size;
    let moof_size = 8 + (8 + mfhd.len()) + traf_size;
    let mut trun = full(0, 0x00_0301); // data offset, sample duration, sample size
    trun.extend((found.frames.len() as u32).to_be_bytes());
    trun.extend(((moof_size + 8) as u32).to_be_bytes());
    trun.extend(trun_rows);
    let traf = [bx(b"tfhd", &tfhd), bx(b"tfdt", &tfdt), bx(b"trun", &trun)].concat();
    let moof = bx(b"moof", &[bx(b"mfhd", &mfhd), bx(b"traf", &traf)].concat());
    debug_assert_eq!(moof.len(), moof_size);
    Some([moof, bx(b"mdat", data)].concat())
}

fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend(kind);
    out.extend(body);
    out
}

fn full(version: u8, flags: u32) -> Vec<u8> {
    let mut out = vec![version];
    out.extend(&flags.to_be_bytes()[1..]);
    out
}

/// No real FLAC frame is this long; a longer search without one gives up.
pub const MAX_FRAME: usize = 1 << 20;

#[derive(Clone, Copy, Debug)]
struct FrameHead {
    variable: bool,
    /// Frame number (fixed blocksize) or first sample (variable).
    number: u64,
    block_size: u32,
    /// What stays the same frame to frame: sample rate code, bit depth code and channel count.
    /// (Block size changes for the last frame, and stereo coding from frame to frame.)
    shape: [u8; 3],
}

impl FrameHead {
    fn first_sample(&self, fixed_block: u32) -> u64 {
        if self.variable { self.number } else { self.number * u64::from(fixed_block) }
    }

    fn follows(&self, previous: &FrameHead) -> bool {
        self.variable == previous.variable && self.shape == previous.shape && if self.variable {
            self.number == previous.number + u64::from(previous.block_size)
        } else {
            self.number == previous.number + 1
        }
    }
}

/// A frame header at the start of `bytes`, checked against its CRC-8.
fn frame_head(bytes: &[u8]) -> Option<FrameHead> {
    let get = |index: usize| bytes.get(index).copied();
    if get(0)? != 0xff || get(1)? & 0xfe != 0xf8 {
        return None;
    }
    let (block_code, rate_code, layout) = (get(2)? >> 4, get(2)? & 0x0f, get(3)?);
    if block_code == 0 || rate_code == 15 || layout >> 4 > 10 || (layout >> 1) & 0x07 == 3 || layout & 1 != 0 {
        return None;
    }
    // The frame or sample number, coded like UTF-8 (up to 7 bytes).
    let first = get(4)?;
    let ones = first.leading_ones() as usize;
    let extra = match ones { 0 => 0, 2..=7 => ones - 1, _ => return None };
    let mut number = if extra == 0 { u64::from(first) } else { u64::from(first) & (0xff >> (ones + 1)) };
    for index in 0..extra {
        let byte = get(5 + index)?;
        if byte & 0xc0 != 0x80 {
            return None;
        }
        number = (number << 6) | u64::from(byte & 0x3f);
    }
    let mut at = 5 + extra;
    let block_size = match block_code {
        1 => 192,
        2..=5 => 576 << (block_code - 2),
        6 => { at += 1; u32::from(get(at - 1)?) + 1 }
        7 => { at += 2; u32::from(u16::from_be_bytes([get(at - 2)?, get(at - 1)?])) + 1 }
        _ => 256 << (block_code - 8),
    };
    at += match rate_code { 12 => 1, 13 | 14 => 2, _ => 0 };
    let crc = bytes.get(..at)?.iter().fold(0u8, |crc, &byte| {
        (0..8).fold(crc ^ byte, |crc, _| if crc & 0x80 != 0 { (crc << 1) ^ 0x07 } else { crc << 1 })
    });
    let channels = if layout >> 4 < 8 { (layout >> 4) + 1 } else { 2 };
    (get(at)? == crc).then_some(FrameHead { variable: get(1)? & 1 == 1, number, block_size, shape: [rate_code, layout & 0x0e, channels] })
}

struct Frame {
    start: usize,
    head: FrameHead,
}

struct Frames {
    frames: Vec<Frame>,
    /// Bytes up to the first frame whose end isn't known yet (all of them at the end of file).
    consumed: usize,
}

/// The frames in `data`, which starts at a frame. A frame's end is where the next valid frame
/// header that follows on from it begins; at `eof` the last frame ends with the data.
fn frames(data: &[u8], previous: Option<FrameHead>, eof: bool) -> Option<Frames> {
    let mut found = Vec::new();
    let Some(mut head) = frame_head(data) else {
        return (data.is_empty() || !eof && data.len() < 16).then_some(Frames { frames: Vec::new(), consumed: 0 });
    };
    if previous.is_some_and(|previous| !head.follows(&previous)) {
        return None;
    }
    let mut start = 0;
    loop {
        // The shortest possible frame is a header and a little more.
        let mut search = start + 6;
        let next = loop {
            let Some(offset) = data.get(search..).and_then(|rest| rest.iter().position(|&byte| byte == 0xff)) else { break None };
            let candidate = search + offset;
            if candidate - start > MAX_FRAME {
                break None;
            }
            if let Some(next) = frame_head(&data[candidate..]).filter(|next| next.follows(&head)) {
                break Some((candidate, next));
            }
            search = candidate + 1;
        };
        match next {
            Some((candidate, next)) => {
                found.push(Frame { start, head });
                start = candidate;
                head = next;
            }
            None if eof => {
                found.push(Frame { start, head });
                return Some(Frames { frames: found, consumed: data.len() });
            }
            None => return Some(Frames { frames: found, consumed: start }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crc8(bytes: &[u8]) -> u8 {
        bytes.iter().fold(0u8, |crc, &byte| (0..8).fold(crc ^ byte, |crc, _| if crc & 0x80 != 0 { (crc << 1) ^ 0x07 } else { crc << 1 }))
    }

    /// Stereo coding as real encoders choose it, frame by frame: independent, then mid/side.
    fn layout(number: usize) -> u8 { if number % 3 == 2 { 0xa8 } else { 0x18 } }

    /// A fixed-blocksize frame of 4096 samples (code 12), 44.1 kHz stereo 16-bit, numbered
    /// `number`, with a payload that also contains a false sync code.
    fn frame(number: u8, payload: usize) -> Vec<u8> {
        let mut out = vec![0xff, 0xf8, 0xc9, layout(number as usize), number];
        out.push(crc8(&out));
        out.extend((0..payload).map(|index| if index % 97 == 5 { 0xff } else if index % 97 == 6 { 0xf8 } else { (index * 31) as u8 }));
        out
    }

    fn file(frames: &[Vec<u8>], seek_table: Option<&[(u64, u64)]>, total: u64) -> Vec<u8> {
        let mut out = b"fLaC".to_vec();
        out.extend([if seek_table.is_some() { 0 } else { 0x80 }, 0, 0, 34]);
        out.extend([0x10, 0x00, 0x10, 0x00, 0, 0, 0, 0, 0, 0]);
        out.extend(((44_100u64 << 44) | (1 << 41) | (15 << 36) | total).to_be_bytes());
        out.extend([0u8; 16]);
        if let Some(points) = seek_table {
            out.push(0x83);
            out.extend(&((points.len() * 18) as u32).to_be_bytes()[1..]);
            for &(sample, offset) in points {
                out.extend(sample.to_be_bytes());
                out.extend(offset.to_be_bytes());
                out.extend(4096u16.to_be_bytes());
            }
        }
        for frame in frames {
            out.extend(frame);
        }
        out
    }

    #[test]
    fn frames_are_found_past_false_sync_codes() {
        let frames_in: Vec<Vec<u8>> = (0..5).map(|number| frame(number, 300 + number as usize * 7)).collect();
        let data = frames_in.concat();
        let header = parse_header(&file(&frames_in, None, 5 * 4096)).unwrap();
        let _ = header;
        let found = frames(&data, None, true).unwrap();
        let starts: Vec<usize> = found.frames.iter().map(|frame| frame.start).collect();
        let mut expected = Vec::new();
        let mut at = 0;
        for frame in &frames_in { expected.push(at); at += frame.len(); }
        assert_eq!(starts, expected);
        assert_eq!(found.consumed, data.len());
        // Without the end of file, the last frame's end isn't known yet.
        assert_eq!(frames(&data, None, false).unwrap().consumed, *expected.last().unwrap());
    }

    #[test]
    fn seek_table_and_scan_give_the_same_segments() {
        // 200 frames of 4096 samples at 44.1 kHz: about 18.6 s.
        let frames_in: Vec<Vec<u8>> = (0..200u32).map(|number| frame(number as u8, 200)).collect();
        // Frame numbers past 127 need two UTF-8 bytes; rebuild those properly.
        let frames_in: Vec<Vec<u8>> = frames_in.into_iter().enumerate().map(|(number, mut bytes)| {
            if number >= 128 {
                let mut head = vec![0xff, 0xf8, 0xc9, layout(number), 0xc0 | (number >> 6) as u8, 0x80 | (number & 0x3f) as u8];
                head.push(crc8(&head));
                bytes.splice(..6, head);
            }
            bytes
        }).collect();
        let total = 200 * 4096;
        let mut offsets = Vec::new();
        let mut at = 0u64;
        for frame in &frames_in { offsets.push(at); at += frame.len() as u64; }
        let points: Vec<(u64, u64)> = (0..200).step_by(10).map(|number| (number as u64 * 4096, offsets[number])).collect();
        let with_table = file(&frames_in, Some(&points), total);
        let header = parse_header(&with_table).unwrap();
        let from_table = header.segments(with_table.len() as u64).unwrap();

        let plain = file(&frames_in, None, total);
        let plain_header = parse_header(&plain).unwrap();
        assert!(plain_header.segments(plain.len() as u64).is_none());
        let mut scan = Scan::new(&plain_header, plain.len() as u64);
        while !scan.done() {
            // Small reads, so frames cross read boundaries.
            let from = scan.wanted() as usize;
            assert!(scan.feed(&plain[from..(from + 5000).min(plain.len())]));
        }
        let scanned = scan.segments().unwrap();

        // Both start a segment every 6 s or more, on frames; offsets differ only by the table.
        let shift = header.frames_start - plain_header.frames_start;
        assert_eq!(from_table.iter().map(|segment| segment.first_sample).collect::<Vec<_>>(), [0, 286_720, 573_440]);
        assert_eq!(scanned.iter().map(|segment| segment.first_sample).collect::<Vec<_>>(), [0, 266_240, 532_480, 798_720]);
        assert_eq!(from_table.iter().map(|segment| segment.samples).sum::<u64>(), total);
        assert_eq!(scanned.iter().map(|segment| segment.samples).sum::<u64>(), total);
        assert_eq!(from_table.last().unwrap().end, with_table.len() as u64);
        assert_eq!(scanned[0].start + shift, from_table[0].start);

        // Every segment is whole frames whose durations add up to the segment.
        for (index, segment) in from_table.iter().enumerate() {
            let data = &with_table[segment.start as usize..segment.end as usize];
            let media = media_segment(&header, index, segment, data).unwrap();
            assert_eq!(&media[4..8], b"moof");
            let moof = u32::from_be_bytes(media[..4].try_into().unwrap()) as usize;
            assert_eq!(&media[moof + 4..moof + 8], b"mdat");
            assert_eq!(&media[moof + 8..], data);
            let trun = media.windows(4).position(|window| window == b"trun").unwrap() + 4;
            let count = u32::from_be_bytes(media[trun + 4..trun + 8].try_into().unwrap()) as usize;
            assert_eq!(u32::from_be_bytes(media[trun + 8..trun + 12].try_into().unwrap()) as usize, moof + 8);
            let rows: Vec<(u32, u32)> = media[trun + 12..trun + 12 + count * 8].chunks(8)
                .map(|row| (u32::from_be_bytes(row[..4].try_into().unwrap()), u32::from_be_bytes(row[4..].try_into().unwrap()))).collect();
            assert_eq!(rows.iter().map(|row| u64::from(row.0)).sum::<u64>(), segment.samples);
            assert_eq!(rows.iter().map(|row| row.1 as usize).sum::<usize>(), data.len());
        }
        let text = playlist(&from_table, header.sample_rate, "?t=1");
        assert!(text.contains("#EXT-X-MAP:URI=\"dash/init?t=1\"") && text.contains("dash/2?t=1") && text.ends_with("#EXT-X-ENDLIST\n"));
        let init = init_segment(&header);
        assert_eq!(&init[4..8], b"ftyp");
        assert!(init.windows(4).any(|window| window == b"dfLa"));
    }
}
