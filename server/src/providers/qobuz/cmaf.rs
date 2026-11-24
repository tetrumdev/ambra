//! Expose verified CMAF audio as a byte-addressable native FLAC stream.

use std::{io, ops::Range, sync::Arc};

use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream};
use qbz_qobuz::{CMAF_PREFETCH_CONCURRENCY, CmafStreamingInfo, cmaf::fetch_verified_segment};

pub struct CmafSource {
    setup: CmafStreamingInfo,
    http: reqwest::Client,
    offsets: Vec<u64>,
}

impl CmafSource {
    pub(super) fn new(setup: CmafStreamingInfo, http: reqwest::Client) -> Self {
        // The init table describes *decrypted* FLAC lengths. The first entry
        // starts after the FLAC header, so ranges never address container bytes.
        let header_len = setup.flac_header.len() as u64;
        let offsets = std::iter::once(header_len)
            .chain(
                setup
                    .segment_table
                    .iter()
                    .scan(header_len, |offset, entry| {
                        *offset += u64::from(entry.byte_len);
                        Some(*offset)
                    }),
            )
            .collect();
        Self {
            setup,
            http,
            offsets,
        }
    }

    pub fn content_length(&self) -> u64 {
        self.offsets
            .last()
            .copied()
            .expect("offsets include the FLAC header")
    }

    pub fn bytes(
        self: Arc<Self>,
        range: Range<u64>,
    ) -> impl Stream<Item = io::Result<Bytes>> + Send {
        let header_end = self.offsets[0];
        let header = (range.start < header_end).then(|| {
            Bytes::copy_from_slice(
                &self.setup.flac_header[range.start as usize..range.end.min(header_end) as usize],
            )
        });
        let segments: Vec<_> = self
            .offsets
            .windows(2)
            .enumerate()
            .filter_map(|(index, offsets)| {
                let start = range.start.max(offsets[0]);
                let end = range.end.min(offsets[1]);
                (start < end).then(|| {
                    (
                        index,
                        (start - offsets[0]) as usize..(end - offsets[0]) as usize,
                    )
                })
            })
            .collect();
        let segments = stream::iter(segments)
            .map(move |(index, bounds)| {
                let source = self.clone();
                async move {
                    let segment = fetch_verified_segment(&source.http, &source.setup, index)
                        .await
                        .map_err(io::Error::other)?;
                    Ok(Bytes::from(segment).slice(bounds))
                }
            })
            .buffered(CMAF_PREFETCH_CONCURRENCY);
        stream::iter(header.map(Ok)).chain(segments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::TryStreamExt;
    use qbz_qobuz::cmaf::SegmentTableEntry;
    use std::sync::Mutex;

    fn segment(payload: &[u8]) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&44u32.to_be_bytes());
        data.extend_from_slice(b"uuid");
        data.extend_from_slice(&[
            0x3b, 0x42, 0x12, 0x92, 0x56, 0xf3, 0x5f, 0x75, 0x92, 0x36, 0x63, 0xb6, 0x9a, 0x1f,
            0x52, 0xb2,
        ]);
        data.extend_from_slice(&0u32.to_be_bytes());
        data.extend_from_slice(&52u32.to_be_bytes());
        data.extend_from_slice(&[0, 0, 0, 1]);
        data.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        data.extend_from_slice(&[0; 4]);
        data.extend_from_slice(&(8 + payload.len() as u32).to_be_bytes());
        data.extend_from_slice(b"mdat");
        data.extend_from_slice(payload);
        data
    }

    #[tokio::test]
    async fn range_returns_only_the_requested_decrypted_flac_bytes() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let router = axum::Router::new().route(
            "/{index}",
            axum::routing::get({
                let requests = requests.clone();
                move |axum::extract::Path(index): axum::extract::Path<usize>| {
                    let requests = requests.clone();
                    async move {
                        requests.lock().unwrap().push(index);
                        if index == 1 {
                            // Force completion out of order.
                            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                        }
                        segment(&[b'0' + index as u8; 4])
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let source = Arc::new(CmafSource::new(
            CmafStreamingInfo {
                url_template: format!("http://{address}/$SEGMENT$"),
                n_segments: 3,
                content_key: [0; 16],
                flac_header: b"fLaC".to_vec(),
                segment_table: (0..3)
                    .map(|_| SegmentTableEntry {
                        byte_len: 4,
                        sample_count: 0,
                    })
                    .collect(),
                format_id: 27,
                sampling_rate: Some(192),
                bit_depth: Some(24),
                init_fetch_ms: 0,
            },
            reqwest::Client::new(),
        ));

        assert_eq!(source.content_length(), 16);
        let header = source
            .clone()
            .bytes(0..4)
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        assert_eq!(header.concat(), b"fLaC");
        assert!(requests.lock().unwrap().is_empty());
        let audio = source.bytes(2..11).try_collect::<Vec<_>>().await.unwrap();
        assert_eq!(audio.concat(), b"aC1111222");
        let mut requested = requests.lock().unwrap().clone();
        requested.sort_unstable();
        assert_eq!(requested, [1, 2]);
        server.abort();
    }
}
