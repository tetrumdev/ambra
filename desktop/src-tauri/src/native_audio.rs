use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TryRecvError, bounded, unbounded};
use serde::Serialize;
use tauri::{App, Manager, State};

mod decoder;
mod output;

use decoder::DecodedSource;
use output::{AudioOutput, PlatformOutput};

const LOCAL_PREBUFFER_MILLISECONDS: usize = 150;
const LOCAL_MAX_BUFFER_MILLISECONDS: usize = 750;
const NETWORK_PREBUFFER_MILLISECONDS: usize = 1_500;
const NETWORK_PRELOAD_MILLISECONDS: usize = 6_000;
const NETWORK_MAX_BUFFER_MILLISECONDS: usize = 12_000;
const STREAM_RECOVERY_ATTEMPTS: usize = 2;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const PAUSED_DEVICE_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);
const DECODE_BLOCKS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct StreamSpec {
    sample_rate: u32,
    channels: usize,
    bits_per_sample: u16,
}

pub struct NativeAudioPlayer {
    command_tx: Sender<WorkerCommand>,
    status: Arc<Mutex<PlaybackStatus>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone, Default)]
struct PlaybackStatus {
    current_source: Option<String>,
    current_time: f64,
    duration: f64,
    is_playing: bool,
    buffering: bool,
    ended: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioStatus {
    current_source: Option<String>,
    current_time: f64,
    duration: f64,
    is_playing: bool,
    buffering: bool,
    ended: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioDevice {
    id: String,
    name: String,
    is_default: bool,
}

enum WorkerCommand {
    Load {
        source: String,
        next_source: Option<String>,
        position_seconds: f64,
        autoplay: bool,
        reply: Sender<Result<(), String>>,
    },
    Queue {
        source: String,
        reply: Sender<Result<(), String>>,
    },
    Play {
        reply: Sender<Result<(), String>>,
    },
    Pause {
        reply: Sender<Result<(), String>>,
    },
    Seek {
        position_seconds: f64,
        reply: Sender<Result<(), String>>,
    },
    ListDevices {
        reply: Sender<Result<Vec<NativeAudioDevice>, String>>,
    },
    SelectDevice {
        device_id: Option<String>,
        reply: Sender<Result<(), String>>,
    },
    GetExclusiveMode {
        reply: Sender<Result<bool, String>>,
    },
    SetExclusiveMode {
        enabled: bool,
        reply: Sender<Result<(), String>>,
    },
    Shutdown,
}

pub fn setup(app: &mut App) {
    let (command_tx, command_rx) = unbounded();
    let status = Arc::new(Mutex::new(PlaybackStatus::default()));
    let worker_status = status.clone();
    let worker = thread::Builder::new()
        .name("ambra-native-audio".to_owned())
        .spawn(move || PlaybackWorker::new(command_rx, worker_status).run())
        .expect("could not start the native audio worker");
    app.manage(NativeAudioPlayer {
        command_tx,
        status,
        worker: Mutex::new(Some(worker)),
    });
}

#[tauri::command]
pub async fn load_native_audio(
    player: State<'_, NativeAudioPlayer>,
    source: String,
    next_source: Option<String>,
    position_seconds: f64,
    autoplay: bool,
) -> Result<(), String> {
    let position_seconds = valid_position(position_seconds)?;
    let command_tx = player.command_tx.clone();
    request_async(command_tx, move |reply| WorkerCommand::Load {
        source,
        next_source,
        position_seconds,
        autoplay,
        reply,
    })
    .await
}

#[tauri::command]
pub async fn queue_native_audio(
    player: State<'_, NativeAudioPlayer>,
    source: String,
) -> Result<(), String> {
    let command_tx = player.command_tx.clone();
    request_async(command_tx, move |reply| WorkerCommand::Queue {
        source,
        reply,
    })
    .await
}

#[tauri::command]
pub async fn play_native_audio(player: State<'_, NativeAudioPlayer>) -> Result<(), String> {
    request_async(player.command_tx.clone(), |reply| WorkerCommand::Play {
        reply,
    })
    .await
}

#[tauri::command]
pub async fn pause_native_audio(player: State<'_, NativeAudioPlayer>) -> Result<(), String> {
    update_status(&player.status, |status| status.is_playing = false);
    request_async(player.command_tx.clone(), |reply| WorkerCommand::Pause {
        reply,
    })
    .await
}

#[tauri::command]
pub async fn seek_native_audio(
    player: State<'_, NativeAudioPlayer>,
    position_seconds: f64,
) -> Result<(), String> {
    let position_seconds = valid_position(position_seconds)?;
    update_status(&player.status, |status| {
        status.current_time = position_seconds;
        status.is_playing = false;
        status.buffering = true;
        status.ended = false;
        status.error = None;
    });
    let command_tx = player.command_tx.clone();
    request_async(command_tx, move |reply| WorkerCommand::Seek {
        position_seconds,
        reply,
    })
    .await
}

#[tauri::command]
pub fn native_audio_status(
    player: State<'_, NativeAudioPlayer>,
) -> Result<NativeAudioStatus, String> {
    let status = lock_status(&player.status).clone();
    Ok(NativeAudioStatus {
        current_source: status.current_source,
        current_time: status.current_time,
        duration: status.duration,
        is_playing: status.is_playing,
        buffering: status.buffering,
        ended: status.ended,
        error: status.error,
    })
}

#[tauri::command]
pub async fn list_native_audio_devices(
    player: State<'_, NativeAudioPlayer>,
) -> Result<Vec<NativeAudioDevice>, String> {
    request_async(player.command_tx.clone(), |reply| {
        WorkerCommand::ListDevices { reply }
    })
    .await
}

#[tauri::command]
pub async fn select_native_audio_device(
    player: State<'_, NativeAudioPlayer>,
    device_id: Option<String>,
) -> Result<(), String> {
    if device_id.as_ref().is_some_and(|id| id.is_empty()) {
        return Err("The native audio device ID cannot be empty".to_owned());
    }
    let command_tx = player.command_tx.clone();
    request_async(command_tx, move |reply| WorkerCommand::SelectDevice {
        device_id,
        reply,
    })
    .await
}

#[tauri::command]
pub async fn native_audio_exclusive_mode(
    player: State<'_, NativeAudioPlayer>,
) -> Result<bool, String> {
    request_async(player.command_tx.clone(), |reply| {
        WorkerCommand::GetExclusiveMode { reply }
    })
    .await
}

#[tauri::command]
pub async fn set_native_audio_exclusive_mode(
    player: State<'_, NativeAudioPlayer>,
    enabled: bool,
) -> Result<(), String> {
    request_async(player.command_tx.clone(), move |reply| {
        WorkerCommand::SetExclusiveMode { enabled, reply }
    })
    .await
}

impl Drop for NativeAudioPlayer {
    fn drop(&mut self) {
        let _ = self.command_tx.send(WorkerCommand::Shutdown);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = worker.join();
        }
    }
}

fn request<T>(
    command_tx: &Sender<WorkerCommand>,
    command: impl FnOnce(Sender<Result<T, String>>) -> WorkerCommand,
) -> Result<T, String> {
    let (reply_tx, reply_rx) = bounded(1);
    command_tx
        .send(command(reply_tx))
        .map_err(|_| "The native audio worker is unavailable".to_owned())?;
    reply_rx
        .recv_timeout(COMMAND_TIMEOUT)
        .map_err(|_| "The native audio worker did not respond".to_owned())?
}

async fn request_async<T: Send + 'static>(
    command_tx: Sender<WorkerCommand>,
    command: impl FnOnce(Sender<Result<T, String>>) -> WorkerCommand + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || request(&command_tx, command))
        .await
        .map_err(|error| format!("The native audio command task failed: {error}"))?
}

