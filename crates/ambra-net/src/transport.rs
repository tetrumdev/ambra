use crate::{Identity, PublicKey, Result};
use axum::{Router, body::Body};
use hyper::{Request, Response, body::Incoming};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use peeroxide_dht::{noise::Keypair, secret_stream::SecretStream};
use std::{net::SocketAddr, sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

/// Trusted server-side extension. No HTTP header can manufacture this value.
#[derive(Clone, Debug)]
pub struct RemotePeer {
    pub public_key: PublicKey,
    pub address: SocketAddr,
    pub session: Arc<Session>,
}

/// Server-local session order. Only a token authorized for this device may
/// supersede an older encrypted session. A late old request cannot reclaim it.
#[derive(Debug)]
pub struct Session {
    generation: u64,
    cancel: CancellationToken,
}
impl Default for Session {
    fn default() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self {
            generation: NEXT.fetch_add(1, Ordering::Relaxed),
            cancel: CancellationToken::new(),
        }
    }
}
impl Session {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn close(&self) {
        self.cancel.cancel();
    }
    pub fn is_closed(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub type BoxIo = Box<dyn Io>;

pub async fn secure<T: Io + 'static>(
    raw: T,
    identity: &Identity,
    expected: Option<PublicKey>,
) -> Result<(DuplexStream, RemotePeer, Pump)> {
    let pair = identity.key_pair();
    let stream = SecretStream::new(
        expected.is_some(),
        raw,
        Keypair {
            public_key: pair.public_key,
            secret_key: pair.secret_key,
        },
    )
    .await?;
    let key = PublicKey(*stream.remote_public_key());
    if expected.is_some_and(|expected| expected != key) {
        return Err("Server identity changed; explicit re-pairing is required".into());
    }
    let (io, pump) = adapt(stream, None);
    Ok((
        io,
        RemotePeer {
            public_key: key,
            address: "192.0.2.1:0".parse()?,
            session: Arc::new(Session::default()),
        },
        pump,
    ))
}

/// Adapts the dependency's framed Noise stream without buffering an entire HTTP body.
/// Each direction owns its cipher state. Dropping the owner cancels both directions.
pub fn adapt<T: Io + 'static>(
    stream: SecretStream<T>,
    keep_alive: Option<Box<dyn Send + Sync>>,
) -> (DuplexStream, Pump) {
    let (application, pipe) = tokio::io::duplex(64 * 1024);
    let (mut incoming, mut outgoing) = stream.into_split();
    let (mut read, mut write) = tokio::io::split(pipe);
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let task = tokio::spawn(async move {
        let _keep_alive = keep_alive;
        let started = std::time::Instant::now();
        let mut uploaded = 0u64;
        let mut downloaded = 0u64;
        let upload = async {
            let mut buffer = [0; 16 * 1024];
            let mut buffered = false;
            loop {
                let length = if buffered {
                    tokio::select! {
                        biased;
                        result = read.read(&mut buffer) => result?,
                        result = outgoing.flush() => {
                            result?;
                            buffered = false;
                            continue;
                        }
                    }
                } else {
                    read.read(&mut buffer).await?
                };
                if length == 0 {
                    outgoing.shutdown().await?;
                    return Ok::<_, crate::Error>(());
                }
                outgoing.write_buffered(&buffer[..length]).await?;
                buffered = true;
                uploaded += length as u64;
            }
        };
        let download = async {
            while let Some(bytes) = incoming.read().await? {
                write.write_all(&bytes).await?;
                downloaded += bytes.len() as u64;
            }
            write.shutdown().await?;
            Ok::<_, crate::Error>(())
        };
        tokio::select! {
            _ = stop.cancelled() => {},
            result = async { tokio::try_join!(upload, download) } => {
                if let Err(error) = result { tracing::debug!(error = ?error, "Encrypted stream pump closed"); }
            }
        }
        tracing::debug!(
            elapsed_ms = started.elapsed().as_millis(),
            uploaded,
            downloaded,
            "Encrypted stream pump finished"
        );
        stop.cancel();
    });
    (
        application,
        Pump {
            cancel,
            task,
            retained: Vec::new(),
        },
    )
}

pub struct Pump {
    cancel: CancellationToken,
    task: JoinHandle<()>,
    retained: Vec<Box<dyn Send + Sync>>,
}
impl Pump {
    pub fn retain(mut self, value: Box<dyn Send + Sync>) -> Self {
        self.retained.push(value);
        self
    }
}
impl Drop for Pump {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.task.abort();
    }
}

