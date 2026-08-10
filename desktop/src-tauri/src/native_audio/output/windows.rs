use std::{thread, time::Duration};

use wasapi::{
    AudioClient, AudioRenderClient, DeviceEnumerator, Direction, SampleType, StreamMode,
    WasapiError, WaveFormat, calculate_period_100ns, deinitialize, initialize_mta,
};

use super::{AudioOutput, StreamSpec, normalized_to_signed};

const POLLING_BUFFER_PERIODS: i64 = 8;

#[derive(Clone, Copy)]
enum DeviceSampleFormat {
    Signed16,
    Signed24Packed,
    Signed24In32,
    Signed32,
    Float32,
}

impl DeviceSampleFormat {
    fn wave_format(self, spec: StreamSpec) -> WaveFormat {
        let channels = spec.channels;
        match self {
            Self::Signed16 => WaveFormat::new(
                16,
                16,
                &SampleType::Int,
                spec.sample_rate as usize,
                channels,
                None,
            ),
            Self::Signed24Packed => WaveFormat::new(
                24,
                24,
                &SampleType::Int,
                spec.sample_rate as usize,
                channels,
                None,
            ),
            Self::Signed24In32 => WaveFormat::new(
                32,
                24,
                &SampleType::Int,
                spec.sample_rate as usize,
                channels,
                None,
            ),
            Self::Signed32 => WaveFormat::new(
                32,
                32,
                &SampleType::Int,
                spec.sample_rate as usize,
                channels,
                None,
            ),
            Self::Float32 => WaveFormat::new(
                32,
                32,
                &SampleType::Float,
                spec.sample_rate as usize,
                channels,
                None,
            ),
        }
    }

    fn bytes_per_sample(self) -> usize {
        match self {
            Self::Signed16 => 2,
            Self::Signed24Packed => 3,
            Self::Signed24In32 | Self::Signed32 | Self::Float32 => 4,
        }
    }
}

pub struct PlatformOutput {
    audio_client: AudioClient,
    render_client: AudioRenderClient,
    spec: StreamSpec,
    sample_format: DeviceSampleFormat,
    conversion_buffer: Vec<u8>,
    poll_interval: Duration,
    started: bool,
}

impl AudioOutput for PlatformOutput {
    fn open(spec: StreamSpec) -> Result<Self, String> {
        initialize_mta().ok().map_err(wasapi_error)?;
        let result = Self::open_initialized(spec);
        if result.is_err() {
            deinitialize();
        }
        result
    }

    fn start(&mut self) -> Result<(), String> {
        if !self.started {
            self.audio_client.start_stream().map_err(wasapi_error)?;
            self.started = true;
        }
        Ok(())
    }

    fn pause(&mut self) -> Result<(), String> {
        if self.started {
            self.audio_client.stop_stream().map_err(wasapi_error)?;
            self.started = false;
        }
        Ok(())
    }

    fn reset(&mut self) -> Result<(), String> {
        self.pause()?;
        self.audio_client.reset_stream().map_err(wasapi_error)?;
        Ok(())
    }

    fn write(&mut self, first: &[f64], second: &[f64]) -> Result<usize, String> {
        if first.is_empty() && second.is_empty() {
            return Ok(0);
        }
        if !self.started {
            return Ok(0);
        }
        let available_frames = self
            .audio_client
            .get_available_space_in_frames()
            .map_err(wasapi_error)? as usize;
        if available_frames == 0 {
            thread::sleep(self.poll_interval);
            return Ok(0);
        }
        let frames = available_frames.min((first.len() + second.len()) / self.spec.channels);
        let sample_count = frames * self.spec.channels;
        encode_sample_slices(
            first,
            second,
            sample_count,
            self.sample_format,
            &mut self.conversion_buffer,
        );
        let device_sample_count = available_frames * self.spec.channels;
        self.conversion_buffer.resize(
            device_sample_count * self.sample_format.bytes_per_sample(),
            0,
        );
        self.render_client
            .write_to_device(available_frames, &self.conversion_buffer, None)
            .map_err(wasapi_error)?;
        Ok(frames)
    }

