use super::{
    dsp::DspPreset,
    loudness::{NormalizationMode, REFERENCE_LUFS, TARGET_LUFS_RANGE},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub exclusive_mode: bool,
    #[serde(default)]
    pub resync_delay_ms: u32,
    pub preset_id: Option<String>,
    #[serde(default = "default_volume")]
    pub volume: f64,
}

fn default_volume() -> f64 {
    100.0
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    pub version: u32,
    pub selected_output_id: String,
    pub outputs: Vec<OutputSettings>,
    pub presets: Vec<DspPreset>,
    /// Settings saved before normalization existed leave it off.
    #[serde(default)]
    pub normalization: NormalizationMode,
    /// The integrated loudness songs are brought to; ReplayGain's own reference by default.
    #[serde(default = "default_target_lufs")]
    pub normalization_target_lufs: f64,
}

fn default_target_lufs() -> f64 {
    REFERENCE_LUFS
}
impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            version: 1,
            selected_output_id: String::new(),
            outputs: vec![OutputSettings {
                id: String::new(),
                name: "System Default".into(),
                enabled: true,
                exclusive_mode: false,
                resync_delay_ms: 0,
                preset_id: None,
                volume: default_volume(),
            }],
            presets: Vec::new(),
            normalization: NormalizationMode::Off,
            normalization_target_lufs: default_target_lufs(),
        }
    }
}
impl AudioSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.outputs.len() > 256 || self.presets.len() > 64 {
            return Err("Unsupported or oversized audio settings".into());
        }
        if !self.normalization_target_lufs.is_finite()
            || !TARGET_LUFS_RANGE.contains(&self.normalization_target_lufs)
        {
            return Err(format!(
                "Normalization target must be between {} and {} LUFS",
                TARGET_LUFS_RANGE.start(),
                TARGET_LUFS_RANGE.end()
            ));
        }
        let mut ids = HashSet::new();
        for preset in &self.presets {
            preset.validate()?;
            if !ids.insert(&preset.id) {
                return Err("DSP preset IDs must be unique".into());
            }
        }
        let mut outputs = HashSet::new();
        for output in &self.outputs {
            if !outputs.insert(&output.id)
                || output.id.len() > 1024
                || output.name.trim().is_empty()
                || output.name.len() > 200
            {
                return Err("Output IDs must be unique and each output needs a name".into());
            }
            if output.resync_delay_ms > 10_000 {
                return Err("Resync delay must be between 0 and 10000 ms".into());
            }
            if !output.volume.is_finite() || !(0.0..=100.0).contains(&output.volume) {
                return Err("Output volume must be between 0 and 100".into());
            }
            if output
                .preset_id
                .as_ref()
                .is_some_and(|id| !ids.contains(id))
            {
                return Err("An output refers to a DSP preset that no longer exists".into());
            }
        }
        if !outputs.contains(&String::new()) || !outputs.contains(&self.selected_output_id) {
            return Err(
                "Audio settings must include System Default and the selected output".into(),
            );
        }
        Ok(())
    }
    pub fn selected(&self) -> &OutputSettings {
        self.outputs
            .iter()
            .find(|o| o.id == self.selected_output_id)
            .unwrap_or(&self.outputs[0])
    }
    pub fn preset(&self) -> Option<&DspPreset> {
        self.selected()
            .preset_id
            .as_ref()
            .and_then(|id| self.presets.iter().find(|p| &p.id == id))
    }
    pub fn load(directory: &Path) -> Result<Self, String> {
        let path = directory.join("audio-settings.json");
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(format!("Could not read audio settings: {e}")),
        };
        let mut value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("Invalid audio settings: {e}"))?;
        fold_output_gain(&mut value);
        let settings: Self =
            serde_json::from_value(value).map_err(|e| format!("Invalid audio settings: {e}"))?;
        settings.validate()?;
        Ok(settings)
    }
    pub fn save(&self, directory: &Path) -> Result<(), String> {
        self.validate()?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        crate::write_file_atomic(&directory.join("audio-settings.json"), &bytes)
    }
    pub fn discover(&mut self, devices: &[super::NativeAudioDevice]) {
        // CoreAudio outputs were once saved by their number, which changes on every reconnect;
        // they are UIDs now, and the numbered entries could never be found again.
        if cfg!(target_os = "macos") {
            let numbered = |id: &str| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit());
            if numbered(&self.selected_output_id) {
                self.selected_output_id.clear();
            }
            self.outputs.retain(|output| !numbered(&output.id));
        }
        for device in devices {
            if !self.outputs.iter().any(|o| o.id == device.id) {
                self.outputs.push(OutputSettings {
                    id: device.id.clone(),
                    name: device.name.clone(),
                    enabled: true,
                    exclusive_mode: false,
                    resync_delay_ms: 0,
                    preset_id: None,
                    volume: default_volume(),
                });
            }
        }
    }
}

/// Presets once had an output gain after the EQ, which only ever undid headroom; it becomes less headroom.
fn fold_output_gain(value: &mut serde_json::Value) {
    let Some(presets) = value.get_mut("presets").and_then(|p| p.as_array_mut()) else {
        return;
    };
    for preset in presets.iter_mut().filter_map(|p| p.as_object_mut()) {
        let Some(gain) = preset.remove("outputGainDb").and_then(|g| g.as_f64()) else {
            continue;
        };
        if let Some(headroom) = preset.get("headroomDb").and_then(|h| h.as_f64()) {
            preset.insert(
                "headroomDb".into(),
                (headroom - gain).clamp(0.0, 30.0).into(),
            );
        }
    }
}
