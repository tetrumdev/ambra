use super::{NativeAudioDevice, StreamSpec};

pub trait AudioOutput {
    fn list_devices() -> Result<Vec<NativeAudioDevice>, String> {
        Err("Native audio device enumeration is not connected to this platform yet".to_owned())
    }

    fn open(spec: StreamSpec) -> Result<Self, String>
    where
        Self: Sized;

    fn start(&mut self) -> Result<(), String>;
    fn pause(&mut self) -> Result<(), String>;
    fn reset(&mut self) -> Result<(), String>;
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

#[cfg(test)]
mod tests {
    use super::normalized_to_signed;

    #[test]
    fn exactly_restores_normalized_integer_samples() {
        assert_eq!(normalized_to_signed(-1.0, 16), i16::MIN as i64);
        assert_eq!(
            normalized_to_signed(32_767.0 / 32_768.0, 16),
            i16::MAX as i64
        );
        assert_eq!(
            normalized_to_signed(2_147_483_647.0 / 2_147_483_648.0, 32),
            i32::MAX as i64
        );
    }
}

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub use windows::PlatformOutput;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::PlatformOutput;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub struct PlatformOutput;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl AudioOutput for PlatformOutput {
    fn open(_spec: StreamSpec) -> Result<Self, String> {
        Err("Native audio playback is only available on Windows and macOS".to_owned())
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
