//! Exact transport conversion for the Windows capture format, testable without WASAPI.
use crate::soloist::{Error, ErrorCode};

pub(super) fn float_pcm(samples: &[f32]) -> Result<Vec<u8>, Error> {
    if samples.len() % 2 != 0 || samples.len() > crate::live_pcm::MAX_CHUNK / 4 {
        return Err(invalid(
            "WASAPI returned an incomplete or oversized stereo packet",
        ));
    }
    let mut result = Vec::with_capacity(samples.len() * 4);
    for &sample in samples {
        if !sample.is_finite() {
            return Err(invalid("WASAPI returned nonfinite PCM"));
        }
        let value = (f64::from(sample).clamp(-1.0, 1.0) * 2_147_483_648.0)
            .round()
            .clamp(i32::MIN as f64, i32::MAX as f64) as i32;
        result.extend_from_slice(&value.to_le_bytes());
    }
    Ok(result)
}

fn invalid(message: &str) -> Error {
    Error::new(ErrorCode::CaptureUnavailable, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversion_preserves_24_bit_samples_and_channel_order() {
        for left in [
            -(1 << 23),
            -(1 << 22),
            -12345,
            -1,
            0,
            1,
            12345,
            (1 << 23) - 1,
        ] {
            let right = -left - 1;
            let bytes =
                float_pcm(&[left as f32 / 8_388_608.0, right as f32 / 8_388_608.0]).unwrap();
            assert_eq!(
                i32::from_le_bytes(bytes[..4].try_into().unwrap()),
                left << 8
            );
            assert_eq!(
                i32::from_le_bytes(bytes[4..].try_into().unwrap()),
                right << 8
            );
        }
    }

    #[test]
    fn conversion_clips_and_rejects_invalid_or_unbounded_packets() {
        let bytes = float_pcm(&[-2.0, 2.0, -1.0, 1.0, 0.0, 0.5]).unwrap();
        let values: Vec<_> = bytes
            .chunks_exact(4)
            .map(|sample| i32::from_le_bytes(sample.try_into().unwrap()))
            .collect();
        assert_eq!(values, [i32::MIN, i32::MAX, i32::MIN, i32::MAX, 0, 1 << 30]);
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(float_pcm(&[value, 0.0]).is_err());
        }
        assert!(float_pcm(&[0.0]).is_err());
        assert!(float_pcm(&vec![0.0; crate::live_pcm::MAX_CHUNK / 4 + 2]).is_err());
    }
}