fn valid_position(position_seconds: f64) -> Result<f64, String> {
    position_seconds
        .is_finite()
        .then(|| position_seconds.max(0.0))
        .ok_or_else(|| "The requested playback position is invalid".to_owned())
}

struct PlaybackWorker {
    command_rx: Receiver<WorkerCommand>,
    status: Arc<Mutex<PlaybackStatus>>,
    decoder: Option<DecoderStream>,
    output: Option<PlatformOutput>,
    pcm: VecDeque<f64>,
    spec: Option<StreamSpec>,
    next_source: Option<QueuedSource>,
    ready_next: Option<(String, PreparedSource)>,
    desired_playing: bool,
    decoder_ended: bool,
    position_base: f64,
    rendered_frames: u64,
    current_source: Option<String>,
    rendering: bool,
    selected_device_id: Option<String>,
    exclusive_mode: bool,
}

struct QueuedSource {
    source: String,
    receiver: Receiver<Result<PreparedSource, String>>,
}

struct PreparedSource {
    decoder: DecodedSource,
    pcm: VecDeque<f64>,
    decoder_ended: bool,
    max_buffer_samples: usize,
}

enum DecodeMessage {
    Samples(Vec<f64>),
    End,
    Error(String),
}

struct DecoderStream {
    receiver: Receiver<DecodeMessage>,
    pool_tx: Sender<Vec<f64>>,
    stop: Arc<AtomicBool>,
}

