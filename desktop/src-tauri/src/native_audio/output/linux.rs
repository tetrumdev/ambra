use std::{thread, time::Duration};

use alsa::{
    Direction, ValueOr,
    ctl::{Ctl, DeviceIter},
    pcm::{Access, Format, HwParams, PCM, State},
};

use super::{AudioOutput, NativeAudioDevice, StreamSpec, normalized_to_signed, writable_frames};

/// The system mixer (PipeWire, PulseAudio or dmix, whichever ALSA routes "default" to).
const DEFAULT_DEVICE: &str = "default";
const BUFFER_MICROSECONDS: u32 = 200_000;
const PERIOD_MICROSECONDS: u32 = 25_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeviceFormat {
    S16,
    S24Packed,
    S24In32,
    S32,
}

impl DeviceFormat {
    fn alsa(self) -> Format {
        match self {
            Self::S16 => Format::S16LE,
            Self::S24Packed => Format::S243LE,
            Self::S24In32 => Format::S24LE,
            Self::S32 => Format::S32LE,
        }
    }

    fn bytes_per_sample(self) -> usize {
        match self {
            Self::S16 => 2,
            Self::S24Packed => 3,
            Self::S24In32 | Self::S32 => 4,
        }
    }

    fn encode(self, sample: f64, out: &mut Vec<u8>) {
        match self {
            Self::S16 => out.extend_from_slice(&(normalized_to_signed(sample, 16) as i16).to_le_bytes()),
            Self::S24Packed => {
                out.extend_from_slice(&(normalized_to_signed(sample, 24) as i32).to_le_bytes()[..3])
            }
            Self::S24In32 => out.extend_from_slice(&(normalized_to_signed(sample, 24) as i32).to_le_bytes()),
            Self::S32 => out.extend_from_slice(&(normalized_to_signed(sample, 32) as i32).to_le_bytes()),
        }
    }
}

pub struct PlatformOutput {
    pcm: PCM,
    format: DeviceFormat,
    channels: usize,
    buffer_frames: usize,
    poll_interval: Duration,
    /// Exclusive streams talk to the hardware directly, so their integer depth is what the DAC
    /// receives. Shared streams pass through the system mixer, which works in floating point.
    exclusive: bool,
    started: bool,
    bytes: Vec<u8>,
}


/// ALSA hint names for hardware devices look like `hw:CARD=PCH,DEV=0`.
fn is_hardware(id: &str) -> bool {
    id.starts_with("hw:")
}

fn alsa_error(context: &str, error: alsa::Error) -> String {
    format!("{context}: {error}")
}

impl AudioOutput for PlatformOutput {
    fn list_devices() -> Result<Vec<NativeAudioDevice>, String> {
        // Every hardware playback device; the settings' own "System Default" entry (no id)
        // stands for the system mixer. alsa-lib hides `hw:` devices from its name hints by
        // default, so cards are walked directly.
        let mut devices = Vec::new();
        for card in alsa::card::Iter::new() {
            let Ok(card) = card else { continue };
            let Ok(ctl) = Ctl::from_card(&card, false) else { continue };
            let Ok(card_info) = ctl.card_info() else { continue };
            let (Ok(card_id), Ok(card_name)) = (card_info.get_id(), card_info.get_name()) else {
                continue;
            };
            for device in DeviceIter::new(&ctl) {
                let Ok(device) = u32::try_from(device) else { continue };
                // Capture-only devices have no playback info.
                let Ok(info) = ctl.pcm_info(device, 0, Direction::Playback) else { continue };
                let pcm_name = info.get_name().unwrap_or_default().trim();
                devices.push(NativeAudioDevice {
                    id: format!("hw:CARD={card_id},DEV={device}"),
                    name: if pcm_name.is_empty() {
                        card_name.to_owned()
                    } else {
                        format!("{card_name} — {pcm_name}")
                    },
                    is_default: false,
                });
            }
        }
        Ok(devices)
    }

    fn open(spec: StreamSpec) -> Result<Self, String> {
        Self::open_device_with_mode(spec, None, false, false)
    }

    fn open_device(spec: StreamSpec, device_id: Option<&str>) -> Result<Self, String> {
        Self::open_device_with_mode(spec, device_id, false, false)
    }