    fn queued_frames(&mut self) -> Result<usize, String> {
        self.audio_client
            .get_current_padding()
            .map(|frames| frames as usize)
            .map_err(wasapi_error)
    }

    fn is_drained(&mut self) -> Result<bool, String> {
        let padding = self
            .audio_client
            .get_current_padding()
            .map_err(wasapi_error)?;
        if padding == 0 {
            Ok(true)
        } else {
            thread::sleep(self.poll_interval);
            Ok(false)
        }
    }
}

impl PlatformOutput {
    fn open_initialized(spec: StreamSpec) -> Result<Self, String> {
        let enumerator = DeviceEnumerator::new().map_err(wasapi_error)?;
        let device = enumerator
            .get_default_device(&Direction::Render)
            .map_err(wasapi_error)?;
        let mut audio_client = device.get_iaudioclient().map_err(wasapi_error)?;
        let (sample_format, wave_format) = supported_format(&audio_client, spec)?;
        let (default_period, minimum_period) =
            audio_client.get_device_period().map_err(wasapi_error)?;
        let period = audio_client
            .calculate_aligned_period_near(
                default_period.max(minimum_period),
                Some(128),
                &wave_format,
            )
            .map_err(wasapi_error)?;
        let mode = polling_mode(period);
        if let Err(error) = audio_client.initialize_client(&wave_format, &Direction::Render, &mode)
        {
            if wasapi_hresult(&error) == Some(0x8889_0019) {
                let buffer_frames = audio_client.get_buffer_size().map_err(wasapi_error)?;
                let aligned_period = calculate_period_100ns(
                    i64::from(buffer_frames),
                    wave_format.get_samplespersec() as i64,
                );
                audio_client = device.get_iaudioclient().map_err(wasapi_error)?;
                audio_client
                    .initialize_client(
                        &wave_format,
                        &Direction::Render,
                        &polling_mode(aligned_period),
                    )
                    .map_err(exclusive_mode_error)?;
            } else {
                return Err(exclusive_mode_error(error));
            }
        }
        let render_client = audio_client.get_audiorenderclient().map_err(wasapi_error)?;
        let buffer_frames = audio_client.get_buffer_size().map_err(wasapi_error)? as usize;
        let poll_interval =
            Duration::from_secs_f64(buffer_frames as f64 / f64::from(spec.sample_rate) / 4.0)
                .max(Duration::from_millis(1));

        Ok(Self {
            audio_client,
            render_client,
            spec,
            sample_format,
            conversion_buffer: Vec::with_capacity(
                buffer_frames * spec.channels * sample_format.bytes_per_sample(),
            ),
            poll_interval,
            started: false,
        })
    }
}

impl Drop for PlatformOutput {
    fn drop(&mut self) {
        let _ = self.pause();
        deinitialize();
    }
}

fn supported_format(
    audio_client: &AudioClient,
    spec: StreamSpec,
) -> Result<(DeviceSampleFormat, WaveFormat), String> {
    let candidates: &[DeviceSampleFormat] = match spec.bits_per_sample {
        0..=16 => &[
            DeviceSampleFormat::Signed16,
            DeviceSampleFormat::Signed24In32,
            DeviceSampleFormat::Signed32,
            DeviceSampleFormat::Float32,
        ],
        17..=24 => &[
            DeviceSampleFormat::Signed24In32,
            DeviceSampleFormat::Signed24Packed,
            DeviceSampleFormat::Signed32,
            DeviceSampleFormat::Float32,
        ],
        _ => &[DeviceSampleFormat::Signed32],
    };
    for candidate in candidates {
        let requested = candidate.wave_format(spec);
        if let Ok(supported) = audio_client.is_supported_exclusive_with_quirks(&requested)
            && supported.get_samplespersec() == spec.sample_rate
            && usize::from(supported.get_nchannels()) == spec.channels
            && supported.get_bitspersample() as usize == candidate.bytes_per_sample() * 8
            && supported.get_blockalign() as usize == spec.channels * candidate.bytes_per_sample()
        {
            return Ok((*candidate, supported));
        }
    }

    Err(format!(
        "The default audio device does not support {} Hz, {} channel, {}-bit playback in WASAPI exclusive mode",
        spec.sample_rate, spec.channels, spec.bits_per_sample
    ))
}