pub struct HttpConnection {
    sender: hyper::client::conn::http2::SendRequest<Body>,
    closed: CancellationToken,
    task: JoinHandle<()>,
    _pump: Pump,
}
impl HttpConnection {
    pub async fn new(io: DuplexStream, pump: Pump) -> Result<Arc<Self>> {
        let started = std::time::Instant::now();
        let (sender, connection) = hyper::client::conn::http2::Builder::new(TokioExecutor::new())
            .timer(TokioTimer::new())
            .keep_alive_interval(std::time::Duration::from_secs(15))
            .keep_alive_timeout(std::time::Duration::from_secs(5))
            .keep_alive_while_idle(true)
            .handshake(TokioIo::new(io))
            .await?;
        tracing::debug!(
            elapsed_ms = started.elapsed().as_millis(),
            "HTTP/2 client initialized"
        );
        let closed = CancellationToken::new();
        let stop = closed.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = stop.cancelled() => {},
                result = connection => { if let Err(error) = result { tracing::debug!(error = ?error, "HTTP/2 client connection closed"); } }
            }
            stop.cancel();
        });
        Ok(Arc::new(Self {
            sender,
            closed,
            task,
            _pump: pump,
        }))
    }
    pub fn is_closed(&self) -> bool {
        self.closed.is_cancelled() || self.sender.is_closed()
    }
    pub async fn closed(&self) {
        self.closed.cancelled().await;
    }
    pub fn close(&self) {
        self.closed.cancel();
        self._pump.cancel.cancel();
    }
    pub async fn request(&self, mut request: Request<Body>) -> Result<Response<Incoming>> {
        // The bridge has one destination. Never honor absolute proxy destinations or Host.
        let path = request.uri().path_and_query().map_or("/", |p| p.as_str());
        *request.uri_mut() = format!("http://ambra{path}").parse()?;
        request.headers_mut().remove(hyper::header::HOST);
        request.headers_mut().remove(hyper::header::CONNECTION);
        request.headers_mut().remove(hyper::header::UPGRADE);
        Ok(self.sender.clone().send_request(request).await?)
    }
}
impl Drop for HttpConnection {
    fn drop(&mut self) {
        self.closed.cancel();
        self.task.abort();
    }
}

/// Dispatch directly into Axum, never through a privileged loopback HTTP socket.
pub async fn serve(
    io: DuplexStream,
    pump: Pump,
    peer: RemotePeer,
    app: Router,
    cancel: CancellationToken,
) -> Result<()> {
    let _pump = pump;
    let superseded = peer.session.cancel.clone();
    let service = hyper::service::service_fn(move |request: Request<Incoming>| {
        let app = app.clone();
        let peer = peer.clone();
        async move {
            let mut request = request.map(Body::new);
            request
                .extensions_mut()
                .insert(axum::extract::ConnectInfo(peer.address));
            request.extensions_mut().insert(peer);
            app.oneshot(request).await
        }
    });
    let connection = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
        .timer(TokioTimer::new())
        .keep_alive_interval(std::time::Duration::from_secs(15))
        .keep_alive_timeout(std::time::Duration::from_secs(5))
        .max_concurrent_streams(64)
        .max_header_list_size(32 * 1024)
        .serve_connection(TokioIo::new(io), service);
    tokio::select! { _ = cancel.cancelled() => Ok(()), _ = superseded.cancelled() => Ok(()), result = connection => Ok(result?) }
}

#[cfg(test)]
mod batching_tests {
    use super::*;
    use std::{
        pin::Pin,
        sync::atomic::AtomicBool,
        task::{Context, Poll},
        time::Duration,
    };
    use tokio::io::ReadBuf;

    struct AckGatedIo {
        io: DuplexStream,
        acknowledge: Arc<AtomicBool>,
    }
    impl AsyncRead for AckGatedIo {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            bytes: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.io).poll_read(cx, bytes)
        }
    }
    impl AsyncWrite for AckGatedIo {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Pin::new(&mut self.io).poll_write(cx, bytes)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            if !self.acknowledge.load(Ordering::Acquire) {
                return Poll::Pending;
            }
            Pin::new(&mut self.io).poll_flush(cx)
        }
        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.io).poll_shutdown(cx)
        }
    }

    #[tokio::test]
    async fn idle_messages_flush_and_ready_frames_do_not_wait_between_acknowledgements() {
        let server_identity = Identity::generate().unwrap();
        let client_identity = Identity::generate().unwrap();
        let (client, server) = tokio::io::duplex(128 * 1024);
        let acknowledge = Arc::new(AtomicBool::new(true));
        let (client, server) = tokio::join!(
            secure(
                AckGatedIo {
                    io: client,
                    acknowledge: acknowledge.clone()
                },
                &client_identity,
                Some(server_identity.public_key())
            ),
            secure(server, &server_identity, None),
        );
        let (mut client, _, client_pump) = client.unwrap();
        let (mut server, _, server_pump) = server.unwrap();
        client.write_all(b"idle").await.unwrap();
        let mut idle = [0; 4];
        tokio::time::timeout(Duration::from_secs(1), server.read_exact(&mut idle))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&idle, b"idle");

        acknowledge.store(false, Ordering::Release);
        let payload = vec![42; 48 * 1024];
        client.write_all(&payload).await.unwrap();
        let mut received = vec![0; payload.len()];
        let result =
            tokio::time::timeout(Duration::from_millis(200), server.read_exact(&mut received))
                .await;
        drop((client_pump, server_pump));
        assert!(
            result.is_ok(),
            "the next encrypted frame waited for the previous frame's remote ACK"
        );
        result.unwrap().unwrap();
        assert_eq!(received, payload);
    }
}
