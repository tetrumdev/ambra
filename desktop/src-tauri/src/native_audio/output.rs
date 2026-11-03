use super::{NativeAudioDevice, StreamSpec};

pub trait AudioOutput {
    fn list_devices() -> Result<Vec<NativeAudioDevice>, String> {
        Err("Native audio device enumeration is not connected to this platform yet".to_owned())
    }

    fn open(spec: StreamSpec) -> Result<Self, String>
    where
        Self: Sized;

    fn open_device(spec: StreamSpec, device_id: Option<&str>) -> Result<Self, String>
    where
        Self: Sized,
    {
        match device_id {
            Some(_) => {
                Err("Selecting an audio device is not supported on this platform".to_owned())
            }
            None => Self::open(spec),
        }
    }

    /// `processed` means DSP will change the samples, so an exclusive stream asks for the
    /// device's widest integer format instead of the source's own bit depth.
    fn open_device_with_mode(
        spec: StreamSpec,
        device_id: Option<&str>,
        exclusive_mode: bool,
        _processed: bool,
    ) -> Result<Self, String>
    where
        Self: Sized,
    {
        if !exclusive_mode {
            return Err(
                "Shared native audio playback is not supported on this platform".to_owned(),
            );
        }
        Self::open_device(spec, device_id)
    }

    fn start(&mut self) -> Result<(), String>;
    fn pause(&mut self) -> Result<(), String>;
    fn reset(&mut self) -> Result<(), String>;
    fn set_gain(&mut self, _gain: f64) -> Result<(), String> {
        Ok(())
    }
    /// Integer resolution the device itself receives, which processed audio is dithered to.
    /// None when the path ends in floating point and needs no requantization.
    fn quantization_bits(&self) -> Option<u32> {
        None
    }
    /// Closes an output that is done for now (paused long enough, the queue ended, or playback
    /// failed), as opposed to one replaced by a new stream at once.
    fn hand_back(self)
    where
        Self: Sized,
    {
    }
    fn write(&mut self, first: &[f64], second: &[f64]) -> Result<usize, String>;
    fn queued_frames(&mut self) -> Result<usize, String>;
    fn is_drained(&mut self) -> Result<bool, String>;
}

fn normalized_to_signed(sample: f64, bits: u32) -> i64 {
    let scale = (1_u64 << (bits - 1)) as f64;
    (sample.clamp(-1.0, 1.0) * scale)
        .round()
        .clamp(-scale, scale - 1.0) as i64
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn writable_frames(available_frames: usize, sample_count: usize, channels: usize) -> usize {
    available_frames.min(sample_count / channels)
}


#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub use windows::PlatformOutput;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::PlatformOutput;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
mod reservation;

#[cfg(target_os = "linux")]
pub use linux::PlatformOutput;

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub struct PlatformOutput;

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
impl AudioOutput for PlatformOutput {
    fn open(_spec: StreamSpec) -> Result<Self, String> {
        Err("Native audio playback is only available on Windows, macOS and Linux".to_owned())
    }

    fn start(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn pause(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn reset(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn write(&mut self, _first: &[f64], _second: &[f64]) -> Result<usize, String> {
        Ok(0)
    }

    fn queued_frames(&mut self) -> Result<usize, String> {
        Ok(0)
    }

    fn is_drained(&mut self) -> Result<bool, String> {
        Ok(true)
    }
}