impl DecoderStream {
    fn start(mut decoder: DecodedSource) -> Result<Self, String> {
        let (sender, receiver) = bounded(DECODE_BLOCKS);
        let (pool_tx, pool_rx) = bounded::<Vec<f64>>(DECODE_BLOCKS);
        let stop = Arc::new(AtomicBool::new(false));
        let decoder_stop = stop.clone();
        thread::Builder::new()
            .name("ambra-audio-decode".to_owned())
            .spawn(move || {
                while !decoder_stop.load(Ordering::Acquire) {
                    let message = match decoder.decode_next() {
                        Ok(Some(samples)) => {
                            let mut block = pool_rx.try_recv().unwrap_or_default();
                            block.clear();
                            block.extend_from_slice(samples);
                            DecodeMessage::Samples(block)
                        }
                        Ok(None) => DecodeMessage::End,
                        Err(error) => DecodeMessage::Error(error),
                    };
                    let terminal = matches!(message, DecodeMessage::End | DecodeMessage::Error(_));
                    if sender.send(message).is_err() || terminal {
                        break;
                    }
                }
            })
            .map_err(|error| format!("Could not start native audio decoding: {error}"))?;
        Ok(Self {
            receiver,
            pool_tx,
            stop,
        })
    }
}

impl Drop for DecoderStream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

impl QueuedSource {
    fn prepare(source: String) -> Result<Self, String> {
        let (sender, receiver) = bounded(1);
        let decoder_source = source.clone();
        thread::Builder::new()
            .name("ambra-audio-preload".to_owned())
            .spawn(move || {
                let _ = sender.send(prepare_source(decoder_source, true));
            })
            .map_err(|error| format!("Could not start native audio preloading: {error}"))?;
        Ok(Self { source, receiver })
    }
}

impl PlaybackWorker {
    fn new(command_rx: Receiver<WorkerCommand>, status: Arc<Mutex<PlaybackStatus>>) -> Self {
        Self {
            command_rx,
            status,
            decoder: None,
            output: None,
            pcm: VecDeque::new(),
            spec: None,
            next_source: None,
            ready_next: None,
            desired_playing: false,
            decoder_ended: false,
            position_base: 0.0,
            rendered_frames: 0,
            current_source: None,
            rendering: false,
            selected_device_id: None,
            exclusive_mode: false,
        }
    }