fn polling_mode(period_hns: i64) -> StreamMode {
    StreamMode::PollingExclusive {
        period_hns,
        buffer_duration_hns: period_hns.saturating_mul(POLLING_BUFFER_PERIODS),
    }
}

fn encode_sample_slices(
    first: &[f64],
    second: &[f64],
    sample_count: usize,
    format: DeviceSampleFormat,
    output: &mut Vec<u8>,
) {
    output.clear();
    output.reserve(sample_count * format.bytes_per_sample());
    let first_count = first.len().min(sample_count);
    append_samples(&first[..first_count], format, output);
    let remaining = sample_count - first_count;
    append_samples(&second[..remaining], format, output);
}

fn append_samples(samples: &[f64], format: DeviceSampleFormat, output: &mut Vec<u8>) {
    match format {
        DeviceSampleFormat::Float32 => {
            for sample in samples {
                output.extend_from_slice(&(*sample as f32).to_le_bytes());
            }
        }
        DeviceSampleFormat::Signed16 => {
            for sample in samples {
                let value = normalized_to_signed(*sample, 16) as i16;
                output.extend_from_slice(&value.to_le_bytes());
            }
        }
        DeviceSampleFormat::Signed24Packed => {
            for sample in samples {
                let value = normalized_to_signed(*sample, 24) as i32;
                let bytes = value.to_le_bytes();
                output.extend_from_slice(&bytes[..3]);
            }
        }
        DeviceSampleFormat::Signed24In32 => {
            for sample in samples {
                let value = (normalized_to_signed(*sample, 24) as i32) << 8;
                output.extend_from_slice(&value.to_le_bytes());
            }
        }
        DeviceSampleFormat::Signed32 => {
            for sample in samples {
                let value = normalized_to_signed(*sample, 32) as i32;
                output.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
}

fn wasapi_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn wasapi_hresult(error: &WasapiError) -> Option<u32> {
    match error {
        WasapiError::Windows(error) => Some(error.code().0 as u32),
        _ => None,
    }
}

fn exclusive_mode_error(error: WasapiError) -> String {
    let detail = match wasapi_hresult(&error) {
        Some(0x8889_000A) => {
            "The audio device is already reserved by another exclusive-mode application"
        }
        Some(0x8889_000E) => "Exclusive mode is disabled for the selected Windows audio device",
        Some(0x8889_0008) => "The selected Windows audio device rejected the stream format",
        Some(0x8889_0004) => "The selected Windows audio device was disconnected",
        Some(0x8889_000F) => "Windows could not create the selected audio endpoint",
        _ => return format!("Could not open the audio device in WASAPI exclusive mode: {error}"),
    };
    format!("Could not open the audio device in WASAPI exclusive mode: {detail}")
}

#[cfg(test)]
mod tests {
    use super::{
        AudioOutput, DeviceSampleFormat, PlatformOutput, StreamSpec, encode_sample_slices,
    };

    #[test]
    fn encodes_silence_without_allocating_values() {
        let mut output = Vec::new();
        encode_sample_slices(
            &[0.0],
            &[0.0],
            2,
            DeviceSampleFormat::Signed24Packed,
            &mut output,
        );
        assert_eq!(output, [0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn encodes_full_scale_signed_sixteen_bit_samples() {
        let mut output = Vec::new();
        encode_sample_slices(
            &[-1.0],
            &[1.0],
            2,
            DeviceSampleFormat::Signed16,
            &mut output,
        );
        assert_eq!(output, [0, 128, 255, 127]);
    }

    #[test]
    #[ignore = "requires a Windows audio endpoint"]
    fn opens_and_services_the_default_exclusive_endpoint() {
        let spec = StreamSpec {
            sample_rate: 48_000,
            channels: 2,
            bits_per_sample: 24,
        };
        let mut output = PlatformOutput::open(spec).unwrap();
        let silence = vec![0.0; 4_800 * spec.channels];
        output.start().unwrap();
        let mut offset = 0;
        while offset < silence.len() {
            let frames = output.write(&silence[offset..], &[]).unwrap();
            offset += frames * spec.channels;
        }
        output.reset().unwrap();
    }
}
