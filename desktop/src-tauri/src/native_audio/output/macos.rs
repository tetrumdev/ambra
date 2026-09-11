use std::{
    process,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};

use coreaudio::audio_unit::{
    AudioUnit, Element, IOType, SampleFormat, Scope, StreamFormat,
    audio_format::LinearPcmFlags,
    macos_helpers::{
        audio_unit_from_device_id, find_matching_physical_format, get_audio_device_ids_for_scope,
        get_audio_device_supports_scope, get_default_device_id, get_device_name, get_hogging_pid,
        set_device_physical_stream_format, toggle_hog_mode,
    },
    render_callback::{self, data},
};
use crossbeam_channel::{Receiver, Sender, TryRecvError, TrySendError, bounded};
use objc2_core_audio::AudioDeviceID;

use super::{AudioOutput, NativeAudioDevice, StreamSpec, normalized_to_signed};

const RENDER_BLOCKS: usize = 8;
const MAX_RENDER_BLOCK_FRAMES: usize = 8_192;

pub struct PlatformOutput {
    audio_unit: coreaudio::audio_unit::AudioUnit,
    device_id: AudioDeviceID,
    ready_tx: Sender<RenderBlock>,
    pool_tx: Sender<Vec<i32>>,
    pool_rx: Receiver<Vec<i32>>,
    generation: Arc<AtomicU64>,
    queued_samples: Arc<AtomicU64>,
    channels: usize,
    started: bool,
    owns_hog_mode: bool,
}

struct RenderBlock {
    generation: u64,
    samples: Vec<i32>,
}

impl AudioOutput for PlatformOutput {
    fn list_devices() -> Result<Vec<NativeAudioDevice>, String> {
        let device_ids = get_audio_device_ids_for_scope(Scope::Output).map_err(coreaudio_error)?;
        let default_device_id = get_default_device_id(false);

        device_ids
            .into_iter()
            .filter(|device_id| {
                get_audio_device_supports_scope(*device_id, Scope::Output).unwrap_or(false)
            })
            .map(|device_id| {
                let name = get_device_name(device_id).map_err(coreaudio_error)?;

                Ok(NativeAudioDevice {
                    id: device_id.to_string(),
                    name,
                    is_default: Some(device_id) == default_device_id,
                })
            })
            .collect()
    }

    fn open(spec: StreamSpec) -> Result<Self, String> {
        Self::open_device(spec, None)
    }

    fn open_device(spec: StreamSpec, device_id: Option<&str>) -> Result<Self, String> {
        Self::open_device_with_mode(spec, device_id, true)
    }

    fn open_device_with_mode(
        spec: StreamSpec,
        selected_device_id: Option<&str>,
        exclusive_mode: bool,
    ) -> Result<Self, String> {
        let device_id = match (exclusive_mode, selected_device_id) {
            (true, Some(device_id)) => device_id
                .parse::<AudioDeviceID>()
                .map_err(|_| "The selected CoreAudio device ID is invalid".to_owned())?,
            _ => get_default_device_id(false)
                .ok_or_else(|| "No default CoreAudio output device is available".to_owned())?,
        };

        let owns_hog_mode = if exclusive_mode {
            claim_hog_mode(device_id)?
        } else {
            false
        };
        let follows_system_output = !exclusive_mode;
        let result = Self::open_configured(
            spec,
            device_id,
            owns_hog_mode,
            exclusive_mode,
            follows_system_output,
        );

        if result.is_err() && owns_hog_mode {
            let _ = toggle_hog_mode(device_id);
        }

        result
    }

    fn start(&mut self) -> Result<(), String> {
        if !self.started {
            self.audio_unit.start().map_err(coreaudio_error)?;
            self.started = true;
        }
        Ok(())
    }

    fn pause(&mut self) -> Result<(), String> {
        if self.started {
            self.audio_unit.stop().map_err(coreaudio_error)?;
            self.started = false;
        }
        Ok(())
    }

    fn reset(&mut self) -> Result<(), String> {
        self.pause()?;
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.queued_samples.store(0, Ordering::Release);
        Ok(())
    }