    fn run(mut self) {
        loop {
            let command = if self.desired_playing && self.current_source.is_some() {
                self.command_rx.try_recv().ok()
            } else if self.output.is_some() {
                match self.command_rx.recv_timeout(PAUSED_DEVICE_RELEASE_TIMEOUT) {
                    Ok(command) => Some(command),
                    Err(RecvTimeoutError::Timeout) => {
                        if let Err(error) = self.release_paused_output() {
                            self.fail(error);
                        }
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match self.command_rx.recv() {
                    Ok(command) => Some(command),
                    Err(_) => break,
                }
            };
            if let Some(command) = command {
                if self.handle_command(command) {
                    break;
                }
                continue;
            }
            if let Err(error) = self.pump() {
                if let Err(error) = self.recover_stream(error) {
                    self.fail(error);
                }
            }
        }
        if let Some(output) = self.output.as_mut() {
            let _ = output.pause();
        }
    }

    fn handle_command(&mut self, command: WorkerCommand) -> bool {
        match command {
            WorkerCommand::Load {
                source,
                next_source,
                position_seconds,
                autoplay,
                reply,
            } => {
                let result = self.load(source, next_source, position_seconds, autoplay);
                if let Err(error) = &result {
                    self.fail(error.clone());
                }
                let _ = reply.send(result);
            }
            WorkerCommand::Queue { source, reply } => {
                let is_already_queued = self
                    .next_source
                    .as_ref()
                    .is_some_and(|queued| queued.source == source)
                    || self
                        .ready_next
                        .as_ref()
                        .is_some_and(|(queued, _)| queued == &source);
                let result = if is_already_queued {
                    Ok(())
                } else {
                    QueuedSource::prepare(source).map(|source| {
                        self.next_source = Some(source);
                        self.ready_next = None;
                    })
                };
                let _ = reply.send(result);
            }
            WorkerCommand::Play { reply } => {
                let result = self.play();
                if let Err(error) = &result {
                    self.fail(error.clone());
                }
                let _ = reply.send(result);
            }
            WorkerCommand::Pause { reply } => {
                let result = self.pause();
                if let Err(error) = &result {
                    self.fail(error.clone());
                }
                let _ = reply.send(result);
            }
            WorkerCommand::Seek {
                position_seconds,
                reply,
            } => {
                let result = self.seek(position_seconds);
                if let Err(error) = &result {
                    self.fail(error.clone());
                }
                let _ = reply.send(result);
            }
            WorkerCommand::ListDevices { reply } => {
                let _ = reply.send(PlatformOutput::list_devices());
            }
            WorkerCommand::SelectDevice { device_id, reply } => {
                let result = self.select_device(device_id);
                let _ = reply.send(result);
            }
            WorkerCommand::GetExclusiveMode { reply } => {
                let _ = reply.send(Ok(self.exclusive_mode));
            }
            WorkerCommand::SetExclusiveMode { enabled, reply } => {
                let result = self.set_exclusive_mode(enabled);
                let _ = reply.send(result);
            }
            WorkerCommand::Shutdown => return true,
        }
        false
    }

    fn select_device(&mut self, device_id: Option<String>) -> Result<(), String> {
        if self.selected_device_id == device_id {
            return Ok(());
        }

        if let Some(device_id) = device_id.as_ref() {
            let devices = PlatformOutput::list_devices()?;

            if !devices.iter().any(|device| &device.id == device_id) {
                return Err("The selected native audio device is no longer available".to_owned());
            }
        }

        let previous_device_id = self.selected_device_id.clone();
        let position_seconds = lock_status(&self.status).current_time;
        let has_loaded_source = self.current_source.is_some();

        if let Some(output) = self.output.as_mut() {
            output.reset()?;
        }

        self.output = None;
        self.selected_device_id = device_id;

        if has_loaded_source {
            if let Err(error) = self.seek(position_seconds) {
                self.selected_device_id = previous_device_id;
                let _ = self.seek(position_seconds);
                return Err(error);
            }
        }

        Ok(())
    }

    fn set_exclusive_mode(&mut self, enabled: bool) -> Result<(), String> {
        if self.exclusive_mode == enabled {
            return Ok(());
        }

        let previous_mode = self.exclusive_mode;
        let position_seconds = lock_status(&self.status).current_time;
        let has_loaded_source = self.current_source.is_some();

        if let Some(output) = self.output.as_mut() {
            output.reset()?;
        }

        self.output = None;
        self.exclusive_mode = enabled;

        if has_loaded_source {
            if let Err(error) = self.seek(position_seconds) {
                self.exclusive_mode = previous_mode;
                let _ = self.seek(position_seconds);
                return Err(error);
            }
        }

        Ok(())
    }

    fn load(
        &mut self,
        source: String,
        next_source: Option<String>,
        position_seconds: f64,
        autoplay: bool,
    ) -> Result<(), String> {
        if let Some(output) = self.output.as_mut() {
            output.reset()?;
        }
        self.output = None;
        self.decoder = None;
        self.pcm.clear();
        self.desired_playing = autoplay;
        self.decoder_ended = false;
        self.next_source = next_source.map(QueuedSource::prepare).transpose()?;
        self.ready_next = None;
        self.position_base = position_seconds;
        self.rendered_frames = 0;
        self.current_source = Some(source.clone());
        self.rendering = false;
        self.set_buffering(Some(source.clone()), position_seconds, 0.0);

        let prepared = prepare_source_at(source.clone(), position_seconds)?;
        let spec = prepared.decoder.spec();
        let duration = prepared.decoder.duration_seconds();
        self.install_prepared(prepared)?;
        let selected_device_id = self.selected_device_id.as_deref();

        self.output = autoplay
            .then(|| {
                PlatformOutput::open_device_with_mode(spec, selected_device_id, self.exclusive_mode)
            })
            .transpose()?;

        update_status(&self.status, |status| {
            status.current_source = Some(source);
            status.current_time = position_seconds;
            status.duration = duration;
            status.is_playing = false;
            status.buffering = false;
            status.ended = false;
            status.error = None;
        });
        Ok(())
    }

    fn play(&mut self) -> Result<(), String> {
        let source = self
            .current_source
            .clone()
            .ok_or_else(|| "No native audio track is loaded".to_owned())?;
        if self.decoder.is_none() && !self.decoder_ended {
            let status = lock_status(&self.status).clone();
            let position_seconds = status.current_time;
            self.set_buffering(Some(source.clone()), position_seconds, status.duration);
            let prepared = prepare_source_at(source, position_seconds)?;
            self.install_prepared(prepared)?;
        }
        if self.output.is_none() {
            let spec = self
                .spec
                .ok_or_else(|| "No native audio track is loaded".to_owned())?;
            self.output = Some(PlatformOutput::open_device_with_mode(
                spec,
                self.selected_device_id.as_deref(),
                self.exclusive_mode,
            )?);
        }
        self.desired_playing = true;
        update_status(&self.status, |status| {
            status.ended = false;
            status.error = None;
        });
        Ok(())
    }

    fn pause(&mut self) -> Result<(), String> {
        self.desired_playing = false;
        if let Some(output) = self.output.as_mut() {
            output.pause()?;
        }
        self.rendering = false;
        update_status(&self.status, |status| {
            status.is_playing = false;
            status.buffering = false;
        });
        Ok(())
    }

    fn seek(&mut self, position_seconds: f64) -> Result<(), String> {
        let spec = self
            .spec
            .ok_or_else(|| "No native audio track is loaded".to_owned())?;
        if let Some(output) = self.output.as_mut() {
            output.reset()?;
        }
        self.rendering = false;
        self.position_base = position_seconds;
        self.rendered_frames = 0;
        let source = self
            .current_source
            .clone()
            .ok_or_else(|| "No native audio track is loaded".to_owned())?;
        self.decoder = None;
        self.pcm.clear();
        let prepared = prepare_source_at(source, position_seconds)?;
        self.install_prepared(prepared)?;
        if self.desired_playing && self.output.is_none() {
            self.output = Some(PlatformOutput::open_device_with_mode(
                spec,
                self.selected_device_id.as_deref(),
                self.exclusive_mode,
            )?);
        }
        update_status(&self.status, |status| {
            status.current_time = position_seconds;
            status.is_playing = false;
            status.buffering = false;
            status.ended = false;
            status.error = None;
        });
        Ok(())
    }

    fn pump(&mut self) -> Result<(), String> {
        let spec = self
            .spec
            .ok_or_else(|| "The native audio format is unavailable".to_owned())?;
        let prebuffer = prebuffer_samples(spec, self.current_source.as_deref(), false);
        self.drain_decoder()?;

        if !self.rendering && self.pcm.len() < prebuffer && !self.decoder_ended {
            update_status(&self.status, |status| {
                status.is_playing = false;
                status.buffering = true;
            });
            thread::sleep(Duration::from_millis(1));
            return Ok(());
        }

        if self.rendering && self.pcm.is_empty() && !self.decoder_ended {
            if let Some(output) = self.output.as_mut() {
                output.pause()?;
            }
            self.rendering = false;
            update_status(&self.status, |status| {
                status.is_playing = false;
                status.buffering = true;
            });
            return Ok(());
        }

        if self.pcm.is_empty() && self.decoder_ended {
            self.poll_next_source()?;
            if let Some((_, prepared)) = self.ready_next.as_ref()
                && self.spec == Some(prepared.decoder.spec())
            {
                let (source, prepared) = self.ready_next.take().expect("ready source disappeared");
                return self.advance(source, prepared);
            }

            let output = self
                .output
                .as_mut()
                .ok_or_else(|| "The native audio output is unavailable".to_owned())?;
            if !output.is_drained()? {
                return Ok(());
            }
            if let Some((source, prepared)) = self.ready_next.take() {
                return self.advance(source, prepared);
            }
            if self.next_source.is_some() {
                output.pause()?;
                self.rendering = false;
                update_status(&self.status, |status| {
                    status.is_playing = false;
                    status.buffering = true;
                });
                thread::sleep(Duration::from_millis(1));
                return Ok(());
            }
            output.pause()?;
            self.rendering = false;
            self.output = None;
            self.desired_playing = false;
            update_status(&self.status, |status| {
                status.current_time = status.duration;
                status.is_playing = false;
                status.buffering = false;
                status.ended = true;
            });
            return Ok(());
        }

        let output = self
            .output
            .as_mut()
            .ok_or_else(|| "The native audio output is unavailable".to_owned())?;
        if !self.rendering {
            output.start()?;
            self.rendering = true;
        }
        update_status(&self.status, |status| {
            status.is_playing = true;
            status.buffering = false;
        });

        if !self.pcm.is_empty() {
            let (first, second) = self.pcm.as_slices();
            let frames = output.write(first, second)?;
            if frames > 0 {
                let consumed_samples = frames * spec.channels;
                self.pcm.drain(..consumed_samples);
                self.rendered_frames = self.rendered_frames.saturating_add(frames as u64);
                let queued_frames = output.queued_frames()? as u64;
                let audible_frames = self.rendered_frames.saturating_sub(queued_frames);
                let current_time =
                    self.position_base + audible_frames as f64 / f64::from(spec.sample_rate);
                update_status(&self.status, |status| status.current_time = current_time);
            }
        }

        self.drain_decoder()?;
        Ok(())
    }

    fn drain_decoder(&mut self) -> Result<(), String> {
        let network_source = self
            .current_source
            .as_deref()
            .is_some_and(is_network_source);
        while self.pcm.len()
            < self
                .spec
                .map_or(0, |spec| max_buffer_samples(spec, network_source))
            && !self.decoder_ended
        {
            let message = match self.decoder.as_ref() {
                Some(decoder) => decoder.receiver.try_recv(),
                None => return Ok(()),
            };
            match message {
                Ok(DecodeMessage::Samples(mut samples)) => {
                    self.pcm.extend(samples.iter().copied());
                    samples.clear();
                    if let Some(decoder) = self.decoder.as_ref() {
                        let _ = decoder.pool_tx.try_send(samples);
                    }
                }
                Ok(DecodeMessage::End) => {
                    self.decoder_ended = true;
                    self.decoder = None;
                }
                Ok(DecodeMessage::Error(error)) => {
                    self.decoder = None;
                    return Err(error);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.decoder = None;
                    return Err("The native audio decoder stopped unexpectedly".to_owned());
                }
            }
        }
        Ok(())
    }

    fn poll_next_source(&mut self) -> Result<(), String> {
        let Some(queued) = self.next_source.as_ref() else {
            return Ok(());
        };
        match queued.receiver.try_recv() {
            Ok(Ok(prepared)) => {
                let queued = self.next_source.take().expect("queued source disappeared");
                self.ready_next = Some((queued.source, prepared));
            }
            Ok(Err(error)) => {
                self.next_source = None;
                return Err(format!("Could not preload the next track: {error}"));
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                self.next_source = None;
                return Err("The native audio preloader stopped unexpectedly".to_owned());
            }
        }
        Ok(())
    }

    fn advance(&mut self, source: String, prepared: PreparedSource) -> Result<(), String> {
        let next_spec = prepared.decoder.spec();
        let duration = prepared.decoder.duration_seconds();
        let format_changed = self.spec != Some(next_spec);
        if format_changed {
            if let Some(output) = self.output.as_mut() {
                output.reset()?;
            }
            self.output = Some(PlatformOutput::open_device_with_mode(
                next_spec,
                self.selected_device_id.as_deref(),
                self.exclusive_mode,
            )?);

            self.rendering = false;
        }

        self.install_prepared(prepared)?;
        self.current_source = Some(source.clone());
        self.position_base = 0.0;
        self.rendered_frames = 0;
        update_status(&self.status, |status| {
            status.current_source = Some(source);
            status.current_time = 0.0;
            status.duration = duration;
            status.is_playing = false;
            status.buffering = false;
            status.ended = false;
            status.error = None;
        });
        Ok(())
    }

    fn install_prepared(&mut self, prepared: PreparedSource) -> Result<(), String> {
        let PreparedSource {
            decoder,
            mut pcm,
            decoder_ended,
            max_buffer_samples,
        } = prepared;
        let spec = decoder.spec();
        pcm.reserve(max_buffer_samples.saturating_sub(pcm.len()));
        let stream = (!decoder_ended)
            .then(|| DecoderStream::start(decoder))
            .transpose()?;
        self.pcm = pcm;
        self.decoder = stream;
        self.spec = Some(spec);
        self.decoder_ended = decoder_ended;
        Ok(())
    }

    fn set_buffering(&self, source: Option<String>, current_time: f64, duration: f64) {
        update_status(&self.status, |status| {
            status.current_source = source;
            status.current_time = current_time;
            status.duration = duration;
            status.is_playing = false;
            status.buffering = true;
            status.ended = false;
            status.error = None;
        });
    }

    fn release_paused_output(&mut self) -> Result<(), String> {
        if self.desired_playing || self.output.is_none() {
            return Ok(());
        }
        let spec = self
            .spec
            .ok_or_else(|| "The native audio format is unavailable".to_owned())?;
        let queued_frames = self
            .output
            .as_mut()
            .ok_or_else(|| "The native audio output is unavailable".to_owned())?
            .queued_frames()? as u64;
        let audible_frames = self.rendered_frames.saturating_sub(queued_frames);
        let position_seconds =
            self.position_base + audible_frames as f64 / f64::from(spec.sample_rate);

        if let Some(output) = self.output.as_mut() {
            output.reset()?;
        }
        self.output = None;
        self.rendering = false;
        self.decoder = None;
        self.pcm.clear();
        self.position_base = position_seconds;
        self.rendered_frames = 0;
        let source = self
            .current_source
            .clone()
            .ok_or_else(|| "No native audio track is loaded".to_owned())?;
        let prepared = prepare_source_at(source, position_seconds)?;
        self.install_prepared(prepared)?;
        update_status(&self.status, |status| {
            status.current_time = position_seconds;
            status.is_playing = false;
            status.buffering = false;
        });
        Ok(())
    }

    fn fail(&mut self, error: String) {
        self.desired_playing = false;
        if let Some(output) = self.output.as_mut() {
            let _ = output.pause();
        }
        self.output = None;
        self.decoder = None;
        self.pcm.clear();
        self.decoder_ended = false;
        self.rendering = false;
        update_status(&self.status, |status| {
            status.is_playing = false;
            status.buffering = false;
            status.error = Some(error);
        });
    }

    fn recover_stream(&mut self, original_error: String) -> Result<(), String> {
        let source = self
            .current_source
            .clone()
            .filter(|source| is_network_source(source))
            .filter(|_| is_retryable_stream_error(&original_error))
            .ok_or(original_error.clone())?;
        let status = lock_status(&self.status).clone();
        let position_seconds = status.current_time;

        if let Some(output) = self.output.as_mut() {
            let _ = output.reset();
        }
        self.rendering = false;
        self.decoder = None;
        self.pcm.clear();
        self.decoder_ended = false;
        self.set_buffering(Some(source.clone()), position_seconds, status.duration);

        let mut recovery_error = original_error.clone();
        for attempt in 0..STREAM_RECOVERY_ATTEMPTS {
            if attempt > 0 {
                thread::sleep(Duration::from_millis(250 * attempt as u64));
            }
            match prepare_source_at(source.clone(), position_seconds) {
                Ok(prepared) => {
                    let spec = prepared.decoder.spec();
                    let duration = prepared.decoder.duration_seconds();
                    if self.spec != Some(spec) {
                        self.output = None;
                    }
                    self.install_prepared(prepared)?;
                    if self.output.is_none() {
                        self.output = Some(PlatformOutput::open_device_with_mode(
                            spec,
                            self.selected_device_id.as_deref(),
                            self.exclusive_mode,
                        )?);
                    }
                    self.position_base = position_seconds;
                    self.rendered_frames = 0;
                    update_status(&self.status, |status| {
                        status.current_time = position_seconds;
                        status.duration = duration;
                        status.is_playing = false;
                        status.buffering = true;
                        status.ended = false;
                        status.error = None;
                    });
                    return Ok(());
                }
                Err(error) => recovery_error = error,
            }
        }
        Err(format!(
            "{original_error}. Automatic stream recovery also failed: {recovery_error}"
        ))
    }
}

fn prepare_source(source: String, preload: bool) -> Result<PreparedSource, String> {
    prepare_source_with_buffer(source, 0.0, preload)
}

fn prepare_source_at(source: String, position_seconds: f64) -> Result<PreparedSource, String> {
    prepare_source_with_buffer(source, position_seconds, false)
}

fn prepare_source_with_buffer(
    source: String,
    position_seconds: f64,
    preload: bool,
) -> Result<PreparedSource, String> {
    let network_source = is_network_source(&source);
    let mut decoder = DecodedSource::open(source)?;
    if position_seconds > 0.0 {
        decoder.seek(position_seconds)?;
    }
    let spec = decoder.spec();
    let max_buffer_samples = max_buffer_samples(spec, network_source);
    let prebuffer_samples = prebuffer_samples_for_kind(spec, network_source, preload);
    let mut pcm = VecDeque::with_capacity(max_buffer_samples);
    let mut decoder_ended = false;
    while pcm.len() < prebuffer_samples && !decoder_ended {
        match decoder.decode_next()? {
            Some(samples) => pcm.extend(samples.iter().copied()),
            None => decoder_ended = true,
        }
    }
    Ok(PreparedSource {
        decoder,
        pcm,
        decoder_ended,
        max_buffer_samples,
    })
}

fn prebuffer_samples(spec: StreamSpec, source: Option<&str>, preload: bool) -> usize {
    prebuffer_samples_for_kind(spec, source.is_some_and(is_network_source), preload)
}

fn prebuffer_samples_for_kind(spec: StreamSpec, network_source: bool, preload: bool) -> usize {
    let milliseconds = if network_source {
        if preload {
            NETWORK_PRELOAD_MILLISECONDS
        } else {
            NETWORK_PREBUFFER_MILLISECONDS
        }
    } else {
        LOCAL_PREBUFFER_MILLISECONDS
    };
    spec.sample_rate as usize * spec.channels * milliseconds / 1_000
}

fn max_buffer_samples(spec: StreamSpec, network_source: bool) -> usize {
    let milliseconds = if network_source {
        NETWORK_MAX_BUFFER_MILLISECONDS
    } else {
        LOCAL_MAX_BUFFER_MILLISECONDS
    };
    spec.sample_rate as usize * spec.channels * milliseconds / 1_000
}

fn is_network_source(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

fn is_retryable_stream_error(error: &str) -> bool {
    error.starts_with("Could not read ") || error == "The native audio decoder stopped unexpectedly"
}

fn update_status(status: &Arc<Mutex<PlaybackStatus>>, update: impl FnOnce(&mut PlaybackStatus)) {
    update(&mut lock_status(status));
}

fn lock_status(status: &Arc<Mutex<PlaybackStatus>>) -> std::sync::MutexGuard<'_, PlaybackStatus> {
    status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{StreamSpec, max_buffer_samples, prebuffer_samples, valid_position};

    #[test]
    fn rejects_non_finite_seek_positions() {
        assert!(valid_position(f64::NAN).is_err());
        assert!(valid_position(f64::INFINITY).is_err());
        assert_eq!(valid_position(-2.0).unwrap(), 0.0);
    }

    #[test]
    fn sizes_buffers_in_interleaved_samples() {
        let spec = StreamSpec {
            sample_rate: 48_000,
            channels: 2,
            bits_per_sample: 24,
        };
        assert_eq!(
            prebuffer_samples(spec, Some("file:///track.flac"), false),
            14_400
        );
        assert_eq!(max_buffer_samples(spec, false), 72_000);
        assert_eq!(
            prebuffer_samples(spec, Some("https://audio.test/track.flac"), false),
            144_000
        );
        assert_eq!(max_buffer_samples(spec, true), 1_152_000);
    }
}
