//! Loopback-only WebSocket control. Acknowledgements never mutate playback observations.
use super::{Error, ErrorCode, process::restart_delay};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Entity {
    pub uri: String,
    #[serde(default)]
    pub entity_type: String,
    #[serde(default)]
    pub decorations: Decorations,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Decorations {
    pub identity: Option<Identity>,
    pub playback: Option<PlaybackDecoration>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Identity {
    pub name: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct PlaybackDecoration {
    pub duration_ms: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Position {
    pub position_ms: u64,
    pub timestamp_ms: u64,
    #[serde(default)]
    pub speed: f64,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackState {
    #[default]
    Idle,
    Playing,
    Paused,
    Buffering,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct QueueEntry {
    pub uid: String,
    pub source: String,
    pub item: Option<Entity>,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Options {
    pub shuffle: bool,
    pub repeat: String,
    pub playback_speed: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    AuthState {
        logged_in: bool,
        is_active: bool,
    },
    PlaybackState {
        status: PlaybackState,
        item: Option<Entity>,
        position: Option<Position>,
        volume: Option<u8>,
        is_active: Option<bool>,
    },
    PlaybackChanged {
        status: PlaybackState,
        item: Option<Entity>,
        position: Option<Position>,
        volume: Option<u8>,
        is_active: Option<bool>,
    },
    TrackChanged {
        item: Option<Entity>,
    },
    PositionSync {
        position: Position,
    },
    VolumeChanged {
        volume: u8,
    },
    DeviceChanged {
        is_active: bool,
    },
    QueueChanged {
        #[serde(default)]
        previous: Vec<QueueEntry>,
        #[serde(default)]
        upcoming: Vec<QueueEntry>,
    },
    OptionsChanged {
        options: Options,
    },
    CommandResult {
        command: String,
    },
    Error {
        message: String,
    },
    #[serde(other)]
    Unknown,
}

#[allow(dead_code)] // Reusable local control surface; the music provider does not use Connect queue commands.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum Command {
    GetAuthState,
    GetState,
    GetQueue {
        limit: u32,
    },
    Play {
        #[serde(skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
    },
    Pause,
    Seek {
        position_ms: u64,
    },
    SkipNext,
    SkipPrev,
    SetVolume {
        volume: u8,
    },
    SetShuffle {
        enabled: bool,
    },
    SetRepeatContext {
        enabled: bool,
    },
    SetRepeatTrack {
        enabled: bool,
    },
    Activate,
    Deactivate,
}
impl Command {
    fn frame(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).expect("command serializes");
        value["type"] = "command".into();
        value
    }
    fn name(&self) -> String {
        self.frame()["command"].as_str().unwrap().to_owned()
    }
    fn needs_ack(&self) -> bool {
        !matches!(
            self,
            Self::GetAuthState | Self::GetState | Self::GetQueue { .. }
        )
    }
}

#[derive(Clone, Debug, Default)]
pub struct Observation {
    pub connected: bool,
    pub logged_in: Option<bool>,
    pub is_active: Option<bool>,
    pub state: PlaybackState,
    pub item: Option<Entity>,
    pub position: Option<Position>,
    pub volume: Option<u8>,
    pub previous: Vec<QueueEntry>,
    pub upcoming: Vec<QueueEntry>,
    pub options: Option<Options>,
    pub error: Option<Error>,
    pub serial: u64,
}
impl Observation {
    fn apply(&mut self, event: Event) {
        self.serial += 1;
        match event {
            Event::AuthState {
                logged_in,
                is_active,
            } => {
                self.logged_in = Some(logged_in);
                self.is_active = Some(is_active);
            }
            Event::PlaybackState {
                status,
                item,
                position,
                volume,
                is_active,
            }
            | Event::PlaybackChanged {
                status,
                item,
                position,
                volume,
                is_active,
            } => {
                self.state = status;
                if item.is_some() {
                    self.item = item;
                }
                if position.is_some() {
                    self.position = position;
                }
                if volume.is_some() {
                    self.volume = volume;
                }
                if is_active.is_some() {
                    self.is_active = is_active;
                }
            }
            Event::TrackChanged { item } => self.item = item,
            Event::PositionSync { position } => self.position = Some(position),
            Event::VolumeChanged { volume } => self.volume = Some(volume),
            Event::DeviceChanged { is_active } => self.is_active = Some(is_active),
            Event::QueueChanged { previous, upcoming } => {
                self.previous = previous;
                self.upcoming = upcoming;
            }
            Event::OptionsChanged { options } => self.options = Some(options),
            // The untrusted message might contain credentials. Publish a fixed error.
            Event::Error { .. } => {
                self.error = Some(Error::new(
                    ErrorCode::ControlFailed,
                    "Soloist rejected a control command; check API key, pairing, and account playback restrictions",
                ))
            }
            Event::CommandResult { .. } | Event::Unknown => {}
        }
    }
}

type Request = (Command, oneshot::Sender<Result<(), Error>>);
type Pending = (
    String,
    oneshot::Sender<Result<(), Error>>,
    tokio::time::Instant,
);
#[derive(Clone)]
pub struct Client {
    commands: mpsc::Sender<Request>,
    pub observed: watch::Receiver<Observation>,
}
impl Client {
    pub fn start(data: PathBuf, cancel: CancellationToken) -> Self {
        let (commands, receiver) = mpsc::channel(16);
        let (observed, state) = watch::channel(Observation::default());
        tokio::spawn(run(data, receiver, observed, cancel));
        Self {
            commands,
            observed: state,
        }
    }
    pub async fn send(&self, command: Command) -> Result<(), Error> {
        let (tx, rx) = oneshot::channel();
        tokio::time::timeout(Duration::from_secs(6), async {
            self.commands
                .send((command, tx))
                .await
                .map_err(|_| disconnected())?;
            rx.await.map_err(|_| disconnected())?
        })
        .await
        .map_err(|_| {
            Error::new(
                ErrorCode::ControlFailed,
                "Soloist command acknowledgement timed out",
            )
        })?
    }
}

fn disconnected() -> Error {
    Error::new(
        ErrorCode::WebsocketFailed,
        "Soloist local WebSocket is unavailable",
    )
}

pub fn read_endpoint(data: &Path) -> Option<SocketAddr> {
    let address = std::fs::read_to_string(data.join("ws.addr")).ok()?;
    let port = std::fs::read_to_string(data.join("ws.port")).ok()?;
    if address.len() > 64 || port.len() > 8 {
        return None;
    }
    let address: IpAddr = address.trim().parse().ok()?;
    let port: u16 = port.trim().parse().ok()?;
    (address.is_loopback() && port != 0).then_some(SocketAddr::new(address, port))
}

async fn run(
    data: PathBuf,
    mut commands: mpsc::Receiver<Request>,
    observed: watch::Sender<Observation>,
    cancel: CancellationToken,
) {
    let mut attempts = 0;
    loop {
        if cancel.is_cancelled() {
            return;
        }
        let endpoint = read_endpoint(&data);
        if let Some(endpoint) = endpoint {
            let connection = tokio::select! {
                _ = cancel.cancelled() => return,
                result = tokio::time::timeout(Duration::from_secs(2), connect_async_with_config(format!("ws://{endpoint}/"), Some(WebSocketConfig::default().max_message_size(Some(256 * 1024)).max_frame_size(Some(256 * 1024))), true)) => result,
            };
            if let Ok(Ok((socket, _))) = connection {
                observed.send_modify(|state| {
                    state.connected = true;
                    state.logged_in = None;
                    state.item = None;
                    state.position = None;
                    state.error = None;
                    state.serial += 1;
                });
                let (mut writer, mut reader) = socket.split();
                let mut pending: Option<Pending> = None;
                let mut heartbeat = tokio::time::interval(Duration::from_secs(2));
                let mut last_received = tokio::time::Instant::now();
                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        _ = heartbeat.tick() => {
                            if pending.as_ref().is_some_and(|(_, _, deadline)| tokio::time::Instant::now() >= *deadline) || last_received.elapsed() > Duration::from_secs(10) { break; }
                            if writer.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                        }
                        request = commands.recv(), if pending.is_none() => {
                            let Some((command, reply)) = request else { return; };
                            if writer.send(Message::Text(command.frame().to_string().into())).await.is_err() { let _ = reply.send(Err(disconnected())); break; }
                            if command.needs_ack() { pending = Some((command.name(), reply, tokio::time::Instant::now() + Duration::from_secs(5))); }
                            else { let _ = reply.send(Ok(())); }
                        }
                        frame = reader.next() => {
                            let Some(Ok(frame)) = frame else { break; };
                            last_received = tokio::time::Instant::now();
                            match frame {
                                Message::Text(text) if text.len() <= 256 * 1024 => {
                                    if let Ok(event) = serde_json::from_str::<Event>(&text) {
                                        attempts = 0;
                                        let authenticated = matches!(&event, Event::AuthState { logged_in: true, .. });
                                        if let Event::CommandResult { command } = &event {
                                            if pending.as_ref().is_some_and(|(name, _, _)| name == command) && let Some((_, reply, _)) = pending.take() { let _ = reply.send(Ok(())); }
                                        } else if matches!(event, Event::Error { .. }) && let Some((_, reply, _)) = pending.take() { let _ = reply.send(Err(Error::new(ErrorCode::ControlFailed, "Soloist rejected the command"))); }
                                        observed.send_modify(|state| state.apply(event));
                                        // Connect publishes auth_state; playback snapshots require a query.
                                        if authenticated && writer.send(Message::Text(Command::GetState.frame().to_string().into())).await.is_err() { break; }
                                    }
                                }
                                Message::Ping(data) => { if writer.send(Message::Pong(data)).await.is_err() { break; } }
                                Message::Close(_) => break,
                                _ => {}
                            }
                        }
                    }
                }
                if let Some((_, reply, _)) = pending {
                    let _ = reply.send(Err(disconnected()));
                }
            }
        }
        observed.send_modify(|state| {
            state.connected = false;
            state.serial += 1;
        });
        // Startup endpoint files may take time to appear. The process owner supplies the
        // overall startup deadline. Reconnect failures after publication are bounded.
        if endpoint.is_some() {
            let Some(delay) = restart_delay(attempts) else {
                observed.send_modify(|state| state.error = Some(disconnected()));
                return;
            };
            attempts += 1;
            tokio::select! { _ = cancel.cancelled() => return, _ = tokio::time::sleep(delay) => {} }
        } else {
            tokio::select! { _ = cancel.cancelled() => return, _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn events_are_flat_deltas_and_ack_is_not_playback() {
        let mut state = Observation::default();
        state.apply(
            serde_json::from_str(r#"{"type":"playback_changed","status":"buffering"}"#).unwrap(),
        );
        state.apply(serde_json::from_str(r#"{"type":"command_result","command":"play"}"#).unwrap());
        assert_eq!(state.state, PlaybackState::Buffering);
        state.apply(
            serde_json::from_str(r#"{"type":"auth_state","logged_in":true,"is_active":true}"#)
                .unwrap(),
        );
        assert_eq!(state.logged_in, Some(true));
        assert!(
            serde_json::from_str::<Event>(
                r#"{"type":"position_sync","position":{"position_ms":42,"timestamp_ms":0}}"#
            )
            .is_ok()
        );
        assert_eq!(
            Command::Seek { position_ms: 4000 }.frame(),
            serde_json::json!({"type":"command", "command":"seek", "position_ms":4000})
        );
    }
    #[tokio::test]
    async fn real_mock_socket_ack_then_async_event() {
        use tokio_tungstenite::accept_async;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let directory =
            std::env::temp_dir().join(format!("ambra-ws-{}", crate::server_config::random_hex(8)));
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("ws.addr"), "0.0.0.0").unwrap();
        std::fs::write(
            directory.join("ws.port"),
            listener.local_addr().unwrap().port().to_string(),
        )
        .unwrap();
        assert!(read_endpoint(&directory).is_none());
        std::fs::write(directory.join("ws.addr"), "127.0.0.1").unwrap();
        let cancel = CancellationToken::new();
        let client = Client::start(directory.clone(), cancel.clone());
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            socket
                .send(Message::Text(
                    r#"{"type":"auth_state","logged_in":true,"is_active":true}"#.into(),
                ))
                .await
                .unwrap();
            while let Some(Ok(frame)) = socket.next().await {
                match frame {
                    Message::Text(text)
                        if serde_json::from_str::<serde_json::Value>(&text).unwrap()["command"]
                            == "pause" =>
                    {
                        socket
                            .send(Message::Text(
                                r#"{"type":"command_result","command":"pause"}"#.into(),
                            ))
                            .await
                            .unwrap();
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        socket
                            .send(Message::Text(
                                r#"{"type":"playback_changed","status":"paused"}"#.into(),
                            ))
                            .await
                            .unwrap();
                        break;
                    }
                    Message::Ping(data) => {
                        socket.send(Message::Pong(data)).await.unwrap();
                    }
                    _ => {}
                }
            }
        });
        let mut seen = client.observed.clone();
        tokio::time::timeout(Duration::from_secs(3), async {
            while seen.borrow().logged_in != Some(true) {
                seen.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        client.send(Command::Pause).await.unwrap();
        assert_eq!(client.observed.borrow().state, PlaybackState::Idle);
        tokio::time::timeout(Duration::from_secs(3), async {
            while seen.borrow().state != PlaybackState::Paused {
                seen.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        cancel.cancel();
        server.await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