    fn write(&mut self, first: &[f64], second: &[f64]) -> Result<usize, String> {
        if first.is_empty() && second.is_empty() {
            return Ok(0);
        }
        let frames = ((first.len() + second.len()) / self.channels).min(MAX_RENDER_BLOCK_FRAMES);
        let sample_count = frames * self.channels;
        let mut block = match self.pool_rx.try_recv() {
            Ok(block) => block,
            Err(TryRecvError::Empty) => {
                thread::sleep(Duration::from_millis(1));
                return Ok(0);
            }
            Err(TryRecvError::Disconnected) => {
                return Err("The CoreAudio render callback stopped".to_owned());
            }
        };
        block.clear();
        block.extend(
            first
                .iter()
                .chain(second)
                .take(sample_count)
                .map(|sample| normalized_to_signed(*sample, 32) as i32),
        );
        let block = RenderBlock {
            generation: self.generation.load(Ordering::Acquire),
            samples: block,
        };
        self.queued_samples
            .fetch_add(sample_count as u64, Ordering::AcqRel);
        match self.ready_tx.try_send(block) {
            Ok(()) => Ok(frames),
            Err(TrySendError::Full(block)) => {
                subtract_queued_samples(&self.queued_samples, block.samples.len());
                let _ = self.pool_tx.try_send(block.samples);
                thread::sleep(Duration::from_millis(1));
                Ok(0)
            }
            Err(TrySendError::Disconnected(block)) => {
                subtract_queued_samples(&self.queued_samples, block.samples.len());
                let _ = self.pool_tx.try_send(block.samples);
                Err("The CoreAudio render callback stopped".to_owned())
            }
        }
    }

    fn queued_frames(&mut self) -> Result<usize, String> {
        Ok(self.queued_samples.load(Ordering::Acquire) as usize / self.channels)
    }

    fn is_drained(&mut self) -> Result<bool, String> {
        Ok(self.queued_samples.load(Ordering::Acquire) == 0)
    }
}