    fn open_device_with_mode(
        spec: StreamSpec,
        device_id: Option<&str>,
        exclusive_mode: bool,
        processed: bool,
    ) -> Result<Self, String> {
        let device_id = device_id.filter(|id| !id.is_empty());
        if exclusive_mode {
            let id = device_id
                .filter(|id| is_hardware(id))
                .ok_or_else(|| {
                    "Exclusive mode on Linux needs a hardware output; choose one in the audio device list"
                        .to_owned()
                })?;
            Self::open_exclusive(spec, id, processed)
        } else {
            // A hardware device opened in shared mode goes through ALSA's plug converter,
            // so any rate or format the source has still plays.
            let name = match device_id {
                Some(id) if is_hardware(id) => format!("plug{id}"),
                Some(id) => id.to_owned(),
                None => DEFAULT_DEVICE.to_owned(),
            };
            Self::open_shared(spec, &name)
        }
    }

    fn start(&mut self) -> Result<(), String> {
        if !self.started {
            if self.pcm.state() == State::Paused {
                self.pcm
                    .pause(false)
                    .map_err(|error| alsa_error("Could not resume ALSA playback", error))?;
            }
            self.started = true;
        }
        Ok(())
    }

    fn pause(&mut self) -> Result<(), String> {
        if self.started {
            if self.pcm.state() == State::Running {
                let can_pause = self
                    .pcm
                    .hw_params_current()
                    .map(|params| params.can_pause())
                    .unwrap_or(false);
                if can_pause {
                    self.pcm
                        .pause(true)
                        .map_err(|error| alsa_error("Could not pause ALSA playback", error))?;
                } else {
                    self.drop_queued()?;
                }
            }
            self.started = false;
        }
        Ok(())
    }

    fn reset(&mut self) -> Result<(), String> {
        self.started = false;
        self.drop_queued()
    }

    fn quantization_bits(&self) -> Option<u32> {
        if !self.exclusive {
            return None;
        }
        match self.format {
            DeviceFormat::S16 => Some(16),
            // A 32-bit container still carries 24-bit music.
            DeviceFormat::S24Packed | DeviceFormat::S24In32 | DeviceFormat::S32 => Some(24),
        }
    }

    fn write(&mut self, first: &[f64], second: &[f64]) -> Result<usize, String> {
        if first.is_empty() && second.is_empty() {
            return Ok(0);
        }
        if !self.started {
            return Ok(0);
        }
        self.recover_if_stopped()?;
        let available_frames = match self.pcm.avail_update() {
            Ok(frames) => frames.max(0) as usize,
            Err(error) => {
                self.pcm
                    .try_recover(error, true)
                    .map_err(|error| alsa_error("ALSA playback failed", error))?;
                return Ok(0);
            }
        };
        if available_frames == 0 {
            thread::sleep(self.poll_interval);
            return Ok(0);
        }
        let frames = writable_frames(available_frames, first.len() + second.len(), self.channels);
        if frames == 0 {
            return Ok(0);
        }
        let sample_count = frames * self.channels;
        self.bytes.clear();
        for sample in first.iter().chain(second).take(sample_count) {
            self.format.encode(*sample, &mut self.bytes);
        }
        let result = self.pcm.io_bytes().writei(&self.bytes);
        match result {
            Ok(written) => Ok(written),
            Err(error) if error.errno() == libc::EAGAIN => {
                thread::sleep(self.poll_interval);
                Ok(0)
            }
            Err(error) => {
                self.pcm
                    .try_recover(error, true)
                    .map_err(|error| alsa_error("ALSA playback failed", error))?;
                Ok(0)
            }
        }
    }

    fn queued_frames(&mut self) -> Result<usize, String> {
        match self.pcm.state() {
            State::Running | State::Paused | State::Prepared | State::Draining => {}
            _ => return Ok(0),
        }
        match self.pcm.delay() {
            Ok(frames) => Ok(frames.max(0) as usize),
            Err(_) => Ok(self
                .pcm
                .avail_update()
                .map(|available| self.buffer_frames.saturating_sub(available.max(0) as usize))
                .unwrap_or(0)),
        }
    }

    fn is_drained(&mut self) -> Result<bool, String> {
        if self.queued_frames()? == 0 {
            Ok(true)
        } else {
            thread::sleep(self.poll_interval);
            Ok(false)
        }
    }
}

