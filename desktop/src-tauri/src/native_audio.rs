use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TryRecvError, bounded, unbounded};
use serde::Serialize;
use tauri::{App, AppHandle, Emitter, Manager, State};

mod decoder;
mod dsp;
mod gain;
mod output;
mod resync;
mod settings;

use decoder::DecodedSource;
use dsp::{DspEngine, DspStatus, ImpulseFile};
use gain::GainStage;
use output::{AudioOutput, PlatformOutput};
use resync::ResyncDelay;
use settings::AudioSettings;

const LOCAL_PREBUFFER_MILLISECONDS: usize = 150;
const LOCAL_MAX_BUFFER_MILLISECONDS: usize = 750;
const NETWORK_PREBUFFER_MILLISECONDS: usize = 500;
const NETWORK_PRELOAD_MILLISECONDS: usize = 6_000;
const NETWORK_MAX_BUFFER_MILLISECONDS: usize = 12_000;
const STREAM_RECOVERY_ATTEMPTS: usize = 2;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const AUDIO_PREPARE_TIMEOUT: Duration = Duration::from_secs(20);
const PAUSED_DEVICE_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);
const DECODE_BLOCKS: usize = 8;
const GAIN_BLOCK_FRAMES: usize = 1_024;
const SOURCE_CHANGED_EVENT: &str = "native-audio-source-changed";
const END_PRELOAD_TIMEOUT: Duration = Duration::from_secs(3);
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_millis(500);
const MAX_OUTPUT_DRAIN_WAIT: Duration = Duration::from_secs(5);

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
    audio_quality: Option<AudioQuality>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AudioQuality {
    codec: String,
    sample_rate_hz: u32,
    bit_depth: Option<u32>,
    channels: usize,
    bitrate_kbps: Option<f64>,
    bitrate_is_estimate: bool,
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
    audio_quality: Option<AudioQuality>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioDevice {
    id: String,
    name: String,
    is_default: bool,
}

enum WorkerCommand {
    Warm {
        source: String,
    },
    Load {
        source: String,
        next_source: Option<String>,
        position_seconds: f64,
        autoplay: bool,
        reply: Sender<Result<(), String>>,
    },
    Queue {
        source: Option<String>,
        expected_source: Option<String>,
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
    GetVolume {
        reply: Sender<Result<f64, String>>,
    },
    SetVolume {
        volume: f64,
        reply: Sender<Result<(), String>>,
    },
    GetAudioSettings {
        reply: Sender<Result<AudioSettings, String>>,
    },
    SetAudioSettings {
        settings: AudioSettings,
        reply: Sender<Result<(), String>>,
    },
    GetDspStatus {
        reply: Sender<Result<DspStatus, String>>,
    },
    Shutdown,
}

pub fn setup(app: &mut App) {
    let (command_tx, command_rx) = unbounded();
    let status = Arc::new(Mutex::new(PlaybackStatus::default()));
    let worker_status = status.clone();
    let worker_app = app.handle().clone();
    let worker = thread::Builder::new()
        .name("ambra-native-audio".to_owned())
        .spawn(move || PlaybackWorker::new(command_rx, worker_status, Some(worker_app)).run())
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
pub fn warm_native_audio(
    player: State<'_, NativeAudioPlayer>,
    source: String,
) -> Result<(), String> {
    player
        .command_tx
        .send(WorkerCommand::Warm { source })
        .map_err(|_| "The native audio worker stopped".to_owned())
}

#[tauri::command]
pub async fn queue_native_audio(
    player: State<'_, NativeAudioPlayer>,
    source: Option<String>,
    expected_source: Option<String>,
) -> Result<(), String> {
    let command_tx = player.command_tx.clone();
    request_async(command_tx, move |reply| WorkerCommand::Queue {
        source,
        expected_source,
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
pub async fn native_audio_status(
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
        audio_quality: status.audio_quality,
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

#[tauri::command]
pub async fn native_audio_volume(player: State<'_, NativeAudioPlayer>) -> Result<f64, String> {
    request_async(player.command_tx.clone(), |reply| {
        WorkerCommand::GetVolume { reply }
    })
    .await
}

#[tauri::command]
pub async fn set_native_audio_volume(
    player: State<'_, NativeAudioPlayer>,
    volume: f64,
) -> Result<(), String> {
    request_async(player.command_tx.clone(), move |reply| {
        WorkerCommand::SetVolume { volume, reply }
    })
    .await
}

#[tauri::command]
pub async fn native_audio_settings(
    player: State<'_, NativeAudioPlayer>,
) -> Result<AudioSettings, String> {
    request_async(player.command_tx.clone(), |reply| {
        WorkerCommand::GetAudioSettings { reply }
    })
    .await
}

#[tauri::command]
pub async fn set_native_audio_settings(
    player: State<'_, NativeAudioPlayer>,
    settings: AudioSettings,
) -> Result<(), String> {
    request_async(player.command_tx.clone(), |reply| {
        WorkerCommand::SetAudioSettings { settings, reply }
    })
    .await
}

#[tauri::command]
pub async fn native_dsp_status(player: State<'_, NativeAudioPlayer>) -> Result<DspStatus, String> {
    request_async(player.command_tx.clone(), |reply| {
        WorkerCommand::GetDspStatus { reply }
    })
    .await
}

#[tauri::command]
pub async fn import_dsp_impulse(
    app: AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<ImpulseFile, String> {
    let directory = crate::persistent_data_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (sample_rate, channels) = dsp::read_impulse(&bytes)?;
        let id = format!(
            "{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos(),
            crate::TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        crate::write_file_atomic(&dsp::impulse_path(&directory, &id)?, &bytes)?;
        Ok(ImpulseFile {
            id,
            name: name.chars().take(200).collect(),
            sample_rate,
            channels: channels.len(),
            frames: channels[0].len(),
        })
    })
    .await
    .map_err(|e| format!("Impulse import failed: {e}"))?
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

type PlaybackWorker = PlaybackEngine<PlatformOutput>;

// Keep the entire playback loop testable against real device behaviours,
// including partial writes, stale padding and end-of-track transitions.
struct PlaybackEngine<O: AudioOutput> {
    command_rx: Receiver<WorkerCommand>,
    status: Arc<Mutex<PlaybackStatus>>,
    decoder: Option<DecoderStream>,
    output: Option<O>,
    resync: ResyncDelay,
    end_preload_started_at: Option<Instant>,
    output_drain_deadline: Option<Instant>,
    pcm: VecDeque<f64>,
    spec: Option<StreamSpec>,
    next_source: Option<QueuedSource>,
    ready_next: Option<(String, PreparedSource)>,
    warm_source: Option<QueuedSource>,
    desired_playing: bool,
    decoder_ended: bool,
    position_base: f64,
    rendered_frames: u64,
    current_source: Option<String>,
    rendering: bool,
    selected_device_id: Option<String>,
    exclusive_mode: bool,
    gain: GainStage,
    audio_settings: AudioSettings,
    dsp: Option<DspEngine>,
    tail_frames_remaining: usize,
    draining_dsp_tail: bool,
    gain_buffer: Vec<f64>,
    gain_buffer_offset: usize,
    event_app: Option<AppHandle>,
}

struct QueuedSource {
    source: String,
    receiver: Receiver<Result<PreparedSource, String>>,
    foreground: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}

impl Drop for QueuedSource {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
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
        Self::prepare_with_buffer(source, true)
    }

    fn prepare_with_buffer(source: String, preload: bool) -> Result<Self, String> {
        Self::prepare_at(source, 0.0, preload)
    }

    fn prepare_at(source: String, position_seconds: f64, preload: bool) -> Result<Self, String> {
        let (sender, receiver) = bounded(1);
        let decoder_source = source.clone();
        let foreground = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_foreground = foreground.clone();
        let worker_cancelled = cancelled.clone();
        thread::Builder::new()
            .name("ambra-audio-preload".to_owned())
            .spawn(move || {
                let _ = sender.send(prepare_source_with_control(
                    decoder_source,
                    position_seconds,
                    preload,
                    Some(&worker_foreground),
                    Some(&worker_cancelled),
                ));
            })
            .map_err(|error| format!("Could not start native audio preloading: {error}"))?;
        Ok(Self {
            source,
            receiver,
            foreground,
            cancelled,
        })
    }

    fn wait_for_preparation(&self, timeout: Duration) -> Result<PreparedSource, String> {
        // A click needs the startup buffer, not the entire speculative buffer.
        self.foreground.store(true, Ordering::Release);
        match self.receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                self.cancelled.store(true, Ordering::Release);
                Err("Audio loading timed out. Check the streaming service connection or try another track.".into())
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err("The native audio preloader stopped unexpectedly".into())
            }
        }
    }

    fn into_foreground(self, timeout: Duration) -> Result<Option<PreparedSource>, String> {
        match self.wait_for_preparation(timeout) {
            Ok(prepared) => Ok(Some(prepared)),
            // A failed speculative load can be retried, but a timed-out load
            // must release the playback worker rather than start another wait.
            Err(_) if !self.cancelled.load(Ordering::Acquire) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

impl<O: AudioOutput> PlaybackEngine<O> {
    fn new(
        command_rx: Receiver<WorkerCommand>,
        status: Arc<Mutex<PlaybackStatus>>,
        event_app: Option<AppHandle>,
    ) -> Self {
        let mut worker = Self {
            command_rx,
            status,
            decoder: None,
            output: None,
            resync: ResyncDelay::default(),
            end_preload_started_at: None,
            output_drain_deadline: None,
            pcm: VecDeque::new(),
            spec: None,
            next_source: None,
            ready_next: None,
            warm_source: None,
            desired_playing: false,
            decoder_ended: false,
            position_base: 0.0,
            rendered_frames: 0,
            current_source: None,
            rendering: false,
            selected_device_id: None,
            exclusive_mode: false,
            gain: GainStage::default(),
            audio_settings: AudioSettings::default(),
            dsp: None,
            tail_frames_remaining: 0,
            draining_dsp_tail: false,
            gain_buffer: Vec::new(),
            gain_buffer_offset: 0,
            event_app,
        };
        if let Some(app) = worker.event_app.as_ref() {
            match crate::persistent_data_directory(app).and_then(|path| AudioSettings::load(&path))
            {
                Ok(mut settings) => {
                    if let Ok(devices) = O::list_devices() {
                        settings.discover(&devices);
                        if !settings.selected_output_id.is_empty()
                            && !devices.iter().any(|d| d.id == settings.selected_output_id)
                        {
                            settings.selected_output_id.clear();
                        }
                    }
                    worker.selected_device_id = (!settings.selected_output_id.is_empty())
                        .then(|| settings.selected_output_id.clone());
                    worker.exclusive_mode = settings.selected().exclusive_mode;
                    worker.audio_settings = settings;
                }
                Err(error) => eprintln!("{error}"),
            }
        }
        worker
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
            WorkerCommand::Warm { source } => {
                let already_preparing = self.current_source.as_ref() == Some(&source)
                    || self
                        .next_source
                        .as_ref()
                        .is_some_and(|queued| queued.source == source)
                    || self
                        .ready_next
                        .as_ref()
                        .is_some_and(|(ready, _)| ready == &source)
                    || self
                        .warm_source
                        .as_ref()
                        .is_some_and(|warm| warm.source == source || warm.receiver.is_empty());
                if !already_preparing {
                    self.warm_source = QueuedSource::prepare_with_buffer(source, false).ok();
                }
            }
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
            WorkerCommand::Queue {
                source,
                expected_source,
                reply,
            } => {
                let result = self.queue(source, expected_source);
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
                let _ = reply.send(O::list_devices());
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
            WorkerCommand::GetVolume { reply } => {
                let _ = reply.send(Ok(self.gain.volume()));
            }
            WorkerCommand::SetVolume { volume, reply } => {
                let result = self
                    .gain
                    .set_volume(volume, self.spec.map(|spec| spec.sample_rate))
                    .and_then(|()| {
                        if let Some(output) = self.output.as_mut() {
                            output.set_gain(self.gain.amplitude())?;
                        }
                        Ok(())
                    });
                let _ = reply.send(result);
            }
            WorkerCommand::GetAudioSettings { reply } => {
                let result = O::list_devices().map(|devices| {
                    self.audio_settings.discover(&devices);
                    self.audio_settings.clone()
                });
                let _ = reply.send(result);
            }
            WorkerCommand::SetAudioSettings { settings, reply } => {
                let result = self.apply_audio_settings(settings);
                let _ = reply.send(result);
            }
            WorkerCommand::GetDspStatus { reply } => {
                let _ = reply.send(Ok(self
                    .dsp
                    .as_ref()
                    .map(|d| d.status.clone())
                    .unwrap_or_default()));
            }
            WorkerCommand::Shutdown => return true,
        }
        false
    }

    fn audio_directory(&self) -> Result<std::path::PathBuf, String> {
        self.event_app
            .as_ref()
            .map(crate::persistent_data_directory)
            .transpose()
            .map(|path| path.unwrap_or_else(std::env::temp_dir))
    }

    fn apply_audio_settings(&mut self, settings: AudioSettings) -> Result<(), String> {
        settings.validate()?;
        let directory = self.audio_directory()?;
        let device_id =
            (!settings.selected_output_id.is_empty()).then(|| settings.selected_output_id.clone());
        let mode = settings.selected().exclusive_mode;
        let output_changed = self.selected_device_id != device_id || self.exclusive_mode != mode;
        if output_changed {
            if !settings.selected().enabled {
                return Err("Enable this output in Settings before selecting it".into());
            }
            if let Some(id) = device_id.as_ref() {
                if !O::list_devices()?.iter().any(|d| &d.id == id) {
                    return Err("This output is disconnected".into());
                }
            }
        }
        let preset_changed = settings.preset() != self.audio_settings.preset();
        let prepared_dsp = if preset_changed || output_changed {
            self.spec
                .map(|spec| {
                    DspEngine::build(
                        settings.preset(),
                        spec.sample_rate,
                        spec.channels,
                        &directory,
                    )
                })
                .transpose()?
        } else {
            None
        };
        // Persist first; a failed write must not change the live signal path.
        let previous_settings = self.audio_settings.clone();
        if self.event_app.is_some() {
            settings.save(&directory)?;
        }
        let old_id = self.selected_device_id.clone();
        let old_mode = self.exclusive_mode;
        let position = lock_status(&self.status).current_time;
        self.audio_settings = settings;
        if output_changed {
            if let Some(output) = self.output.as_mut() {
                if let Err(error) = output.reset() {
                    self.audio_settings = previous_settings;
                    if self.event_app.is_some() {
                        let _ = self.audio_settings.save(&directory);
                    }
                    return Err(error);
                }
            }
            self.output = None;
            self.selected_device_id = device_id;
            self.exclusive_mode = mode;
            if self.current_source.is_some() {
                if let Err(error) = self.seek(position) {
                    self.audio_settings = previous_settings;
                    self.selected_device_id = old_id;
                    self.exclusive_mode = old_mode;
                    if self.event_app.is_some() {
                        let _ = self.audio_settings.save(&directory);
                    }
                    let _ = self.seek(position);
                    return Err(error);
                }
            }
        }
        if let Some(mut next) = prepared_dsp {
            if !output_changed {
                if let Some(previous) = self.dsp.take() {
                    next.transition_from(previous);
                }
            }
            self.dsp = Some(next);
        }
        Ok(())
    }

    fn select_device(&mut self, device_id: Option<String>) -> Result<(), String> {
        let mut settings = self.audio_settings.clone();
        settings.discover(&O::list_devices()?);
        settings.selected_output_id = device_id.unwrap_or_default();
        self.apply_audio_settings(settings)
    }

    fn set_exclusive_mode(&mut self, enabled: bool) -> Result<(), String> {
        let mut settings = self.audio_settings.clone();
        let selected = settings.selected_output_id.clone();
        if let Some(output) = settings.outputs.iter_mut().find(|o| o.id == selected) {
            output.exclusive_mode = enabled;
        }
        self.apply_audio_settings(settings)
    }

    // A new device stream needs time to lock. Reusing an already-open output
    // (including gapless, same-format track advance) never calls this helper.
    fn open_output(&mut self, spec: StreamSpec) -> Result<(), String> {
        self.output = Some(O::open_device_with_mode(
            spec,
            self.selected_device_id.as_deref(),
            self.exclusive_mode,
        )?);
        self.resync = ResyncDelay::new(self.audio_settings.selected().resync_delay_ms, spec);
        self.rendering = false;
        Ok(())
    }

    fn load(
        &mut self,
        source: String,
        next_source: Option<String>,
        position_seconds: f64,
        autoplay: bool,
    ) -> Result<(), String> {
        let preparation_deadline = Instant::now() + AUDIO_PREPARE_TIMEOUT;
        let previous_spec = self.spec;
        let was_resyncing = self.resync.is_active();
        let mut previous_output = self.output.take();
        if let Some(output) = previous_output.as_mut() {
            output.reset()?;
        }
        self.resync = ResyncDelay::default();
        let prepared_next = if position_seconds == 0.0 {
            self.ready_next
                .take()
                .filter(|(ready_source, _)| ready_source == &source)
                .map(|(_, prepared)| prepared)
        } else {
            None
        };
        let queued_next = if prepared_next.is_none() && position_seconds == 0.0 {
            self.next_source
                .take()
                .filter(|queued| queued.source == source)
        } else {
            None
        };
        self.decoder = None;
        self.pcm.clear();
        self.reset_gain_buffer();
        self.desired_playing = autoplay;
        self.decoder_ended = false;
        self.next_source = None;
        self.ready_next = None;
        self.position_base = position_seconds;
        self.rendered_frames = 0;
        self.current_source = Some(source.clone());
        self.rendering = false;
        self.set_buffering(Some(source.clone()), position_seconds, 0.0);

        // Reuse an in-flight hover preparation as well as completed queue audio.
        let warmed = if prepared_next.is_none()
            && queued_next.is_none()
            && position_seconds == 0.0
            && self
                .warm_source
                .as_ref()
                .is_some_and(|warm| warm.source == source)
        {
            self.warm_source.take()
        } else {
            None
        };
        // Drop unrelated hover work when a user selects another song.
        self.warm_source = None;
        let reused = queued_next
            .or(warmed)
            .map(|queued| {
                queued
                    .into_foreground(preparation_deadline.saturating_duration_since(Instant::now()))
            })
            .transpose()?
            .flatten();
        let prepared = match prepared_next.or(reused) {
            Some(prepared) => prepared,
            None => prepare_source_at_with_timeout(
                source.clone(),
                position_seconds,
                preparation_deadline.saturating_duration_since(Instant::now()),
            )?,
        };
        let spec = prepared.decoder.spec();
        let duration = prepared.decoder.duration_seconds();
        let audio_quality = self.install_prepared(prepared)?;
        // Prioritize the selected song's initial download over preloading the next.
        self.next_source = next_source.map(QueuedSource::prepare).transpose()?;
        if autoplay && previous_spec == Some(spec) {
            self.output = previous_output.take();
            if self.output.is_some() && was_resyncing {
                self.resync =
                    ResyncDelay::new(self.audio_settings.selected().resync_delay_ms, spec);
            }
        }
        // Release incompatible output formats before opening the replacement.
        drop(previous_output);
        if autoplay && self.output.is_none() {
            self.open_output(spec)?;
        }

        update_status(&self.status, |status| {
            status.current_source = Some(source);
            status.current_time = position_seconds;
            status.audio_quality = Some(audio_quality);
            status.duration = duration;
            status.is_playing = false;
            status.buffering = autoplay;
            status.ended = false;
            status.error = None;
        });
        Ok(())
    }

    fn queue(
        &mut self,
        source: Option<String>,
        expected_source: Option<String>,
    ) -> Result<(), String> {
        // A delayed preload must not requeue audio after the worker has advanced.
        if expected_source
            .as_ref()
            .is_some_and(|expected| self.current_source.as_ref() != Some(expected))
        {
            return Ok(());
        }
        let Some(source) = source else {
            self.next_source = None;
            self.ready_next = None;
            return Ok(());
        };
        let is_already_queued = self
            .next_source
            .as_ref()
            .is_some_and(|queued| queued.source == source)
            || self
                .ready_next
                .as_ref()
                .is_some_and(|(queued, _)| queued == &source);
        if !is_already_queued {
            self.next_source = Some(QueuedSource::prepare(source)?);
            self.ready_next = None;
        }
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
            let audio_quality = self.install_prepared(prepared)?;
            update_status(&self.status, |status| {
                status.audio_quality = Some(audio_quality);
            });
        }
        if self.output.is_none() {
            let spec = self
                .spec
                .ok_or_else(|| "No native audio track is loaded".to_owned())?;
            self.open_output(spec)?;
        }
        self.desired_playing = true;
        update_status(&self.status, |status| {
            status.buffering = !status.is_playing;
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
        if self.resync.is_active() {
            // Seeking during startup discards queued silence; restart that
            // pending lock-in period. Ordinary seeks do not add any delay.
            self.resync = ResyncDelay::new(self.audio_settings.selected().resync_delay_ms, spec);
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
        self.reset_gain_buffer();
        let prepared = prepare_source_at(source, position_seconds)?;
        let audio_quality = self.install_prepared(prepared)?;
        if self.desired_playing && self.output.is_none() {
            self.open_output(spec)?;
        }
        update_status(&self.status, |status| {
            status.current_time = position_seconds;
            status.audio_quality = Some(audio_quality);
            status.is_playing = false;
            status.buffering = self.desired_playing;
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

        if self.resync.is_active() {
            let output = self
                .output
                .as_mut()
                .ok_or_else(|| "The native audio output is unavailable".to_owned())?;
            output.set_gain(self.gain.amplitude())?;
            if !self.rendering {
                output.start()?;
                self.rendering = true;
            }
            if self.resync.pump(output)? {
                update_status(&self.status, |status| {
                    status.is_playing = false;
                    status.buffering = true;
                });
                // The song buffer, playhead and DSP are untouched; the worker
                // can still handle pause/skip commands between silence writes.
                thread::sleep(Duration::from_millis(1));
                return Ok(());
            }
        }

        if self.rendering && self.pcm.is_empty() && !self.decoder_ended {
            let output = self
                .output
                .as_mut()
                .ok_or_else(|| "The native audio output is unavailable".to_owned())?;
            let queued_frames = output.queued_frames()? as u64;
            if queued_frames > 0 {
                let audible_frames = self.rendered_frames.saturating_sub(queued_frames);
                let current_time =
                    self.position_base + audible_frames as f64 / f64::from(spec.sample_rate);
                update_status(&self.status, |status| status.current_time = current_time);
                thread::sleep(Duration::from_millis(1));
                return Ok(());
            }

            output.pause()?;
            self.rendering = false;
            update_status(&self.status, |status| {
                status.is_playing = false;
                status.buffering = true;
            });
            return Ok(());
        }

        if self.pcm.is_empty() && self.decoder_ended {
            self.poll_next_source();
            if let Some(queued) = self.next_source.as_ref() {
                // The next song is no longer speculative. It needs the startup
                // buffer now, not six seconds of background preloading.
                queued.foreground.store(true, Ordering::Release);
                self.end_preload_started_at.get_or_insert_with(Instant::now);
            }
            if let Some((_, prepared)) = self.ready_next.as_ref()
                && self.spec == Some(prepared.decoder.spec())
            {
                let (source, prepared) = self.ready_next.take().expect("ready source disappeared");
                return self.advance(source, prepared);
            }

            if self.tail_frames_remaining > 0 {
                let frames = self.tail_frames_remaining.min(dsp::BLOCK_FRAMES);
                self.pcm.resize(frames * spec.channels, 0.0);
                self.tail_frames_remaining -= frames;
                self.draining_dsp_tail = true;
                return Ok(());
            }
            if let Some(output) = self.output.as_mut() {
                // Resume an existing paused buffer so its final frames can
                // drain. Do not repeatedly start an empty stream while waiting
                // for a network preload.
                if !self.rendering && output.queued_frames()? > 0 {
                    output.start()?;
                    self.rendering = true;
                }
                if !output.is_drained()? {
                    let now = Instant::now();
                    let deadline = match self.output_drain_deadline {
                        Some(deadline) => deadline,
                        None => {
                            let queued = output.queued_frames()?;
                            let queued_time = Duration::from_secs_f64(
                                queued as f64 / f64::from(spec.sample_rate),
                            );
                            let deadline =
                                now + queued_time.min(MAX_OUTPUT_DRAIN_WAIT) + OUTPUT_DRAIN_GRACE;
                            self.output_drain_deadline = Some(deadline);
                            deadline
                        }
                    };
                    if now < deadline {
                        thread::sleep(Duration::from_millis(1));
                        return Ok(());
                    }
                    // A driver that never reports an empty buffer must not trap the
                    // queue at EOF. Release the stuck stream and open a fresh one.
                    output.reset()?;
                    self.output = None;
                    self.rendering = false;
                }
            }
            self.output_drain_deadline = None;
            if let Some((source, prepared)) = self.ready_next.take() {
                return self.advance(source, prepared);
            }
            if self.next_source.is_some()
                && self
                    .end_preload_started_at
                    .is_some_and(|started| started.elapsed() < END_PRELOAD_TIMEOUT)
            {
                if let Some(output) = self.output.as_mut() {
                    output.pause()?;
                }
                self.rendering = false;
                update_status(&self.status, |status| {
                    status.is_playing = false;
                    status.buffering = true;
                });
                thread::sleep(Duration::from_millis(1));
                return Ok(());
            }
            // Cancel a stalled speculative load and publish a normal ended
            // event. The queue can retry the next track through foreground load.
            self.next_source = None;
            self.end_preload_started_at = None;
            if let Some(output) = self.output.as_mut() {
                output.pause()?;
            }
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
        output.set_gain(self.gain.amplitude())?;
        if !self.rendering {
            output.start()?;
            self.rendering = true;
        }
        update_status(&self.status, |status| {
            status.is_playing = true;
            status.buffering = false;
        });

        if !self.pcm.is_empty() {
            let using_gain_buffer = self.dsp.as_ref().is_some_and(DspEngine::active)
                || (!cfg!(target_os = "macos") && !self.gain.is_unity())
                || self.gain_buffer_offset < self.gain_buffer.len();
            let frames = if !using_gain_buffer {
                let (first, second) = self.pcm.as_slices();
                output.write(first, second)?
            } else {
                if self.gain_buffer_offset >= self.gain_buffer.len() {
                    self.gain_buffer_offset = 0;
                    let sample_limit = self
                        .pcm
                        .len()
                        .min(GAIN_BLOCK_FRAMES.saturating_mul(spec.channels));
                    self.gain_buffer.clear();
                    self.gain_buffer
                        .extend(self.pcm.iter().take(sample_limit).copied());
                    if let Some(dsp) = self.dsp.as_mut() {
                        dsp.process(&mut self.gain_buffer)?;
                        if !self.draining_dsp_tail {
                            self.tail_frames_remaining = dsp.tail_frames();
                        }
                    }
                    if !cfg!(target_os = "macos") {
                        self.gain
                            .process_in_place(&mut self.gain_buffer, spec.channels);
                    }
                }
                output.write(&self.gain_buffer[self.gain_buffer_offset..], &[])?
            };
            if frames > 0 {
                let consumed_samples = frames * spec.channels;
                self.pcm.drain(..consumed_samples);
                if using_gain_buffer {
                    self.gain_buffer_offset += consumed_samples;
                    if self.gain_buffer_offset >= self.gain_buffer.len() {
                        self.gain_buffer.clear();
                        self.gain_buffer_offset = 0;
                        self.draining_dsp_tail = false;
                    }
                }
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

    fn poll_next_source(&mut self) {
        let Some(queued) = self.next_source.as_ref() else {
            return;
        };
        match queued.receiver.try_recv() {
            Ok(Ok(prepared)) => {
                let queued = self.next_source.take().expect("queued source disappeared");
                self.ready_next = Some((queued.source.clone(), prepared));
            }
            Ok(Err(error)) => {
                self.next_source = None;
                // Let normal queue advancement retry this track in the foreground.
                // Speculative failure must not turn the current song into an error.
                eprintln!("Could not preload the next track: {error}");
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                self.next_source = None;
                eprintln!("The native audio preloader stopped unexpectedly");
            }
        }
    }

    fn advance(&mut self, source: String, prepared: PreparedSource) -> Result<(), String> {
        let next_spec = prepared.decoder.spec();
        let duration = prepared.decoder.duration_seconds();
        let format_changed = self.spec != Some(next_spec);
        if format_changed || self.output.is_none() {
            if let Some(output) = self.output.as_mut() {
                output.reset()?;
            }
            // Release the previous exclusive handle before opening a new format.
            self.output = None;
            self.open_output(next_spec)?;
        }

        let audio_quality = self.install_prepared(prepared)?;
        self.current_source = Some(source.clone());
        self.position_base = 0.0;
        self.rendered_frames = 0;
        let event_source = source.clone();
        // A gapless handoff leaves the device running. Publishing a paused
        // snapshot here makes the new track appear stopped even though audio
        // is still queued. A reopened stream is buffering, not user-paused,
        // even when its configured resync delay is zero.
        let is_playing = self.desired_playing && self.rendering && !self.resync.is_active();
        update_status(&self.status, |status| {
            status.current_source = Some(source);
            status.current_time = 0.0;
            status.audio_quality = Some(audio_quality);
            status.duration = duration;
            status.is_playing = is_playing;
            status.buffering = self.desired_playing && !is_playing;
            status.ended = false;
            status.error = None;
        });
        if let Some(app) = self.event_app.as_ref() {
            let _ = app.emit(SOURCE_CHANGED_EVENT, event_source);
        }
        Ok(())
    }

    fn install_prepared(&mut self, prepared: PreparedSource) -> Result<AudioQuality, String> {
        let PreparedSource {
            decoder,
            mut pcm,
            decoder_ended,
            max_buffer_samples,
        } = prepared;
        let spec = decoder.spec();
        let audio_quality = decoder.audio_quality();
        pcm.reserve(max_buffer_samples.saturating_sub(pcm.len()));
        let stream = (!decoder_ended)
            .then(|| DecoderStream::start(decoder))
            .transpose()?;
        if self.spec != Some(spec) || self.dsp.is_none() {
            self.dsp = Some(DspEngine::build(
                self.audio_settings.preset(),
                spec.sample_rate,
                spec.channels,
                &self.audio_directory()?,
            )?);
        }
        self.pcm = pcm;
        self.decoder = stream;
        self.spec = Some(spec);
        self.decoder_ended = decoder_ended;
        self.end_preload_started_at = None;
        self.output_drain_deadline = None;
        Ok(audio_quality)
    }

    fn set_buffering(&self, source: Option<String>, current_time: f64, duration: f64) {
        update_status(&self.status, |status| {
            if status.current_source != source {
                status.audio_quality = None;
            }
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
        self.reset_gain_buffer();
        self.position_base = position_seconds;
        self.rendered_frames = 0;
        let source = self
            .current_source
            .clone()
            .ok_or_else(|| "No native audio track is loaded".to_owned())?;
        let prepared = prepare_source_at(source, position_seconds)?;
        let audio_quality = self.install_prepared(prepared)?;
        update_status(&self.status, |status| {
            status.current_time = position_seconds;
            status.audio_quality = Some(audio_quality);
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
        self.reset_gain_buffer();
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
        if self.resync.is_active() {
            if let Some(spec) = self.spec {
                self.resync =
                    ResyncDelay::new(self.audio_settings.selected().resync_delay_ms, spec);
            }
        }
        self.rendering = false;
        self.decoder = None;
        self.pcm.clear();
        self.reset_gain_buffer();
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
                    let audio_quality = self.install_prepared(prepared)?;
                    if self.output.is_none() {
                        self.open_output(spec)?;
                    }
                    self.position_base = position_seconds;
                    self.rendered_frames = 0;
                    update_status(&self.status, |status| {
                        status.current_time = position_seconds;
                        status.audio_quality = Some(audio_quality);
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

    fn reset_gain_buffer(&mut self) {
        self.end_preload_started_at = None;
        self.output_drain_deadline = None;
        self.gain_buffer.clear();
        self.gain_buffer_offset = 0;
        self.gain.settle();
        self.tail_frames_remaining = 0;
        self.draining_dsp_tail = false;
        if let Some(dsp) = self.dsp.as_mut() {
            dsp.reset();
        }
    }
}

#[cfg(test)]
fn prepare_source(source: String, preload: bool) -> Result<PreparedSource, String> {
    prepare_source_with_buffer(source, 0.0, preload)
}

fn prepare_source_at(source: String, position_seconds: f64) -> Result<PreparedSource, String> {
    prepare_source_at_with_timeout(source, position_seconds, AUDIO_PREPARE_TIMEOUT)
}

fn prepare_source_at_with_timeout(
    source: String,
    position_seconds: f64,
    timeout: Duration,
) -> Result<PreparedSource, String> {
    // Keep slow decoding/network reads off the playback worker and bound the
    // complete preparation, not just each individual HTTP retry.
    QueuedSource::prepare_at(source, position_seconds, false)?.wait_for_preparation(timeout)
}

#[cfg(test)]
fn prepare_source_with_buffer(
    source: String,
    position_seconds: f64,
    preload: bool,
) -> Result<PreparedSource, String> {
    prepare_source_with_control(source, position_seconds, preload, None, None)
}

fn prepare_source_with_control(
    source: String,
    position_seconds: f64,
    preload: bool,
    foreground: Option<&AtomicBool>,
    cancelled: Option<&AtomicBool>,
) -> Result<PreparedSource, String> {
    let is_cancelled = || cancelled.is_some_and(|flag| flag.load(Ordering::Acquire));
    if is_cancelled() {
        return Err("Audio preparation cancelled".to_owned());
    }
    let network_source = is_network_source(&source);
    let mut decoder = DecodedSource::open_at(source, position_seconds)?;
    let spec = decoder.spec();
    let max_buffer_samples = max_buffer_samples(spec, network_source);
    let mut pcm = VecDeque::with_capacity(max_buffer_samples);
    let mut decoder_ended = false;
    while !decoder_ended {
        if is_cancelled() {
            return Err("Audio preparation cancelled".to_owned());
        }
        let speculative = preload && !foreground.is_some_and(|flag| flag.load(Ordering::Acquire));
        if pcm.len() >= prebuffer_samples_for_kind(spec, network_source, speculative) {
            break;
        }
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

    fn prepared_test_audio(name: &str) -> (String, super::PreparedSource) {
        prepared_test_audio_at_rate(name, 44100)
    }

    fn prepared_test_audio_at_rate(name: &str, rate: u32) -> (String, super::PreparedSource) {
        use super::*;
        let path = std::env::temp_dir().join(format!("ambra-{name}-{}.wav", std::process::id()));
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&40u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&4u32.to_le_bytes());
        wav.extend_from_slice(&[0; 4]);
        std::fs::write(&path, wav).unwrap();
        let source = path.to_string_lossy().into_owned();
        let prepared = prepare_source(source.clone(), false).unwrap();
        std::fs::remove_file(path).unwrap();
        (source, prepared)
    }

    #[derive(Default)]
    struct TestOutputState {
        samples: Vec<f64>,
        started: bool,
        stale_padding: usize,
    }
    struct TestOutput {
        channels: usize,
        state: std::sync::Arc<std::sync::Mutex<TestOutputState>>,
    }
    impl super::output::AudioOutput for TestOutput {
        fn list_devices() -> Result<Vec<super::NativeAudioDevice>, String> {
            Ok(vec![])
        }
        fn open(spec: StreamSpec) -> Result<Self, String> {
            Ok(Self {
                channels: spec.channels,
                state: Default::default(),
            })
        }
        fn open_device_with_mode(
            spec: StreamSpec,
            _device: Option<&str>,
            _exclusive: bool,
        ) -> Result<Self, String> {
            Self::open(spec)
        }
        fn start(&mut self) -> Result<(), String> {
            self.state.lock().unwrap().started = true;
            Ok(())
        }
        fn pause(&mut self) -> Result<(), String> {
            self.state.lock().unwrap().started = false;
            Ok(())
        }
        fn reset(&mut self) -> Result<(), String> {
            self.pause()?;
            self.state.lock().unwrap().stale_padding = 0;
            Ok(())
        }
        fn write(&mut self, first: &[f64], second: &[f64]) -> Result<usize, String> {
            let mut state = self.state.lock().unwrap();
            if !state.started {
                return Ok(0);
            }
            let frames = 7.min((first.len() + second.len()) / self.channels);
            state
                .samples
                .extend(first.iter().chain(second).take(frames * self.channels));
            Ok(frames)
        }
        fn queued_frames(&mut self) -> Result<usize, String> {
            Ok(self.state.lock().unwrap().stale_padding)
        }
        fn is_drained(&mut self) -> Result<bool, String> {
            Ok(self.queued_frames()? == 0)
        }
    }

    fn test_worker(name: &str) -> super::PlaybackEngine<TestOutput> {
        use super::*;
        let (source, mut prepared) = prepared_test_audio(name);
        prepared.pcm = VecDeque::from([0.25, -0.25]);
        let spec = prepared.decoder.spec();
        let (_tx, rx) = unbounded();
        let mut worker = PlaybackEngine::<TestOutput>::new(
            rx,
            Arc::new(Mutex::new(PlaybackStatus::default())),
            None,
        );
        worker.current_source = Some(source);
        worker.install_prepared(prepared).unwrap();
        worker.open_output(spec).unwrap();
        worker.desired_playing = true;
        worker
    }

    #[test]
    fn convolution_tail_finishes_after_short_device_writes() {
        use super::*;
        let mut worker = test_worker("tail-short-writes");
        let directory =
            std::env::temp_dir().join(format!("ambra-tail-short-writes-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("dsp-impulses")).unwrap();
        let path = dsp::impulse_path(&directory, "tail").unwrap();
        let mut writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 44100,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .unwrap();
        for index in 0..2049 {
            writer
                .write_sample(if index == 0 { 1.0_f32 } else { 0.0 })
                .unwrap();
        }
        writer.finalize().unwrap();
        let preset = dsp::DspPreset {
            id: "tail".into(),
            name: "Tail".into(),
            enabled: true,
            headroom_db: 0.0,
            output_gain_db: 0.0,
            bands: vec![],
            convolution: vec![dsp::ImpulseFile {
                id: "tail".into(),
                name: "tail.wav".into(),
                sample_rate: 44100,
                channels: 1,
                frames: 2049,
            }],
        };
        worker.dsp = Some(DspEngine::build(Some(&preset), 44100, 2, &directory).unwrap());
        let log = worker.output.as_ref().unwrap().state.clone();
        for _ in 0..1000 {
            if lock_status(&worker.status).ended {
                break;
            }
            worker.pump().unwrap();
        }
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory.join("dsp-impulses")).unwrap();
        std::fs::remove_dir(directory).unwrap();
        assert!(
            lock_status(&worker.status).ended,
            "convolution tail never ended"
        );
        assert_eq!(log.lock().unwrap().samples.len(), (1 + 2048) * 2);
    }

    #[test]
    fn queued_song_is_promoted_to_foreground_when_current_song_ends() {
        use super::*;
        let mut worker = test_worker("end-preload");
        let (_sender, receiver) = bounded(1);
        let foreground = Arc::new(AtomicBool::new(false));
        worker.next_source = Some(QueuedSource {
            source: "next.flac".into(),
            receiver,
            foreground: foreground.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        worker.pump().unwrap();
        worker.pump().unwrap();
        assert!(foreground.load(Ordering::Acquire));
    }

    #[test]
    fn stalled_preload_publishes_end_instead_of_buffering_forever() {
        use super::*;
        let mut worker = test_worker("stalled-preload");
        let (_sender, receiver) = bounded(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        worker.next_source = Some(QueuedSource {
            source: "next.flac".into(),
            receiver,
            foreground: Arc::new(AtomicBool::new(false)),
            cancelled: cancelled.clone(),
        });
        worker.pump().unwrap();
        worker.pump().unwrap();
        assert!(lock_status(&worker.status).buffering);
        worker.end_preload_started_at =
            Some(Instant::now() - END_PRELOAD_TIMEOUT - Duration::from_millis(1));
        worker.pump().unwrap();
        assert!(lock_status(&worker.status).ended);
        assert!(!lock_status(&worker.status).buffering);
        assert!(cancelled.load(Ordering::Acquire));
        assert!(worker.output.is_none());
        assert!(!worker.desired_playing);
    }

    #[test]
    fn full_playback_loop_keeps_same_format_gapless_and_finishes_last_song() {
        use super::*;
        let mut worker = test_worker("gapless-loop");
        worker.audio_settings.outputs[0].resync_delay_ms = 1000;
        let (source, mut next) = prepared_test_audio("gapless-loop-next");
        next.pcm = VecDeque::from([0.5, -0.5]);
        let log = worker.output.as_ref().unwrap().state.clone();
        worker.ready_next = Some((source.clone(), next));
        worker.pump().unwrap();
        worker.pump().unwrap();
        assert_eq!(worker.current_source.as_deref(), Some(source.as_str()));
        assert!(!worker.resync.is_active());
        assert!(lock_status(&worker.status).is_playing);
        assert!(!lock_status(&worker.status).buffering);
        assert!(Arc::ptr_eq(&log, &worker.output.as_ref().unwrap().state));
        worker.pump().unwrap();
        worker.pump().unwrap();
        assert!(lock_status(&worker.status).ended);
        assert_eq!(log.lock().unwrap().samples, [0.25, -0.25, 0.5, -0.5]);
    }

    #[test]
    fn format_change_queues_only_the_configured_silence_then_song_and_end() {
        use super::*;
        let mut worker = test_worker("format-loop");
        worker.audio_settings.outputs[0].resync_delay_ms = 1;
        let (source, mut next) = prepared_test_audio_at_rate("format-loop-next", 48000);
        next.pcm = VecDeque::from([0.5, -0.5]);
        worker.ready_next = Some((source.clone(), next));
        worker.pump().unwrap();
        worker.pump().unwrap();
        assert_eq!(worker.current_source.as_deref(), Some(source.as_str()));
        assert!(worker.resync.is_active());
        let log = worker.output.as_ref().unwrap().state.clone();
        for _ in 0..20 {
            if lock_status(&worker.status).ended {
                break;
            }
            worker.pump().unwrap();
        }
        assert!(lock_status(&worker.status).ended);
        let state = log.lock().unwrap();
        assert_eq!(state.samples.len(), 48 * 2 + 2);
        assert!(state.samples[..96].iter().all(|sample| *sample == 0.0));
        assert_eq!(&state.samples[96..], [0.5, -0.5]);
    }

    #[test]
    fn zero_delay_format_change_reports_buffering_not_paused_until_audio_starts() {
        use super::*;
        let mut worker = test_worker("zero-delay-status");
        let (source, next) = prepared_test_audio_at_rate("zero-delay-status-next", 48000);
        worker.ready_next = Some((source.clone(), next));
        worker.pump().unwrap();
        worker.pump().unwrap();
        assert_eq!(worker.current_source.as_deref(), Some(source.as_str()));
        assert!(!worker.resync.is_active());
        assert!(!lock_status(&worker.status).is_playing);
        assert!(lock_status(&worker.status).buffering);
        assert!(worker.desired_playing);
        worker.pump().unwrap();
        assert!(lock_status(&worker.status).is_playing);
        assert!(!lock_status(&worker.status).buffering);
    }

    #[test]
    fn stale_device_padding_cannot_trap_end_of_queue() {
        use super::*;
        let mut worker = test_worker("stale-padding-last");
        worker
            .output
            .as_ref()
            .unwrap()
            .state
            .lock()
            .unwrap()
            .stale_padding = 64;
        worker.pump().unwrap();
        worker.pump().unwrap();
        assert!(!lock_status(&worker.status).ended);
        assert!(worker.output_drain_deadline.is_some());
        worker.output_drain_deadline = Some(Instant::now() - Duration::from_millis(1));
        worker.pump().unwrap();
        assert!(lock_status(&worker.status).ended);
        assert!(worker.output.is_none());
    }

    #[test]
    fn format_switch_recovers_when_previous_device_never_reports_drained() {
        use super::*;
        let mut worker = test_worker("stale-padding-switch");
        worker
            .output
            .as_ref()
            .unwrap()
            .state
            .lock()
            .unwrap()
            .stale_padding = 64;
        let (source, next) = prepared_test_audio_at_rate("stale-padding-switch-next", 48000);
        worker.ready_next = Some((source.clone(), next));
        worker.pump().unwrap();
        worker.pump().unwrap();
        worker.output_drain_deadline = Some(Instant::now() - Duration::from_millis(1));
        worker.pump().unwrap();
        assert_eq!(worker.current_source.as_deref(), Some(source.as_str()));
        assert!(worker.output.is_some());
        assert!(worker.output_drain_deadline.is_none());
    }

    #[test]
    fn assigned_preset_updates_live_dsp_and_failed_configuration_keeps_previous() {
        use super::*;
        let (_tx, rx) = unbounded();
        let mut worker =
            PlaybackWorker::new(rx, Arc::new(Mutex::new(PlaybackStatus::default())), None);
        worker.spec = Some(StreamSpec {
            sample_rate: 48000,
            channels: 2,
            bits_per_sample: 24,
        });
        let preset = dsp::DspPreset {
            id: "headphones".into(),
            name: "Headphones".into(),
            enabled: true,
            headroom_db: 6.0,
            output_gain_db: 0.0,
            bands: vec![],
            convolution: vec![],
        };
        let mut settings = AudioSettings::default();
        settings.outputs[0].preset_id = Some(preset.id.clone());
        settings.presets.push(preset);
        worker.apply_audio_settings(settings.clone()).unwrap();
        let mut input = [1.0, -1.0];
        worker.dsp.as_mut().unwrap().process(&mut input).unwrap();
        assert!((input[0] - 10.0_f64.powf(-6.0 / 20.0)).abs() < 1e-12);
        assert_eq!(input[0], -input[1]);
        let mut invalid = settings.clone();
        invalid.presets[0].convolution.push(dsp::ImpulseFile {
            id: "missing".into(),
            name: "missing.wav".into(),
            sample_rate: 44100,
            channels: 1,
            frames: 10,
        });
        assert!(worker.apply_audio_settings(invalid).is_err());
        assert_eq!(worker.audio_settings, settings);
        assert!(worker.dsp.as_ref().unwrap().active());
        settings.outputs[0].preset_id = None;
        worker.apply_audio_settings(settings).unwrap();
        let mut fade = vec![0.25; 1024];
        worker.dsp.as_mut().unwrap().process(&mut fade).unwrap();
        assert_eq!(fade.last(), Some(&0.25));
        assert!(!worker.dsp.as_ref().unwrap().active());
    }

    #[test]
    fn stale_preload_cannot_requeue_the_track_after_native_advance() {
        use super::*;
        let (_tx, rx) = unbounded();
        let mut worker =
            PlaybackWorker::new(rx, Arc::new(Mutex::new(PlaybackStatus::default())), None);
        worker.current_source = Some("last.flac".into());
        worker
            .queue(Some("last.flac".into()), Some("previous.flac".into()))
            .unwrap();
        assert!(worker.next_source.is_none());
        assert!(worker.ready_next.is_none());
    }

    #[test]
    fn empty_queue_clears_pending_and_prepared_audio() {
        use super::*;
        let (_tx, rx) = unbounded();
        let mut worker =
            PlaybackWorker::new(rx, Arc::new(Mutex::new(PlaybackStatus::default())), None);
        let (_sender, receiver) = bounded(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        worker.current_source = Some("current.flac".into());
        worker.next_source = Some(QueuedSource {
            source: "removed.flac".into(),
            receiver,
            foreground: Arc::new(AtomicBool::new(false)),
            cancelled: cancelled.clone(),
        });
        worker.ready_next = Some(prepared_test_audio("clear-queue"));
        worker.queue(None, Some("current.flac".into())).unwrap();
        assert!(worker.next_source.is_none());
        assert!(worker.ready_next.is_none());
        assert!(cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn stale_clear_cannot_discard_the_new_tracks_preparation() {
        use super::*;
        let (_tx, rx) = unbounded();
        let mut worker =
            PlaybackWorker::new(rx, Arc::new(Mutex::new(PlaybackStatus::default())), None);
        worker.current_source = Some("new-current.flac".into());
        worker.ready_next = Some(prepared_test_audio("stale-clear"));
        worker.queue(None, Some("old-current.flac".into())).unwrap();
        assert!(worker.ready_next.is_some());
    }

    #[test]
    fn deliberate_repeated_queue_entries_are_still_supported() {
        use super::*;
        let (_tx, rx) = unbounded();
        let mut worker =
            PlaybackWorker::new(rx, Arc::new(Mutex::new(PlaybackStatus::default())), None);
        let (source, prepared) = prepared_test_audio("deliberate-repeat");
        worker.current_source = Some(source.clone());
        worker.ready_next = Some((source.clone(), prepared));
        worker.queue(Some(source.clone()), Some(source)).unwrap();
        assert!(worker.ready_next.is_some());
    }

    #[test]
    fn speculative_failure_does_not_fail_current_playback() {
        use super::*;
        let (_tx, rx) = unbounded();
        let mut worker =
            PlaybackWorker::new(rx, Arc::new(Mutex::new(PlaybackStatus::default())), None);
        let (sender, receiver) = bounded(1);
        sender
            .send(Err("temporary network outage".to_owned()))
            .unwrap();
        worker.next_source = Some(QueuedSource {
            source: "https://example.test/next.flac".to_owned(),
            receiver,
            foreground: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        worker.poll_next_source();
        assert!(worker.next_source.is_none());
        assert!(worker.status.lock().unwrap().error.is_none());
    }

    #[test]
    fn discarded_preparation_is_cancelled_before_opening_source() {
        use super::*;
        let cancelled = AtomicBool::new(true);
        let error =
            prepare_source_with_control("missing.flac".into(), 0.0, true, None, Some(&cancelled))
                .err()
                .unwrap();
        assert_eq!(error, "Audio preparation cancelled");
    }

    #[test]
    fn stalled_foreground_preparation_is_bounded_and_cancelled() {
        use super::*;
        let (_sender, receiver) = bounded(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        let queued = QueuedSource {
            source: "stalled.flac".into(),
            receiver,
            foreground: Arc::new(AtomicBool::new(false)),
            cancelled: cancelled.clone(),
        };
        let error = queued
            .wait_for_preparation(Duration::from_millis(1))
            .err()
            .unwrap();
        assert!(error.contains("Audio loading timed out"));
        assert!(queued.foreground.load(Ordering::Acquire));
        assert!(cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn foreground_preparation_preserves_service_errors_without_waiting() {
        use super::*;
        let (sender, receiver) = bounded(1);
        sender
            .send(Err(
                "Tidal is not connected. Sign in from the Library services menu.".into(),
            ))
            .unwrap();
        let queued = QueuedSource {
            source: "unavailable.flac".into(),
            receiver,
            foreground: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let error = queued.wait_for_preparation(Duration::ZERO).err().unwrap();
        assert!(error.contains("Tidal is not connected"));
    }

    #[test]
    fn selecting_prepared_audio_does_not_reopen_its_source() {
        use super::*;
        let path = std::env::temp_dir().join(format!("ambra-prepared-{}.wav", std::process::id()));
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&40u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&44100u32.to_le_bytes());
        wav.extend_from_slice(&176400u32.to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&4u32.to_le_bytes());
        wav.extend_from_slice(&[0; 4]);
        let source = path.to_string_lossy().into_owned();
        for mode in 0..3 {
            std::fs::write(&path, &wav).unwrap();
            let prepared = prepare_source(source.clone(), false).unwrap();
            std::fs::remove_file(&path).unwrap();
            let (_tx, rx) = unbounded();
            let mut worker =
                PlaybackWorker::new(rx, Arc::new(Mutex::new(PlaybackStatus::default())), None);
            if mode > 0 {
                let (sender, receiver) = bounded(1);
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(25));
                    sender.send(Ok(prepared)).unwrap();
                });
                let queued = Some(QueuedSource {
                    source: source.clone(),
                    receiver,
                    foreground: Arc::new(AtomicBool::new(false)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                });
                if mode == 1 {
                    worker.warm_source = queued;
                } else {
                    worker.next_source = queued;
                }
            } else {
                worker.ready_next = Some((source.clone(), prepared));
            }
            worker.load(source.clone(), None, 0.0, false).unwrap();
            assert_eq!(worker.pcm.len(), 2);
            let status = lock_status(&worker.status);
            assert_eq!(status.current_source.as_deref(), Some(source.as_str()));
            let quality = status.audio_quality.as_ref().unwrap();
            assert_eq!(quality.sample_rate_hz, 44_100);
            assert_eq!(quality.bit_depth, Some(16));
            assert_eq!(quality.bitrate_kbps, Some(1411.2));
        }
    }

    #[test]
    fn failed_track_load_does_not_keep_previous_audio_quality() {
        use super::*;
        let (source, prepared) = prepared_test_audio("quality-switch");
        let (_tx, rx) = unbounded();
        let mut worker =
            PlaybackWorker::new(rx, Arc::new(Mutex::new(PlaybackStatus::default())), None);
        worker.ready_next = Some((source.clone(), prepared));
        worker.load(source, None, 0.0, false).unwrap();
        assert!(lock_status(&worker.status).audio_quality.is_some());
        let missing = std::env::temp_dir()
            .join(format!("ambra-missing-quality-{}.flac", std::process::id()))
            .to_string_lossy()
            .into_owned();
        assert!(worker.load(missing.clone(), None, 0.0, false).is_err());
        let status = lock_status(&worker.status);
        assert_eq!(status.current_source.as_deref(), Some(missing.as_str()));
        assert!(status.audio_quality.is_none());
    }

    #[test]
    fn rejects_non_finite_seek_positions() {
        assert!(valid_position(f64::NAN).is_err());
        assert!(valid_position(f64::INFINITY).is_err());
        assert_eq!(valid_position(-2.0).unwrap(), 0.0);
    }

    #[test]
    fn same_format_gapless_advance_never_arms_resync_or_consumes_song_samples() {
        use super::*;
        let (source, prepared) = prepared_test_audio("gapless-resync");
        let spec = prepared.decoder.spec();
        let samples = prepared.pcm.clone();
        let (_tx, rx) = unbounded();
        let mut worker = PlaybackEngine::<TestOutput>::new(
            rx,
            Arc::new(Mutex::new(PlaybackStatus::default())),
            None,
        );
        worker.audio_settings.outputs[0].resync_delay_ms = 2000;
        worker.spec = Some(spec);
        worker.output = Some(TestOutput::open(spec).unwrap());
        worker.output.as_mut().unwrap().start().unwrap();
        worker.rendering = true;
        worker.advance(source, prepared).unwrap();
        assert!(!worker.resync.is_active());
        assert!(worker.rendering);
        assert_eq!(worker.pcm, samples);
        assert_eq!(worker.rendered_frames, 0);
        assert!(!lock_status(&worker.status).buffering);
    }

    #[test]
    fn editing_resync_delay_does_not_interrupt_playback_or_replace_dsp() {
        use super::*;
        let (_tx, rx) = unbounded();
        let mut worker =
            PlaybackWorker::new(rx, Arc::new(Mutex::new(PlaybackStatus::default())), None);
        worker.rendering = true;
        worker.rendered_frames = 12345;
        let mut settings = worker.audio_settings.clone();
        settings.outputs[0].resync_delay_ms = 1250;
        worker.apply_audio_settings(settings).unwrap();
        assert!(worker.rendering);
        assert_eq!(worker.rendered_frames, 12345);
        assert!(!worker.resync.is_active());
        assert_eq!(worker.audio_settings.selected().resync_delay_ms, 1250);
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
            48_000
        );
        assert_eq!(max_buffer_samples(spec, true), 1_152_000);
    }
}
