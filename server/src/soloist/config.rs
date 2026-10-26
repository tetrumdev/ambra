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

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Fallback {
    #[default]
    Never,
    LibrespotBeforeStart,
}

/// Additive configuration; credentials are never serialized into this file or status.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub backend: PlaybackBackend,
    pub executable: Option<PathBuf>,
    pub quality: Quality,
    pub update_checks: bool,
    pub fallback: Fallback,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            backend: PlaybackBackend::Librespot,
            executable: None,
            quality: Quality::Lossless,
            update_checks: true,
            fallback: Fallback::Never,
        }
    }
}

impl Config {
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "Invalid Soloist settings; repair spotify-playback.json".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self {
                update_checks: true,
                ..Self::default()
            }),
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
    fn old_settings_and_defaults_keep_librespot() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(config.backend, PlaybackBackend::Librespot);
        assert_eq!(config.quality, Quality::Lossless);
        assert_eq!(config.fallback, Fallback::Never);
        assert!(serde_json::from_str::<Config>(r#"{"automaticUpdates":true}"#).is_err());
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