impl PlatformOutput {
    fn open_shared(spec: StreamSpec, name: &str) -> Result<Self, String> {
        let pcm = PCM::new(name, Direction::Playback, true)
            .map_err(|error| alsa_error(&format!("Could not open ALSA device {name}"), error))?;
        let format = {
            let params = HwParams::any(&pcm)
                .map_err(|error| alsa_error("Could not configure ALSA playback", error))?;
            params.set_access(Access::RWInterleaved).map_err(|error| alsa_error("ALSA access", error))?;
            params
                .set_channels(spec.channels as u32)
                .map_err(|error| alsa_error("ALSA channel count", error))?;
            params
                .set_rate(spec.sample_rate, ValueOr::Nearest)
                .map_err(|error| alsa_error("ALSA sample rate", error))?;
            // 32-bit samples carry everything the decoder produces; the mixer converts.
            let format = [DeviceFormat::S32, DeviceFormat::S24In32, DeviceFormat::S16]
                .into_iter()
                .find(|format| params.test_format(format.alsa()).is_ok())
                .ok_or_else(|| format!("ALSA device {name} accepts no supported sample format"))?;
            params.set_format(format.alsa()).map_err(|error| alsa_error("ALSA format", error))?;
            Self::apply_buffer(&pcm, &params)?;
            format
        };
        Self::finish(pcm, spec, format, false)
    }

    fn open_exclusive(spec: StreamSpec, id: &str, processed: bool) -> Result<Self, String> {
        // Untouched 16-bit audio goes out at its own depth; everything else at 24 bits.
        let candidates: &[DeviceFormat] = match spec.bits_per_sample {
            0..=16 if !processed => &[
                DeviceFormat::S16,
                DeviceFormat::S24Packed,
                DeviceFormat::S24In32,
                DeviceFormat::S32,
            ],
            _ => &[
                DeviceFormat::S24Packed,
                DeviceFormat::S24In32,
                DeviceFormat::S32,
                DeviceFormat::S16,
            ],
        };
        let candidates: Vec<DeviceFormat> = candidates
            .iter()
            .copied()
            // Never truncate a 24-bit source to 16 bits.
            .filter(|format| spec.bits_per_sample <= 16 || *format != DeviceFormat::S16)
            .collect();
        let pcm = PCM::new(id, Direction::Playback, true).map_err(|error| {
            if error.errno() == libc::EBUSY {
                format!("ALSA device {id} is in use by another application or the system mixer")
            } else {
                alsa_error(&format!("Could not open ALSA device {id}"), error)
            }
        })?;
        let format = {
            let params = HwParams::any(&pcm)
                .map_err(|error| alsa_error("Could not configure ALSA playback", error))?;
            params.set_rate_resample(false).map_err(|error| alsa_error("ALSA resampling", error))?;
            params.set_access(Access::RWInterleaved).map_err(|error| alsa_error("ALSA access", error))?;
            let unsupported = || {
                format!(
                    "ALSA device {id} does not support {} Hz, {} channel, {}-bit playback in exclusive mode",
                    spec.sample_rate, spec.channels, spec.bits_per_sample
                )
            };
            params.set_channels(spec.channels as u32).map_err(|_| unsupported())?;
            params.set_rate(spec.sample_rate, ValueOr::Nearest).map_err(|_| unsupported())?;
            if params.get_rate().ok() != Some(spec.sample_rate) {
                return Err(unsupported());
            }
            let format = candidates
                .iter()
                .copied()
                .find(|format| params.test_format(format.alsa()).is_ok())
                .ok_or_else(unsupported)?;
            params.set_format(format.alsa()).map_err(|error| alsa_error("ALSA format", error))?;
            Self::apply_buffer(&pcm, &params)?;
            format
        };
        Self::finish(pcm, spec, format, true)
    }

    fn apply_buffer(pcm: &PCM, params: &HwParams) -> Result<(), String> {
        let _ = params.set_buffer_time_near(BUFFER_MICROSECONDS, ValueOr::Nearest);
        let _ = params.set_period_time_near(PERIOD_MICROSECONDS, ValueOr::Nearest);
        pcm.hw_params(params)
            .map_err(|error| alsa_error("Could not apply ALSA hardware parameters", error))
    }

