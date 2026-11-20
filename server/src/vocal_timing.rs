//! Optional vocal separation. A small MDX-Net model isolates a recording's vocals, and their
//! energy per frame shows when singing starts and stops far more precisely than an estimate
//! from the mix. Lyric auto-sync (ambra-lyric-sync) and line-ending repair read that curve.
//!
//! The model runs in-process on tract, pure Rust, so it works wherever the server does. A song
//! is cut into overlapping chunks of spectra; the decoder streams them to a few workers that
//! each keep their own model state, so no core waits on a slower neighbour and nothing is
//! allocated per chunk. On a machine with little memory, fewer chunks are in flight and each is
//! split across cores instead (`Budget`). Chunks of digital silence skip the model. Its threads
//! run at the lowest priority and in efficiency mode, so analysis never crowds out playback or
//! spins up the fans.
//! Jobs, the cache of finished curves and the HTTP routes live in `api/vocal_timing.rs`.
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
};

use realfft::{RealFftPlanner, RealToComplex};
use sha2::{Digest, Sha256};
use symphonia::core::{
    codecs::audio::AudioDecoderOptions,
    errors::Error as SymphoniaError,
    formats::{FormatOptions, TrackType, probe::Hint},
    io::{MediaSource, MediaSourceStream},
    meta::MetadataOptions,
};
use tract_linalg::multithread::{Executor, multithread_tract_scope};
use tract_onnx::prelude::*;

/// UVR-MDX-NET 9482: the smallest of the public MDX-Net vocal models, about 30 MB.
pub const MODEL_URL: &str =
    "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_9482.onnx";
pub const MODEL_SHA256: &str = "f4f365207c56deb115bceedff3ad8fe98a751c745f9e370cecec6226b8b47184";
pub const MODEL_BYTES: u64 = 29_704_436;

const SAMPLE_RATE: u32 = 44_100;
const N_FFT: usize = 6144;
/// The model reads the lowest 2048 bins (up to about 14.7 kHz).
const BINS: usize = 2048;
/// Vocal energy is summed over where singing carries it.
const LOW_BIN: usize = 150 * N_FFT / SAMPLE_RATE as usize;
const HIGH_BIN: usize = 6_000 * N_FFT / SAMPLE_RATE as usize;
/// A chunk whose loudest sample is quieter than this (-80 dBFS) is silence, not singing.
const SILENCE_PEAK: f32 = 1e-4;

/// How the recording is cut up for the model. Its time axis is fully convolutional, so a
/// chunk may be any multiple of 32 frames long; frames at each end of a chunk, which the
/// model sees without context, are discarded.
#[derive(Clone, Copy, Debug)]
pub struct Shape {
    /// Samples between spectra (44.1 kHz).
    pub hop: usize,
    /// Spectra per chunk.
    pub frames: usize,
    /// Spectra discarded at each end of a chunk.
    pub margin: usize,
}

impl Shape {
    pub const DEFAULT: Shape = Shape { hop: 1024, frames: 256, margin: 16 };

    fn step(self) -> usize {
        self.frames - 2 * self.margin
    }

    /// The absolute sample range one chunk's spectra read.
    fn chunk_samples(self, chunk: usize) -> (isize, isize) {
        let first = (chunk * self.step()) as isize - self.margin as isize;
        let start = first * self.hop as isize - (N_FFT / 2) as isize;
        let end = (first + self.frames as isize - 1) * self.hop as isize + (N_FFT / 2) as isize;
        (start, end)
    }
}

/// How much of the machine one analysis may use.
#[derive(Clone, Copy, Debug)]
pub struct Budget {
    /// Threads in all.
    pub threads: usize,
    /// Chunks in flight at once, each holding the model's activations (about 250 MB at the
    /// default shape). With fewer chunks than threads, each chunk is split across threads.
    pub chunks: usize,
}

