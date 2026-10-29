use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{mpsc, oneshot};

use super::header::{FLAG_END, Header};
use super::stream::{DEFAULT_RWND, StreamEvent, StreamInner, build_data_packet};
use crate::error::Result as UdxResult;

/// Adapter that implements [`tokio::io::AsyncRead`] and [`tokio::io::AsyncWrite`]
/// over a [`super::stream::UdxStream`].
///
/// Created via [`super::stream::UdxStream::into_async_stream`]. Higher layers
/// (e.g. SecretStream) wrap this for encrypted I/O.
///
/// Drop cancels queued writes and the reliability processor. Await `flush()`
/// or `shutdown()` before dropping when queued bytes must be acknowledged.
pub struct UdxAsyncStream {
    inner: Arc<Mutex<StreamInner>>,
    read_rx: mpsc::UnboundedReceiver<StreamEvent>,
    read_buf: Vec<u8>,
    read_pos: usize,
    read_eof: bool,
    /// Writes queued on the stream but not yet acknowledged, oldest first, with
    /// their byte lengths. ACKs are cumulative, so they resolve in this order.
    pending_acks: VecDeque<(oneshot::Receiver<UdxResult<()>>, usize)>,
    unacked_bytes: usize,
    processor: Option<tokio::task::JoinHandle<()>>,
    fin_queued: bool,
    registration: Option<super::stream::SocketCleanup>,
}

impl UdxAsyncStream {
    pub(crate) fn new(
        inner: Arc<Mutex<StreamInner>>,
        read_rx: mpsc::UnboundedReceiver<StreamEvent>,
        processor: Option<tokio::task::JoinHandle<()>>,
        registration: Option<super::stream::SocketCleanup>,
    ) -> Self {
        Self {
            inner,
            read_rx,
            read_buf: Vec::new(),
            read_pos: 0,
            read_eof: false,
            pending_acks: VecDeque::new(),
            unacked_bytes: 0,
            processor,
            fin_queued: false,
            registration,
        }
    }
}

/// Bounds on the unacknowledged bytes a writer may queue before `poll_write`
/// waits for ACKs.
///
/// Waiting for each write's ACK before accepting the next limits a stream to one
/// write per round trip, far below the congestion window on WAN paths. The
/// writer may instead queue about two congestion windows: enough for congestion
/// control to keep the path full, without building seconds of queueing delay in
/// front of later writes on slow paths.
const MIN_UNACKED_WRITE_BYTES: usize = 64 * 1024;
const MAX_UNACKED_WRITE_BYTES: usize = 1024 * 1024;

