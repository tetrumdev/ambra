//! Final requantization of processed PCM to the device's integer resolution.

/// Triangular-PDF dither. Processed samples land exactly on the device's integer grid, so
/// no later conversion rounds them again, and the rounding error becomes signal-independent
/// noise instead of distortion. Untouched audio never passes through here.
pub struct Dither {
    state: u64,
}

impl Default for Dither {
    fn default() -> Self {
        Self {
            state: 0x9E37_79B9_7F4A_7C15,
        }
    }
}

impl Dither {
    pub fn quantize(&mut self, samples: &mut [f64], bits: u32) {
        for sample in samples {
            *sample = self.quantize_sample(*sample, bits);
        }
    }

    pub fn quantize_sample(&mut self, sample: f64, bits: u32) -> f64 {
        let scale = (1_u64 << (bits - 1)) as f64;
        // The difference of two uniform values spans ±1 LSB with a triangular density.
        let noise = self.uniform() - self.uniform();
        (sample * scale + noise).round().clamp(-scale, scale - 1.0) / scale
    }

    /// Uniform in [0, 1), from xorshift64*.
    fn uniform(&mut self) -> f64 {
        self.state ^= self.state >> 12;
        self.state ^= self.state << 25;
        self.state ^= self.state >> 27;
        (self.state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1_u64 << 53) as f64
    }
}