/// Bytes of memory installed, where the system says.
pub fn installed_memory() -> Option<u64> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        // SAFETY: fills a correctly sized, zeroed status struct.
        unsafe {
            let mut status: MEMORYSTATUSEX = std::mem::zeroed();
            status.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
            (GlobalMemoryStatusEx(&mut status) != 0).then_some(status.ullTotalPhys)
        }
    }
    #[cfg(target_vendor = "apple")]
    {
        let mut bytes: u64 = 0;
        let mut size = size_of::<u64>();
        // SAFETY: hw.memsize is a u64, written into a u64 of the size given.
        let result = unsafe {
            libc::sysctlbyname(c"hw.memsize".as_ptr(), (&raw mut bytes).cast(), &mut size, std::ptr::null_mut(), 0)
        };
        (result == 0).then_some(bytes)
    }
    #[cfg(not(any(windows, target_vendor = "apple")))]
    {
        let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kilobytes: u64 = meminfo.lines().find_map(|line| line.strip_prefix("MemTotal:"))?.trim().trim_end_matches("kB").trim().parse().ok()?;
        Some(kilobytes * 1024)
    }
}

pub struct Separator {
    plan: Arc<TypedSimplePlan>,
    shape: Shape,
}

impl Separator {
    pub fn load(path: &Path) -> Result<Self, String> {
        Self::load_shaped(path, Shape::DEFAULT)
    }

    pub fn load_shaped(path: &Path, shape: Shape) -> Result<Self, String> {
        let plan = tract_onnx::onnx()
            .model_for_path(path)
            .and_then(|model| model.with_input_fact(0, f32::fact([1, 4, BINS, shape.frames]).into()))
            .and_then(|model| model.into_optimized())
            .and_then(|model| model.into_runnable())
            .map_err(|error| format!("The vocal model could not be loaded: {error}"))?;
        Ok(Self { plan, shape })
    }
}

/// Separation is background work: its threads give way to playback, the app and everything
/// else on the machine, and ask to run where it costs the least power (efficiency cores, at
/// efficient clocks), so a song's analysis never spins up the fans. Only threads this module
/// spawns (and that end with their job) call it.
fn background_thread() {
    #[cfg(windows)]
    // SAFETY: changes only the calling thread's priority and power policy, from a local struct.
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadInformation, SetThreadPriority, THREAD_POWER_THROTTLING_CURRENT_VERSION,
            THREAD_POWER_THROTTLING_EXECUTION_SPEED, THREAD_POWER_THROTTLING_STATE, THREAD_PRIORITY_LOWEST,
            ThreadPowerThrottling,
        };
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST);
        #[cfg(test)]
        if std::env::var("AMBRA_VOCAL_NO_ECO").is_ok() {
            return;
        }
        // EcoQoS: Windows 11 runs the thread on efficiency cores at efficient clocks.
        let state = THREAD_POWER_THROTTLING_STATE {
            Version: THREAD_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: THREAD_POWER_THROTTLING_EXECUTION_SPEED,
            StateMask: THREAD_POWER_THROTTLING_EXECUTION_SPEED,
        };
        SetThreadInformation(
            GetCurrentThread(),
            ThreadPowerThrottling,
            (&raw const state).cast(),
            size_of::<THREAD_POWER_THROTTLING_STATE>() as u32,
        );
    }
    #[cfg(target_vendor = "apple")]
    // SAFETY: sets only the calling thread's quality of service.
    unsafe {
        // Utility: Apple silicon runs it on efficiency cores, and it yields to anything interactive.
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
    #[cfg(target_os = "linux")]
    // SAFETY: on Linux a thread id names just that thread, so this renices only the calling thread.
    unsafe {
        let thread = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, thread, 10);
    }
}

/// Whether the file at `path` is the expected model, byte for byte.
pub fn verify_model(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).is_ok() && hex(&hasher.finalize()) == MODEL_SHA256
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What an interrupted analysis had finished, so it can carry on from there instead of
/// starting over. Only chunks finished in order are kept.
#[derive(Default)]
pub struct Progress {
    power: Vec<f64>,
    chunks: usize,
}