impl UdxAsyncStream {
    /// Releases acknowledged writes in order. Returns `Pending` while the oldest
    /// write is unacknowledged, registering the waker on its ACK.
    fn poll_acks(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        while let Some((ack_rx, len)) = self.pending_acks.front_mut() {
            let len = *len;
            match Pin::new(ack_rx).poll(cx) {
                Poll::Ready(Ok(result)) => {
                    self.pending_acks.pop_front();
                    self.unacked_bytes -= len;
                    if let Err(e) = result {
                        return Poll::Ready(Err(io::Error::other(e.to_string())));
                    }
                }
                Poll::Ready(Err(_)) => {
                    self.pending_acks.clear();
                    self.unacked_bytes = 0;
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "UDX stream closed",
                    )));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for UdxAsyncStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.read_eof {
            return Poll::Ready(Ok(()));
        }

        if self.read_pos < self.read_buf.len() {
            let remaining = &self.read_buf[self.read_pos..];
            let n = remaining.len().min(buf.remaining());
            buf.put_slice(&remaining[..n]);
            self.read_pos += n;
            if self.read_pos >= self.read_buf.len() {
                self.read_buf.clear();
                self.read_pos = 0;
            }
            return Poll::Ready(Ok(()));
        }

        match self.read_rx.poll_recv(cx) {
            Poll::Ready(Some(StreamEvent::Data(data))) => {
                let n = data.len().min(buf.remaining());
                buf.put_slice(&data[..n]);
                if n < data.len() {
                    self.read_buf = data;
                    self.read_pos = n;
                }
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Some(StreamEvent::End)) | Poll::Ready(None) => {
                self.read_eof = true;
                Poll::Ready(Ok(()))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl AsyncWrite for UdxAsyncStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if let Poll::Ready(Err(e)) = self.poll_acks(cx) {
            return Poll::Ready(Err(e));
        }
        // Apply backpressure only once the unacknowledged window is full. The
        // oldest write's ACK wakes this task.
        let limit = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            (2 * inner.congestion.cwnd as usize * inner.max_payload())
                .clamp(MIN_UNACKED_WRITE_BYTES, MAX_UNACKED_WRITE_BYTES)
        };
        if self.unacked_bytes >= limit {
            return Poll::Pending;
        }

        // AsyncWrite permits a partial write. Large callers must obey the
        // same byte budget as many small writes; never copy an unbounded slice.
        let buf = &buf[..buf.len().min(limit - self.unacked_bytes)];

        let (prep, max_payload) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let p = inner
                .prepare_write(buf.len())
                .map_err(|e| io::Error::other(e.to_string()))?;
            let mp = inner.max_payload();
            (p, mp)
        };

        let data = buf.to_vec();
        let len = data.len();
        let remote_addr = prep.remote_addr;
        let remote_id = prep.remote_id;
        let first_seq = prep.first_seq;
        let current_ack = prep.current_ack;

        let chunks: Vec<Vec<u8>> = if data.is_empty() {
            vec![vec![]]
        } else {
            data.chunks(max_payload).map(|c| c.to_vec()).collect()
        };

        let mut wire_packets: Vec<Vec<u8>> = Vec::with_capacity(chunks.len());
        for (i, chunk) in chunks.iter().enumerate() {
            let seq = first_seq + i as u32;
            wire_packets.push(build_data_packet(remote_id, seq, current_ack, chunk));
        }

        {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if guard.send_idle() {
                guard
                    .congestion
                    .on_transmit_start(std::time::Instant::now());
            }

            let packets: Vec<(u32, Vec<u8>)> = wire_packets
                .into_iter()
                .enumerate()
                .map(|(i, pkt)| (first_seq + i as u32, pkt))
                .collect();

            guard.queue_for_send(packets, remote_addr);
        }

        self.pending_acks.push_back((prep.ack_rx, len));
        self.unacked_bytes += len;
        Poll::Ready(Ok(len))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_acks(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // Wait for queued writes, then for the FIN once it is queued.
        match self.poll_acks(cx) {
            Poll::Ready(Ok(())) => {
                if self.fin_queued {
                    return Poll::Ready(Ok(()));
                }
                // Every write is acknowledged — fall through to queue FIN
            }
            Poll::Ready(Err(e)) if e.kind() == io::ErrorKind::BrokenPipe => {
                return Poll::Ready(Ok(()));
            }
            Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
            Poll::Pending => return Poll::Pending,
        }

        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !inner.connected {
            return Poll::Ready(Ok(()));
        }
        let remote_addr = inner.remote_addr;
        if let Some(addr) = remote_addr {
            let remote_id = inner.remote_id;
            let seq = inner.next_seq;
            inner.next_seq = seq + 1;
            let ack = inner.next_remote_seq;

            let header = Header {
                type_flags: FLAG_END,
                data_offset: 0,
                remote_id,
                recv_window: DEFAULT_RWND,
                seq,
                ack,
            };
            let packet = header.encode().to_vec();

            let (ack_tx, ack_rx) = oneshot::channel();
            inner.pending_writes.push(super::stream::PendingWrite {
                ack_threshold: seq + 1,
                tx: Some(ack_tx),
            });

            inner.queue_for_send(vec![(seq, packet)], addr);
            drop(inner);

            self.fin_queued = true;
            self.pending_acks.push_back((ack_rx, 0));
            return self.as_mut().poll_shutdown(cx);
        }
        Poll::Ready(Ok(()))
    }
}

impl Unpin for UdxAsyncStream {}

impl Drop for UdxAsyncStream {
    fn drop(&mut self) {
        // Explicit shutdown awaits FIN acknowledgment. Drop cancels all sockets,
        // including stalled handshakes and losing multi-socket dials.
        if let Some(processor) = self.processor.take() {
            processor.abort();
        }
        self.registration.take();
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .terminate();
    }
}

#[cfg(test)]
mod cancellation_tests {
    #[tokio::test]
    async fn dropping_stalled_async_stream_cancels_processor_and_registration() {
        use tokio::io::AsyncWriteExt;
        let runtime = crate::UdxRuntime::new().unwrap();
        let socket = runtime.create_socket().await.unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let stream = runtime.create_stream(77).await.unwrap();
        stream
            .set_firewall_hook(&socket, 78, |_, _, _| true)
            .unwrap();
        let alternate = runtime.create_socket().await.unwrap();
        alternate
            .bind("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        stream.firewall_socket_adder()(&alternate).unwrap();
        assert!(alternate.streams_ref().lock().unwrap().contains_key(&77));
        let mut stream = stream.into_async_stream();
        let processor = stream.processor.as_ref().unwrap().abort_handle();
        assert!(socket.streams_ref().lock().unwrap().contains_key(&77));
        stream.write_all(b"unanswered greeting").await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), stream.flush())
                .await
                .is_err()
        );
        drop(stream);
        tokio::task::yield_now().await;
        assert!(processor.is_finished());
        assert!(!socket.streams_ref().lock().unwrap().contains_key(&77));
        assert!(!alternate.streams_ref().lock().unwrap().contains_key(&77));
    }
}
