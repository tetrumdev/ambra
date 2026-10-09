use super::dsp::DspPreset;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub exclusive_mode: bool,
    pub preset_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    pub version: u32,
    pub selected_output_id: String,
    pub outputs: Vec<OutputSettings>,
    pub presets: Vec<DspPreset>,
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
                preset_id: None,
            }],
            presets: Vec::new(),
        }
    }
}
impl AudioSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.outputs.len() > 256 || self.presets.len() > 64 {
            return Err("Unsupported or oversized audio settings".into());
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
        let settings: Self =
            serde_json::from_slice(&bytes).map_err(|e| format!("Invalid audio settings: {e}"))?;
        settings.validate()?;
        Ok(settings)
    }
    pub fn save(&self, directory: &Path) -> Result<(), String> {
        self.validate()?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        crate::write_file_atomic(&directory.join("audio-settings.json"), &bytes)
    }
    pub fn discover(&mut self, devices: &[super::NativeAudioDevice]) {
        for device in devices {
            if !self.outputs.iter().any(|o| o.id == device.id) {
                self.outputs.push(OutputSettings {
                    id: device.id.clone(),
                    name: device.name.clone(),
                    enabled: true,
                    exclusive_mode: false,
                    preset_id: None,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_output_visibility_assignments_and_offline_devices() {
        let directory =
            std::env::temp_dir().join(format!("ambra-audio-settings-test-{}", std::process::id()));
        let mut settings = AudioSettings::default();
        settings.presets.push(DspPreset {
            id: "headphones".into(),
            name: "Headphones".into(),
            enabled: true,
            headroom_db: 3.0,
            output_gain_db: 0.0,
            bands: vec![],
            convolution: vec![],
        });
        settings.outputs.push(OutputSettings {
            id: "dac".into(),
            name: "My DAC".into(),
            enabled: false,
            exclusive_mode: true,
            preset_id: Some("headphones".into()),
        });
        settings.save(&directory).unwrap();
        let mut restored = AudioSettings::load(&directory).unwrap();
        restored.discover(&[]);
        assert_eq!(settings, restored);
        restored.outputs[1].preset_id = Some("missing".into());
        assert!(restored.save(&directory).is_err());
        assert_eq!(AudioSettings::load(&directory).unwrap(), settings);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