/// The isolated vocals' power per `ambra_lyric_sync::FRAME_MS` frame, from the start of the
/// recording. `cancel` stops it between chunks, leaving what was finished in `progress`;
/// called again with the same `progress`, it skips that part.
pub fn vocal_power(
    separator: &Separator,
    source: Box<dyn MediaSource>,
    extension: Option<&str>,
    budget: Budget,
    cancel: &AtomicBool,
    progress: &mut Progress,
) -> Result<Vec<f64>, String> {
    let mut hint = Hint::new();
    if let Some(extension) = extension {
        hint.with_extension(extension);
    }
    let stream = MediaSourceStream::new(source, Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(&hint, stream, FormatOptions::default(), MetadataOptions::default())
        .map_err(|error| format!("Could not identify the recording: {error}"))?;
    let track = format
        .default_track(TrackType::Audio)
        .or_else(|| format.first_track_known_codec(TrackType::Audio))
        .cloned()
        .ok_or("No decodable audio track was found")?;
    let parameters = track
        .codec_params
        .as_ref()
        .and_then(|parameters| parameters.audio())
        .ok_or("Audio codec parameters are missing")?;
    let rate = parameters.sample_rate.ok_or("The sample rate is unknown")?;
    let channels = parameters.channels.as_ref().map_or(0, |channels| channels.count());
    if channels == 0 {
        return Err("The channel layout is unknown".into());
    }
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(parameters, &AudioDecoderOptions::default())
        .map_err(|error| format!("Could not create an audio decoder: {error}"))?;

    let shape = separator.shape;
    let limit_frames = ambra_lyric_sync::MAX_ANALYSIS_FRAMES * ambra_lyric_sync::FRAME_MS as usize
        * SAMPLE_RATE as usize / 1000 / shape.hop;
    let executor = (budget.threads > budget.chunks).then(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(budget.threads)
            .thread_name(|index| format!("vocal-timing-{index}"))
            .start_handler(|_| background_thread())
            .build()
            .map(|pool| Executor::MultiThread(Arc::new(pool)))
    });
    let executor = match executor {
        Some(Ok(executor)) => executor,
        Some(Err(error)) => return Err(format!("Could not start the analysis threads: {error}")),
        None => Executor::SingleThread,
    };
    let workers = budget.chunks.clamp(1, budget.threads);
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(N_FFT);
    let window: Vec<f32> = (0..N_FFT)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / N_FFT as f32).cos())
        .collect();

    let mut audio = Audio { samples: Vec::new(), base: 0 };
    let mut resampler = Resampler::new(rate);
    let mut interleaved: Vec<f32> = Vec::new();
    let mut finished = std::mem::take(progress);
    // At most one chunk waits per worker, so memory stays bounded while the decoder runs ahead.
    let (send_chunk, chunks) = mpsc::sync_channel::<(usize, Vec<[f32; 2]>)>(workers);
    let chunks = Mutex::new(chunks);
    let (send_power, powers) = mpsc::channel::<(usize, Result<Vec<f64>, String>)>();
    let result = thread::scope(|scope| -> Result<(), String> {
        for _ in 0..workers {
            let (chunks, send_power, executor, fft, window) = (&chunks, send_power.clone(), &executor, &fft, &window);
            scope.spawn(move || {
                background_thread();
                let mut worker = Worker::new(separator, fft.clone(), window);
                loop {
                    let next = chunks.lock().unwrap_or_else(|error| error.into_inner()).recv();
                    let Ok((index, samples)) = next else { break };
                    let power = if cancel.load(Ordering::Relaxed) {
                        Err("Vocal analysis was cancelled".to_owned())
                    } else {
                        multithread_tract_scope(executor.clone(), || worker.separate(&samples))
                    };
                    if send_power.send((index, power)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(send_power);

        let mut next_chunk = finished.chunks;
        let mut waiting = BTreeMap::new();
        let mut collect = |finished: &mut Progress, block: bool| -> Result<(), String> {
            loop {
                let received = if block { powers.recv().ok() } else { powers.try_recv().ok() };
                let Some((index, power)) = received else { return Ok(()) };
                waiting.insert(index, power?);
                while let Some(power) = waiting.remove(&finished.chunks) {
                    finished.power.extend(power);
                    finished.chunks += 1;
                }
            }
        };

        let mut ended = false;
        while !ended {
            if cancel.load(Ordering::Relaxed) {
                return Err("Vocal analysis was cancelled".into());
            }
            match format.next_packet() {
                Ok(Some(packet)) if packet.track_id == track.id => match decoder.decode(&packet) {
                    Ok(decoded) => {
                        decoded.copy_to_vec_interleaved(&mut interleaved);
                        for frame in interleaved.chunks_exact(channels) {
                            let left = frame[0];
                            let right = frame.get(1).copied().unwrap_or(left);
                            resampler.push([left, right], &mut audio);
                        }
                        // Resuming, the chunks already finished are decoded past, not kept.
                        audio.drop_before(shape.chunk_samples(next_chunk).0);
                    }
                    Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
                    Err(error) => return Err(format!("Could not decode the recording: {error}")),
                },
                Ok(Some(_)) => continue,
                Ok(None) => ended = true,
                Err(SymphoniaError::ResetRequired) => return Err("The audio stream layout changed".into()),
                Err(error) => return Err(format!("Could not read the recording: {error}")),
            }
            let total = audio.base + audio.samples.len();
            let needed_frames = total.div_ceil(shape.hop);
            loop {
                let (start, end) = shape.chunk_samples(next_chunk);
                let ready = end <= total as isize || (ended && next_chunk * shape.step() < needed_frames);
                if !ready || next_chunk * shape.step() >= limit_frames {
                    break;
                }
                send_chunk.send((next_chunk, audio.slice(start, end))).map_err(|_| "Vocal separation stopped unexpectedly")?;
                next_chunk += 1;
                // Drop the audio no later chunk reads.
                let (keep_from, _) = shape.chunk_samples(next_chunk);
                audio.drop_before(keep_from);
                collect(&mut finished, false)?;
            }
            if next_chunk * shape.step() >= limit_frames {
                break;
            }
        }
        drop(send_chunk);
        collect(&mut finished, true)?;
        Ok(())
    });
    let total_samples = audio.base + audio.samples.len();
    match result {
        Ok(()) => Ok(frame_grid(&finished.power, total_samples, shape.hop)),
        Err(error) => {
            *progress = finished;
            Err(error)
        }
    }
}

/// One worker's model state and buffers, reused for every chunk it separates.
struct Worker<'a> {
    state: TypedSimpleState,
    shape: Shape,
    fft: Arc<dyn RealToComplex<f32>>,
    window: &'a [f32],
}

impl<'a> Worker<'a> {
    fn new(separator: &Separator, fft: Arc<dyn RealToComplex<f32>>, window: &'a [f32]) -> Self {
        Self {
            state: TypedSimpleState::new(&separator.plan).expect("the model plan has no state to fail on"),
            shape: separator.shape,
            fft,
            window,
        }
    }

    /// One chunk: its spectra in, isolated-vocal spectra out, summed to power per kept frame.
    fn separate(&mut self, samples: &[[f32; 2]]) -> Result<Vec<f64>, String> {
        let shape = self.shape;
        let kept = shape.margin..shape.margin + shape.step();
        // Silence has no vocals to find; the model is skipped.
        let (from, to) = (kept.start * shape.hop, (kept.end - 1) * shape.hop + N_FFT);
        if samples[from..to.min(samples.len())].iter().all(|[left, right]| left.abs() < SILENCE_PEAK && right.abs() < SILENCE_PEAK) {
            return Ok(vec![0.0; shape.step()]);
        }
        #[cfg(test)]
        let started = std::time::Instant::now();
        let mut input = tract_ndarray::Array4::<f32>::zeros((1, 4, BINS, shape.frames));
        {
            let view = &mut input;
            let mut buffer = self.fft.make_input_vec();
            let mut spectrum = self.fft.make_output_vec();
            let mut scratch = self.fft.make_scratch_vec();
            for frame in 0..shape.frames {
                for channel in 0..2 {
                    let offset = frame * shape.hop;
                    for ((target, sample), weight) in buffer.iter_mut().zip(&samples[offset..offset + N_FFT]).zip(self.window) {
                        *target = sample[channel] * weight;
                    }
                    self.fft
                        .process_with_scratch(&mut buffer, &mut spectrum, &mut scratch)
                        .map_err(|error| error.to_string())?;
                    for (bin, value) in spectrum.iter().take(BINS).enumerate() {
                        view[[0, channel * 2, bin, frame]] = value.re;
                        view[[0, channel * 2 + 1, bin, frame]] = value.im;
                    }
                }
            }
        }
        #[cfg(test)]
        let prepared = std::time::Instant::now();
        let output = self
            .state
            .run(tvec!(Tensor::from(input).into()))
            .map_err(|error| format!("Vocal separation failed: {error}"))?;
        #[cfg(test)]
        let ran = std::time::Instant::now();
        let output = output[0]
            .to_plain_array_view::<f32>()
            .map_err(|error| error.to_string())?
            .into_dimensionality::<tract_ndarray::Ix4>()
            .map_err(|error| error.to_string())?;
        let mut power = vec![0f32; shape.step()];
        // Bins outermost, frames innermost: the model's output is laid out frames-last.
        for plane in 0..4 {
            for bin in LOW_BIN..HIGH_BIN {
                let row = output.slice(tract_ndarray::s![0, plane, bin, kept.clone()]);
                for (total, value) in power.iter_mut().zip(row.iter()) {
                    *total += value * value;
                }
            }
        }
        #[cfg(test)]
        {
            let nanos = |from: std::time::Instant, to: std::time::Instant| (to - from).as_nanos() as u64;
            TIMES[0].fetch_add(nanos(started, prepared), Ordering::Relaxed);
            TIMES[1].fetch_add(nanos(prepared, ran), Ordering::Relaxed);
            TIMES[2].fetch_add(nanos(ran, std::time::Instant::now()), Ordering::Relaxed);
            TIMES[3].fetch_add(1, Ordering::Relaxed);
        }
        Ok(power.into_iter().map(|value| f64::from(value) / N_FFT as f64).collect())
    }
}

/// Time spent preparing spectra, running the model and summing power, and chunks run (benchmark only).
#[cfg(test)]
static TIMES: [std::sync::atomic::AtomicU64; 4] = [const { std::sync::atomic::AtomicU64::new(0) }; 4];

/// Linear interpolation to 44.1 kHz. Quality is irrelevant here; only energy over time is read.
struct Resampler {
    step: f64,
    position: f64,
    previous: Option<[f32; 2]>,
}

impl Resampler {
    fn new(rate: u32) -> Self {
        Self { step: f64::from(rate) / f64::from(SAMPLE_RATE), position: 0.0, previous: None }
    }

    fn push(&mut self, sample: [f32; 2], output: &mut Audio) {
        if self.step == 1.0 {
            output.samples.push(sample);
            return;
        }
        let Some(previous) = self.previous.replace(sample) else { return };
        // Emit every output sample that falls between the previous input sample and this one.
        while self.position < 1.0 {
            let t = self.position as f32;
            output.samples.push([
                previous[0] + (sample[0] - previous[0]) * t,
                previous[1] + (sample[1] - previous[1]) * t,
            ]);
            self.position += self.step;
        }
        self.position -= 1.0;
    }
}

struct Audio {
    /// 44.1 kHz stereo, starting at absolute sample `base`.
    samples: Vec<[f32; 2]>,
    base: usize,
}

impl Audio {
    /// A copy of absolute samples `start..end`, with silence outside the recording.
    fn slice(&self, start: isize, end: isize) -> Vec<[f32; 2]> {
        (start..end)
            .map(|index| {
                usize::try_from(index)
                    .ok()
                    .and_then(|index| index.checked_sub(self.base))
                    .and_then(|index| self.samples.get(index).copied())
                    .unwrap_or([0.0; 2])
            })
            .collect()
    }

    fn drop_before(&mut self, sample: isize) {
        let drop = (sample.max(0) as usize).saturating_sub(self.base).min(self.samples.len());
        self.samples.drain(..drop);
        self.base += drop;
    }
}

/// Model frames (centred `hop` samples apart) resampled onto the lyric sync's frame grid.
fn frame_grid(power: &[f64], samples: usize, hop: usize) -> Vec<f64> {
    let frame_ms = ambra_lyric_sync::FRAME_MS as f64;
    let duration_ms = samples as f64 * 1000.0 / f64::from(SAMPLE_RATE);
    let frames = (duration_ms / frame_ms) as usize;
    (0..frames)
        .map(|frame| {
            let position = frame as f64 * frame_ms * f64::from(SAMPLE_RATE) / 1000.0 / hop as f64;
            let index = position.floor() as usize;
            let t = position - index as f64;
            match (power.get(index), power.get(index + 1)) {
                (Some(a), Some(b)) => a + (b - a) * t,
                (Some(a), None) => *a,
                _ => 0.0,
            }
        })
        .collect()
}

/// A benchmark over real recordings, run by hand:
/// `AMBRA_VOCAL_BENCH=<corpus.json> AMBRA_VOCAL_OUT=<dir> cargo test vocal_bench -- --ignored --nocapture`.
/// The corpus lists downloaded songs (`file`, `container`, `name`) with the lyric windows the
/// server would match (`windows`); each song's curve, timing and sync result land in the out dir.
#[cfg(test)]
mod bench {
    use super::*;
    use std::{fs, time::Instant};

    #[derive(serde::Deserialize)]
    struct Song {
        name: String,
        file: String,
        container: String,
        windows: Vec<ambra_lyric_sync::LyricWindow>,
    }

    struct VaultFile(ambra_vault::Reader<fs::File>);
    impl std::io::Read for VaultFile {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> { self.0.read(buffer) }
    }
    impl std::io::Seek for VaultFile {
        fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> { self.0.seek(position) }
    }
    impl MediaSource for VaultFile {
        fn is_seekable(&self) -> bool { true }
        fn byte_len(&self) -> Option<u64> { Some(self.0.len()) }
    }

    #[cfg(windows)]
    fn process_cpu_seconds() -> f64 {
        use windows_sys::Win32::{Foundation::FILETIME, System::Threading::{GetCurrentProcess, GetProcessTimes}};
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut a, mut b, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: reads this process's own times into local structs.
        unsafe { GetProcessTimes(GetCurrentProcess(), &mut a, &mut b, &mut kernel, &mut user) };
        let ticks = |time: FILETIME| (u64::from(time.dwHighDateTime) << 32 | u64::from(time.dwLowDateTime)) as f64;
        (ticks(kernel) + ticks(user)) / 1e7
    }
    #[cfg(not(windows))]
    fn process_cpu_seconds() -> f64 { 0.0 }

    #[cfg(windows)]
    fn peak_memory_mb() -> f64 {
        use windows_sys::Win32::System::{ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS}, Threading::GetCurrentProcess};
        // SAFETY: fills a correctly sized counters struct for this process.
        unsafe {
            let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb);
            counters.PeakWorkingSetSize as f64 / 1_048_576.0
        }
    }
    #[cfg(not(windows))]
    fn peak_memory_mb() -> f64 { 0.0 }

    #[test]
    #[ignore = "needs the vocal model and downloaded songs"]
    fn vocal_bench() {
        let corpus = std::env::var("AMBRA_VOCAL_BENCH").expect("AMBRA_VOCAL_BENCH");
        let out = std::path::PathBuf::from(std::env::var("AMBRA_VOCAL_OUT").expect("AMBRA_VOCAL_OUT"));
        let env = |name: &str| std::env::var(name).ok().and_then(|value| value.parse::<usize>().ok());
        let threads = env("AMBRA_VOCAL_THREADS").unwrap_or(4);
        let budget = Budget { threads, chunks: env("AMBRA_VOCAL_CHUNKS").unwrap_or(threads) };
        let shape = Shape {
            hop: env("AMBRA_VOCAL_HOP").unwrap_or(Shape::DEFAULT.hop),
            frames: env("AMBRA_VOCAL_FRAMES").unwrap_or(Shape::DEFAULT.frames),
            margin: env("AMBRA_VOCAL_MARGIN").unwrap_or(Shape::DEFAULT.margin),
        };
        println!("{budget:?} {shape:?}");
        let limit: usize = std::env::var("AMBRA_VOCAL_LIMIT").ok().and_then(|value| value.parse().ok()).unwrap_or(usize::MAX);
        let data = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.tetrum.ambra");
        let model = std::env::var("AMBRA_VOCAL_MODEL").map(std::path::PathBuf::from)
            .unwrap_or_else(|_| data.join("data/vocal-timing/model.onnx"));
        let key = ambra_vault::Key::load_or_create(&data.join("config/download-vault.key")).unwrap();
        let songs: Vec<Song> = serde_json::from_slice(&fs::read(corpus).unwrap()).unwrap();
        fs::create_dir_all(&out).unwrap();

        let loaded = Instant::now();
        let separator = Separator::load_shaped(&model, shape).unwrap();
        println!("model loaded in {:.2}s", loaded.elapsed().as_secs_f64());
        let mut report = Vec::new();
        let (mut wall_total, mut cpu_total, mut audio_total) = (0.0, 0.0, 0.0);
        for (index, song) in songs.iter().take(limit).enumerate() {
            let reader = ambra_vault::Reader::new(fs::File::open(data.join("data/downloads").join(&song.file)).unwrap(), &key).unwrap();
            let (cpu, started) = (process_cpu_seconds(), Instant::now());
            // With AMBRA_VOCAL_REUSE set, the curves already in the out dir are scored again.
            let power = if std::env::var("AMBRA_VOCAL_REUSE").is_ok() {
                fs::read(out.join(format!("{index:02}.bin"))).unwrap().chunks_exact(4)
                    .map(|bytes| f64::from(f32::from_le_bytes(bytes.try_into().unwrap()))).collect()
            } else {
                vocal_power(&separator, Box::new(VaultFile(reader)), Some(&song.container), budget, &AtomicBool::new(false), &mut Progress::default()).unwrap()
            };
            let (wall, cpu) = (started.elapsed().as_secs_f64(), process_cpu_seconds() - cpu);
            let audio = power.len() as f64 * ambra_lyric_sync::FRAME_MS as f64 / 1000.0;
            let offset = ambra_lyric_sync::analyze(power.clone(), &song.windows, &song.name).unwrap();
            // Lyrics moved by a known amount must be found moved by exactly that much, and trusted
            // (the app's default thresholds, lyricsAutoTuning.ts).
            let recovered: Vec<serde_json::Value> = [-2300i64, -900, 600, 1700].iter().map(|&moved| {
                let windows: Vec<_> = song.windows.iter().map(|window| ambra_lyric_sync::LyricWindow {
                    start_ms: window.start_ms + moved as f64, end_ms: window.end_ms + moved as f64,
                }).collect();
                let found = ambra_lyric_sync::analyze(power.clone(), &windows, "shifted").unwrap();
                let exact = found.best_ms.zip(offset.best_ms).is_some_and(|(found, base)| (found - base - moved).abs() <= 20);
                let trusted = found.prominence >= 4.0 && found.margin.is_none_or(|margin| margin >= 0.75);
                serde_json::json!({ "moved": moved, "exact": exact, "trusted": trusted, "prominence": found.prominence })
            }).collect();
            let bytes: Vec<u8> = power.iter().flat_map(|value| (*value as f32).to_le_bytes()).collect();
            fs::write(out.join(format!("{index:02}.bin")), bytes).unwrap();
            println!("{index:02} {:<60} audio {audio:6.1}s wall {wall:6.2}s cpu {cpu:6.2}s best {:?} prom {:.2} margin {:?} end {:?}",
                song.name, offset.best_ms, offset.prominence, offset.margin, offset.vocal_end_ms);
            report.push(serde_json::json!({ "index": index, "name": song.name, "audio": audio, "wall": wall, "cpu": cpu, "offset": offset, "recovered": recovered }));
            wall_total += wall;
            cpu_total += cpu;
            audio_total += audio;
        }
        let peak = peak_memory_mb();
        let time = |index: usize| TIMES[index].load(Ordering::Relaxed) as f64 / 1e9;
        let chunks = TIMES[3].load(Ordering::Relaxed).max(1) as f64;
        println!("per chunk: spectra {:.3}s model {:.3}s power {:.3}s ({chunks} chunks)",
            time(0) / chunks, time(1) / chunks, time(2) / chunks);
        println!("TOTAL audio {audio_total:.0}s wall {wall_total:.1}s ({:.1}x realtime) cpu {cpu_total:.1}s ({:.3} cpu-s per audio-s) peak {peak:.0} MB threads {threads}",
            audio_total / wall_total, cpu_total / audio_total);
        fs::write(out.join("report.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "threads": threads, "chunks": budget.chunks, "hop": shape.hop, "frames": shape.frames, "margin": shape.margin, "wall": wall_total, "cpu": cpu_total, "audio": audio_total, "peakMb": peak, "songs": report,
        })).unwrap()).unwrap();
    }
}