impl PlatformOutput {
    fn open_configured(
        spec: StreamSpec,
        device_id: AudioDeviceID,
        owns_hog_mode: bool,
        exclusive_mode: bool,
        follows_system_output: bool,
    ) -> Result<Self, String> {
        if exclusive_mode {
            let physical_candidates: &[SampleFormat] = match spec.bits_per_sample {
                0..=16 => &[
                    SampleFormat::I16,
                    SampleFormat::I24,
                    SampleFormat::I32,
                    SampleFormat::F32,
                ],
                17..=24 => &[SampleFormat::I24, SampleFormat::I32, SampleFormat::F32],
                _ => &[SampleFormat::I32, SampleFormat::F32],
            };
            let physical_description = physical_candidates
                .iter()
                .find_map(|sample_format| {
                    find_matching_physical_format(
                        device_id,
                        StreamFormat {
                            sample_rate: f64::from(spec.sample_rate),
                            sample_format: *sample_format,
                            flags: LinearPcmFlags::empty(),
                            channels: spec.channels as u32,
                        },
                    )
                })
                .ok_or_else(|| {
                    format!(
                        "The selected audio device does not support {} Hz, {} channel, {}-bit playback in CoreAudio exclusive mode",
                        spec.sample_rate, spec.channels, spec.bits_per_sample
                    )
                })?;
            set_device_physical_stream_format(device_id, physical_description)
                .map_err(coreaudio_error)?;
        }

        let mut audio_unit = if follows_system_output {
            AudioUnit::new(IOType::DefaultOutput).map_err(coreaudio_error)?
        } else {
            audio_unit_from_device_id(device_id, false).map_err(coreaudio_error)?
        };
        audio_unit
            .set_stream_format(
                StreamFormat {
                    sample_rate: f64::from(spec.sample_rate),
                    sample_format: SampleFormat::I32,
                    flags: LinearPcmFlags::IS_SIGNED_INTEGER | LinearPcmFlags::IS_PACKED,
                    channels: spec.channels as u32,
                },
                Scope::Input,
                Element::Output,
            )
            .map_err(coreaudio_error)?;

        let (ready_tx, ready_rx) = bounded::<RenderBlock>(RENDER_BLOCKS);
        let (pool_tx, pool_rx) = bounded::<Vec<i32>>(RENDER_BLOCKS);
        let callback_pool_tx = pool_tx.clone();
        let generation = Arc::new(AtomicU64::new(0));
        let callback_generation = generation.clone();
        let queued_samples = Arc::new(AtomicU64::new(0));
        let callback_queued_samples = queued_samples.clone();
        for _ in 0..RENDER_BLOCKS {
            let _ = pool_tx.try_send(Vec::with_capacity(MAX_RENDER_BLOCK_FRAMES * spec.channels));
        }
        let channels = spec.channels;
        let mut active_block = Vec::new();
        let mut active_offset = 0;
        let mut active_generation = 0;
        type Args = render_callback::Args<data::Interleaved<i32>>;
        audio_unit
            .set_render_callback(move |args: Args| {
                let output = args.data.buffer;
                output.fill(0);
                let current_generation = callback_generation.load(Ordering::Acquire);
                if active_generation != current_generation && !active_block.is_empty() {
                    subtract_queued_samples(
                        &callback_queued_samples,
                        active_block.len().saturating_sub(active_offset),
                    );
                    active_block.clear();
                    active_offset = 0;
                    let _ = callback_pool_tx.try_send(std::mem::take(&mut active_block));
                }
                let mut output_offset = 0;
                while output_offset < output.len() {
                    if active_offset >= active_block.len() {
                        if !active_block.is_empty() {
                            active_block.clear();
                            let _ = callback_pool_tx.try_send(std::mem::take(&mut active_block));
                        }
                        match ready_rx.try_recv() {
                            Ok(block) => {
                                if block.generation == callback_generation.load(Ordering::Acquire) {
                                    active_block = block.samples;
                                    active_offset = 0;
                                    active_generation = block.generation;
                                } else {
                                    subtract_queued_samples(
                                        &callback_queued_samples,
                                        block.samples.len(),
                                    );
                                    let _ = callback_pool_tx.try_send(block.samples);
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    let count =
                        (active_block.len() - active_offset).min(output.len() - output_offset);
                    output[output_offset..output_offset + count]
                        .copy_from_slice(&active_block[active_offset..active_offset + count]);
                    subtract_queued_samples(&callback_queued_samples, count);
                    active_offset += count;
                    output_offset += count;
                }
                debug_assert_eq!(output.len() % channels, 0);
                Ok(())
            })
            .map_err(coreaudio_error)?;

        Ok(Self {
            audio_unit,
            device_id,
            ready_tx,
            pool_tx,
            pool_rx,
            generation,
            queued_samples,
            channels: spec.channels,
            started: false,
            owns_hog_mode,
        })
    }
}

impl Drop for PlatformOutput {
    fn drop(&mut self) {
        let _ = self.pause();
        if self.owns_hog_mode && get_hogging_pid(self.device_id).ok() == Some(process::id() as i32)
        {
            let _ = toggle_hog_mode(self.device_id);
        }
    }
}

fn claim_hog_mode(device_id: AudioDeviceID) -> Result<bool, String> {
    let process_id = process::id() as i32;
    match get_hogging_pid(device_id).map_err(coreaudio_error)? {
        owner if owner == process_id => Ok(false),
        -1 => {
            let owner = toggle_hog_mode(device_id).map_err(coreaudio_error)?;
            if owner == process_id {
                Ok(true)
            } else {
                Err("CoreAudio did not grant exclusive access".to_owned())
            }
        }
        owner => Err(format!(
            "The default audio device is already in use by process {owner}"
        )),
    }
}

fn coreaudio_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn subtract_queued_samples(counter: &AtomicU64, count: usize) {
    let _ = counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
        Some(value.saturating_sub(count as u64))
    });
}

#[cfg(test)]
mod tests {
    use super::{AudioOutput, PlatformOutput, StreamSpec};
    use std::{f64::consts::TAU, thread, time::Duration};

    #[test]
    #[ignore = "requires a macOS audio output device"]
    fn opens_and_services_the_default_shared_device() {
        let started = std::time::Instant::now();
        let spec = StreamSpec {
            sample_rate: 44_100,
            channels: 2,
            bits_per_sample: 16,
        };
        let mut output = PlatformOutput::open_device_with_mode(spec, None, false).unwrap();
        println!("Shared audio output opened in {:?}", started.elapsed());
        let silence = vec![0.0; 441 * spec.channels];

        output.start().unwrap();
        println!("Shared audio output started in {:?}", started.elapsed());
        assert_eq!(output.write(&silence, &[]).unwrap(), 441);
        output.reset().unwrap();
    }

    #[test]
    #[ignore = "plays a two-second tone through the default macOS output"]
    fn plays_signal_through_the_default_shared_device() {
        let spec = StreamSpec {
            sample_rate: 44_100,
            channels: 2,
            bits_per_sample: 16,
        };
        let frames = spec.sample_rate as usize * 2;
        let mut signal = Vec::with_capacity(frames * spec.channels);
        for frame in 0..frames {
            let sample = (TAU * 440.0 * frame as f64 / f64::from(spec.sample_rate)).sin() * 0.1;
            signal.extend([sample, sample]);
        }

        let mut output = PlatformOutput::open_device_with_mode(spec, None, false).unwrap();
        output.start().unwrap();
        let mut offset = 0;
        while offset < signal.len() {
            let written = output.write(&signal[offset..], &[]).unwrap();
            offset += written * spec.channels;
        }
        while !output.is_drained().unwrap() {
            thread::sleep(Duration::from_millis(5));
        }
        output.reset().unwrap();
    }
}
