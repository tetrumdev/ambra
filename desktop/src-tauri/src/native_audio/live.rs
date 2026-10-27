//! Lossless live capture delivery. No range requests, disk cache, or speculative preloading.
use super::{AudioQuality, StreamSpec};
use crate::live_pcm::{self, StreamInfo};
use crossbeam_channel::{Receiver, bounded};
use std::{
    io::{self, Read},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub(super) struct LivePcm {
    source: HttpStream,
    info: StreamInfo,
    scratch: Vec<f64>,
    ended: bool,
}
impl LivePcm {
    pub fn open(source: String, position: f64) -> Result<Self, String> {
        let expected_id = super::decoder::live_stream_id(&source).ok_or("Invalid live PCM URL")?;
        let mut source = HttpStream::open(source)?;
        let info = StreamInfo::read(&mut source)
            .map_err(|error| format!("Live PCM initialization failed: {error}"))?;
        if info.stream_id != expected_id || (info.start_position_seconds - position).abs() > 0.1 {
            return Err(
                "Live PCM stream does not match the requested playback generation or position"
                    .into(),
            );
        }
        Ok(Self {
            source,
            info,
            scratch: Vec::new(),
            ended: false,
        })
    }
    pub fn spec(&self) -> StreamSpec {
        StreamSpec {
            sample_rate: 44_100,
            channels: 2,
            bits_per_sample: 32,
            requantize: true,
        }
    }
    pub fn duration_seconds(&self) -> f64 {
        self.info.duration_seconds
    }
    pub fn audio_quality(&self) -> AudioQuality {
        AudioQuality {
            codec: "pcm_s32le".into(),
            sample_rate_hz: 44_100,
            bit_depth: None,
            channels: 2,
            bitrate_kbps: Some(2822.4),
            bitrate_is_estimate: false,
            normalization_gain_db: None,
            capture_format: Some(self.info.format.clone()),
            requested_quality: Some(self.info.requested_quality.clone()),
            source_format_verified: Some(false),
        }
    }
    pub fn decode_next(&mut self) -> Result<Option<&[f64]>, String> {
        if self.ended {
            return Ok(None);
        }
        match live_pcm::read_frame(&mut self.source)
            .map_err(|error| format!("Live PCM stream interrupted: {error}"))?
        {
            None => {
                self.ended = true;
                Ok(None)
            }
            Some(bytes) => {
                self.scratch.clear();
                self.scratch.extend(bytes.chunks_exact(4).map(|sample| {
                    f64::from(i32::from_le_bytes(sample.try_into().unwrap())) / 2147483648.0
                }));
                Ok(Some(&self.scratch))
            }
        }
    }
}

/// Async HTTP reader isolated from the audio worker. Both chunk queue and network reads are
/// bounded. Drop cancels a pending request/read, including when the network goes away.
struct HttpStream {
    receiver: Receiver<Result<Vec<u8>, String>>,
    chunk: io::Cursor<Vec<u8>>,
    cancel: Arc<AtomicBool>,
}
impl HttpStream {
    fn open(url: String) -> Result<Self, String> {
        let (sender, receiver) = bounded(2);
        let cancel = Arc::new(AtomicBool::new(false));
        let stopped = cancel.clone();
        std::thread::Builder::new()
            .name("ambra-live-pcm".into())
            .spawn(move || {
                let result = (|| {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|_| "Could not initialize live HTTP runtime".to_owned())?;
                    runtime.block_on(async {
                        let client = reqwest::Client::builder()
                            .connect_timeout(Duration::from_secs(3))
                            .read_timeout(Duration::from_secs(35))
                            .build()
                            .map_err(|_| "Could not initialize live HTTP client".to_owned())?;
                        let cancelled = async {
                            loop {
                                if stopped.load(Ordering::Acquire) {
                                    return;
                                }
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                        };
                        let receive = async {
                            let mut response = client.get(url).send().await.map_err(|_| {
                                "Could not connect to the live PCM stream".to_owned()
                            })?;
                            if !response.status().is_success() {
                                return Err(format!(
                                    "Live PCM server answered HTTP {}",
                                    response.status().as_u16()
                                ));
                            }
                            if response
                                .headers()
                                .get(reqwest::header::CONTENT_TYPE)
                                .and_then(|v| v.to_str().ok())
                                != Some(live_pcm::MIME)
                                || response.content_length().is_some()
                            {
                                return Err(
                                    "Server did not provide a nonseekable live PCM response".into(),
                                );
                            }
                            while let Some(chunk) = response.chunk().await.map_err(|_| {
                                "Live PCM network read failed or timed out".to_owned()
                            })? {
                                for part in chunk.chunks(64 * 1024) {
                                    let mut pending = Ok(part.to_vec());
                                    loop {
                                        if stopped.load(Ordering::Acquire) {
                                            return Ok(());
                                        }
                                        match sender
                                            .send_timeout(pending, Duration::from_millis(100))
                                        {
                                            Ok(()) => break,
                                            Err(crossbeam_channel::SendTimeoutError::Timeout(
                                                value,
                                            )) => pending = value,
                                            Err(_) => return Ok(()),
                                        }
                                    }
                                }
                            }
                            Ok::<_, String>(())
                        };
                        tokio::select! { _ = cancelled => Ok(()), result = receive => result }
                    })
                })();
                if let Err(error) = result {
                    let _ = sender.send_timeout(Err(error), Duration::from_secs(1));
                }
            })
            .map_err(|_| "Could not start live PCM reader".to_owned())?;
        Ok(Self {
            receiver,
            chunk: io::Cursor::new(Vec::new()),
            cancel,
        })
    }
}
impl Read for HttpStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        loop {
            let size = self.chunk.read(bytes)?;
            if size > 0 {
                return Ok(size);
            }
            match self.receiver.recv_timeout(Duration::from_secs(40)) {
                Ok(Ok(chunk)) => self.chunk = io::Cursor::new(chunk),
                Ok(Err(error)) => return Err(io::Error::other(error)),
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return Ok(0),
                Err(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Live PCM reader stalled",
                    ));
                }
            }
        }
    }
}
impl Drop for HttpStream {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn live_source_urls_select_the_live_decoder() {
        use super::super::decoder::is_live_source;
        let id = "0123456789abcdef0123456789abcdef";
        let capability = "a".repeat(64);
        assert!(is_live_source(&format!("http://127.0.0.1:38147/api/playback/live/{id}")));
        assert!(is_live_source(&format!("http://127.0.0.1:49152/{capability}/api/playback/live/{id}?access_token=test")));
        assert!(!is_live_source("http://127.0.0.1:49152/api/providers/qobuz/tracks/1/stream"));
        assert!(!is_live_source("http://127.0.0.1:49152/unrelated/api/playback/live/stream"));
    }
    fn serve(complete: bool) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let id = "0123456789abcdef0123456789abcdef";
        let info = StreamInfo {
            stream_id: id.into(),
            track_id: "fixture".into(),
            generation: 7,
            format: Default::default(),
            start_position_seconds: 30.0,
            duration_seconds: 120.0,
            created_at_ms: 0,
            requested_quality: "lossless".into(),
            source_format_verified: false,
        };
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let mut chunk = [0; 4096];
                let size = socket.read(&mut chunk).unwrap();
                assert!(size > 0 && request.len() + size <= 16 * 1024);
                request.extend_from_slice(&chunk[..size]);
            }
            assert!(
                !String::from_utf8_lossy(&request)
                    .to_ascii_lowercase()
                    .contains("range:")
            );
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nConnection: close\r\n\r\n",
                live_pcm::MIME
            )
            .unwrap();
            let mut body = info.header().unwrap();
            body.extend(
                live_pcm::audio_frame(
                    &[i32::MIN, i32::MAX, 0, 256]
                        .into_iter()
                        .flat_map(i32::to_le_bytes)
                        .collect::<Vec<_>>(),
                )
                .unwrap(),
            );
            if complete {
                body.extend(live_pcm::end_frame());
            }
            for part in body.chunks(3) {
                socket.write_all(part).unwrap();
            }
            // Finish the response without resetting a connection that still has unread request bytes.
            socket.shutdown(std::net::Shutdown::Write).unwrap();
            let _ = std::io::copy(&mut socket, &mut std::io::sink());
        });
        (format!("http://{address}/api/playback/live/{id}"), thread)
    }
    #[test]
    fn decodes_fragmented_http_without_ranges_and_preserves_capture_precision() {
        let (url, server) = serve(true);
        let mut live = LivePcm::open(url, 30.0).unwrap();
        assert_eq!(live.info.generation, 7);
        assert_eq!(live.audio_quality().source_format_verified, Some(false));
        let samples = live.decode_next().unwrap().unwrap();
        assert_eq!(
            samples,
            &[
                -1.0,
                f64::from(i32::MAX) / 2147483648.0,
                0.0,
                256.0 / 2147483648.0
            ]
        );
        assert!(live.decode_next().unwrap().is_none());
        server.join().unwrap();
    }
    #[test]
    fn native_decoder_reads_live_capture_through_a_bridge_url_without_ranges() {
        let (url, server) = serve(true);
        let capability = "a".repeat(64);
        let url = url.replace("/api/", &format!("/{capability}/api/"));
        let mut decoder = super::super::decoder::DecodedSource::open_at(url, 30.0).unwrap();
        assert_eq!(decoder.audio_quality().codec, "pcm_s32le");
        assert_eq!(decoder.duration_seconds(), 120.0);
        assert_eq!(decoder.decode_next().unwrap().unwrap().len(), 4);
        assert!(decoder.decode_next().unwrap().is_none());
        server.join().unwrap();
    }
    #[test]
    fn network_eof_cannot_finish_a_partial_track() {
        let (url, server) = serve(false);
        let mut live = LivePcm::open(url, 30.0).unwrap();
        live.decode_next().unwrap();
        assert!(
            live.decode_next()
                .unwrap_err()
                .contains("Live PCM stream interrupted")
        );
        server.join().unwrap();
    }
}