    fn finish(pcm: PCM, spec: StreamSpec, format: DeviceFormat, exclusive: bool) -> Result<Self, String> {
        let (buffer_frames, period_frames) = {
            let params = pcm
                .hw_params_current()
                .map_err(|error| alsa_error("Could not read ALSA parameters", error))?;
            (
                params.get_buffer_size().map_err(|error| alsa_error("ALSA buffer size", error))?
                    as usize,
                params.get_period_size().unwrap_or(1024).max(1) as usize,
            )
        };
        {
            // Playback starts as soon as the first samples arrive; `start` only gates writing.
            let sw = pcm
                .sw_params_current()
                .map_err(|error| alsa_error("Could not read ALSA software parameters", error))?;
            sw.set_start_threshold(1)
                .map_err(|error| alsa_error("ALSA start threshold", error))?;
            pcm.sw_params(&sw)
                .map_err(|error| alsa_error("Could not apply ALSA software parameters", error))?;
        }
        pcm.prepare().map_err(|error| alsa_error("Could not prepare ALSA playback", error))?;
        let period = Duration::from_secs_f64(period_frames as f64 / f64::from(spec.sample_rate));
        Ok(Self {
            pcm,
            format,
            channels: spec.channels,
            buffer_frames,
            poll_interval: (period / 2).clamp(Duration::from_millis(1), Duration::from_millis(10)),
            exclusive,
            started: false,
            bytes: Vec::with_capacity(buffer_frames * spec.channels * format.bytes_per_sample()),
        })
    }

    fn drop_queued(&mut self) -> Result<(), String> {
        let _ = self.pcm.drop();
        self.pcm
            .prepare()
            .map_err(|error| alsa_error("Could not prepare ALSA playback", error))
    }

    /// After an underrun (the song ended or the decoder fell behind) ALSA stops the stream
    /// and waits to be prepared again before it accepts more samples.
    fn recover_if_stopped(&mut self) -> Result<(), String> {
        match self.pcm.state() {
            State::XRun | State::Setup => self.drop_queued(),
            State::Suspended => {
                if self.pcm.resume().is_err() {
                    self.drop_queued()?;
                }
                Ok(())
            }
            State::Disconnected => Err("The ALSA output device was disconnected".to_owned()),
            _ => Ok(()),
        }
    }
}

impl Drop for PlatformOutput {
    fn drop(&mut self) {
        let _ = self.pcm.drop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> StreamSpec {
        StreamSpec { sample_rate: 48_000, channels: 2, bits_per_sample: 16, requantize: false }
    }

    #[test]
    fn exclusive_mode_requires_a_hardware_device() {
        for device in [None, Some("default")] {
            let error = PlatformOutput::open_device_with_mode(spec(), device, true, false).err();
            assert!(error.is_some_and(|error| error.contains("hardware output")));
        }
    }

    #[test]
    fn samples_encode_little_endian_at_the_device_depth() {
        let mut bytes = Vec::new();
        DeviceFormat::S16.encode(0.5, &mut bytes);
        DeviceFormat::S24Packed.encode(-1.0, &mut bytes);
        DeviceFormat::S24In32.encode(1.0, &mut bytes);
        assert_eq!(bytes, [0x00, 0x40, 0x00, 0x00, 0x80, 0xff, 0xff, 0x7f, 0x00]);
    }

    /// Plays a quiet half-second tone through the system mixer.
    #[test]
    #[ignore = "needs an audio device"]
    fn plays_through_the_default_device() {
        let devices = PlatformOutput::list_devices().unwrap();
        assert!(devices.iter().all(|device| device.id.starts_with("hw:")));
        for device in &devices { eprintln!("{} = {}", device.id, device.name); }
        let mut output = PlatformOutput::open(spec()).unwrap();
        output.start().unwrap();
        let samples: Vec<f64> = (0..24_000)
            .flat_map(|frame| {
                let value = (frame as f64 * 440.0 * std::f64::consts::TAU / 48_000.0).sin() * 0.05;
                [value, value]
            })
            .collect();
        let mut offset = 0;
        while offset < samples.len() {
            offset += output.write(&samples[offset..], &[]).unwrap() * 2;
        }
        assert!(output.queued_frames().unwrap() > 0);
        while !output.is_drained().unwrap() {}
    }

    /// Opens `AMBRA_ALSA_DEVICE` (a `hw:` id) exclusively without playing anything.
    #[test]
    #[ignore = "needs an idle hardware device"]
    fn opens_a_hardware_device_exclusively() {
        let Ok(id) = std::env::var("AMBRA_ALSA_DEVICE") else { return };
        let output = PlatformOutput::open_device_with_mode(spec(), Some(&id), true, false).unwrap();
        assert_eq!(output.quantization_bits(), Some(16));
    }
}
