use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackBackend {
    #[default]
    Librespot,
    Soloist,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    Normal,
    High,
    VeryHigh,
    #[default]
    Lossless,
}

impl Quality {
    pub fn preference(self) -> u8 {
        match self {
            Self::Normal => 2,
            Self::High => 3,
            Self::VeryHigh => 4,
            Self::Lossless => 5,
        }
    }
}

/// Server-owned consent. Legacy paths are read only to import existing installations.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub lossless_enabled: bool,
    pub download_consent: bool,
    #[serde(alias = "executable", skip_serializing_if = "Option::is_none")]
    pub migration_executable: Option<PathBuf>,
}

impl Config {
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        match std::fs::read(path) {
            Ok(bytes) => {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&bytes).map_err(|_| {
                        "Invalid Soloist settings; repair spotify-playback.json".to_owned()
                    })?;
                if let Some(fields) = value.as_object_mut() {
                    if let Some(backend) = fields.remove("backend") {
                        fields
                            .entry("losslessEnabled")
                            .or_insert(serde_json::json!(backend == "soloist"));
                    }
                    for old in ["quality", "updateChecks", "fallback"] {
                        fields.remove(old);
                    }
                }
                serde_json::from_value(value)
                    .map_err(|_| "Invalid Soloist settings; repair spotify-playback.json".into())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("Could not read Soloist settings".into()),
        }
    }

    pub fn save(&self, path: &std::path::Path) -> Result<(), String> {
        crate::server_config::write_private(
            path,
            &serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?,
        )
    }
}

/// Secrets deliberately have neither Debug nor Serialize.
pub struct ApiKey(String);

impl ApiKey {
    pub fn parse(value: String) -> Result<Self, String> {
        let value = value.trim();
        if !(8..=4096).contains(&value.len())
            || value.chars().any(char::is_whitespace)
            || value.chars().any(char::is_control)
        {
            return Err("The Soloist API key must contain 8–4096 non-whitespace characters".into());
        }
        Ok(Self(value.to_owned()))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    pub fn redact(&self, text: &str) -> String {
        text.replace(&self.0, "[redacted]")
            .chars()
            .filter(|c| !c.is_control() || *c == '\t')
            .take(1024)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_require_explicit_download_consent() {
        let config = Config::default();
        assert!(!config.lossless_enabled);
        assert!(!config.download_consent);
    }
    #[test]
    fn key_is_redacted_before_truncation() {
        let key = ApiKey::parse("personal-secret-key".into()).unwrap();
        let log = key.redact("\u{1b} argv --api-key personal-secret-key\r\n");
        assert!(!log.contains("personal-secret-key"));
        assert!(!log.contains('\u{1b}'));
        assert!(ApiKey::parse("bad\nkey".into()).is_err());
    }
}
