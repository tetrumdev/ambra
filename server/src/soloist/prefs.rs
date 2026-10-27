//! Compatibility boundary for undocumented preferences. References: Soloist 1.3.7 and 1.3.10.
//! Refuse unknown versions rather than silently applying normalization or a lossy tier.
use super::{Error, ErrorCode, config::Quality};
use std::path::Path;

const KEYS: &[&str] = &[
    "audio.crossfade_v2",
    "audio.crossfade.time_v2",
    "audio.normalize_v2",
    "audio.play_bitrate_enumeration",
    "audio.play_bitrate_non_metered_enumeration",
    "audio.play_bitrate_non_metered_migrated",
];

pub fn render(existing: &str, version: &str, quality: Quality) -> Result<String, Error> {
    // Official 1.3.10.20 archives retain the 1.3.7 preference keys on all five targets.
    // Keep an explicit family allowlist: CLI compatibility alone cannot prove that an
    // unknown engine still honors the undocumented quality enumeration.
    let supported = version.len() <= 64
        && matches!(version.split('.').collect::<Vec<_>>().as_slice(),
            ["1", "3", "7" | "10", revision]
                if !revision.is_empty() && revision.bytes().all(|c| c.is_ascii_digit()));
    if !supported {
        return Err(Error::new(
            ErrorCode::UnsupportedVersion,
            "Soloist audio preferences support only verified 1.3.7.* and 1.3.10.* builds; preserving Librespot playback until Ambra supports this version",
        ));
    }
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|line| !KEYS.contains(&line.split('=').next().unwrap_or("").trim()))
        .map(str::to_owned)
        .collect();
    lines.extend([
        "audio.crossfade_v2=false".to_owned(),
        "audio.normalize_v2=false".to_owned(),
        format!("audio.play_bitrate_enumeration={}", quality.preference()),
        format!(
            "audio.play_bitrate_non_metered_enumeration={}",
            quality.preference()
        ),
        "audio.play_bitrate_non_metered_migrated=true".to_owned(),
    ]);
    Ok(lines.join("\n") + "\n")
}

pub fn write(data: &Path, version: &str, quality: Quality) -> Result<(), Error> {
    let settings = data.join("settings");
    let mut stores = vec![settings.join("prefs")];
    let users = settings.join("Users");
    if users.exists() {
        for entry in std::fs::read_dir(users).map_err(Error::io)? {
            let entry = entry.map_err(Error::io)?;
            if entry.file_type().map_err(Error::io)?.is_dir() {
                stores.push(entry.path().join("prefs"));
            }
        }
    }
    for store in stores {
        let existing = match std::fs::read_to_string(&store) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(Error::io(e)),
        };
        let text = render(&existing, version, quality)?;
        crate::server_config::write_private(&store, text.as_bytes()).map_err(Error::storage)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_official_family_uses_existing_audio_preferences() {
        for version in ["1.3.10.20", "1.3.10.21", "1.3.7.349"] {
            for quality in [
                Quality::Normal,
                Quality::High,
                Quality::VeryHigh,
                Quality::Lossless,
            ] {
                let text = render("session.opaque=keep\n", version, quality).unwrap();
                assert!(text.contains("session.opaque=keep\n"));
                assert!(text.contains("audio.normalize_v2=false\n"));
                assert!(text.contains("audio.crossfade_v2=false\n"));
                for key in [
                    "audio.play_bitrate_enumeration",
                    "audio.play_bitrate_non_metered_enumeration",
                ] {
                    assert!(text.contains(&format!("{key}={}\n", quality.preference())));
                }
                assert_eq!(render(&text, version, quality).unwrap(), text);
            }
        }
    }

    #[test]
    fn unknown_or_malformed_versions_fail_closed() {
        for version in [
            "1.3.8.1",
            "1.3.9.1",
            "1.3.11.1",
            "1.4.0.0",
            "2.3.10.20",
            "1.3.10",
            "1.3.10.20-beta",
            "1.3.7.bad",
            "1.3.7.349.extra",
        ] {
            assert_eq!(
                render("", version, Quality::Lossless).unwrap_err().code,
                ErrorCode::UnsupportedVersion,
                "{version}"
            );
        }
    }
    #[test]
    fn v_1_3_7_preserves_session_keys_and_disables_double_normalization() {
        let text = render(
            "session.opaque=keep\naudio.normalize_v2=true\naudio.crossfade.time_v2=3000\n",
            "1.3.7.349",
            Quality::Lossless,
        )
        .unwrap();
        assert!(text.contains("session.opaque=keep\n"));
        assert!(text.contains("audio.normalize_v2=false\n"));
        assert!(!text.contains("time_v2="));
        assert!(text.contains("audio.play_bitrate_non_metered_enumeration=5\n"));
        assert_eq!(render(&text, "1.3.7.349", Quality::Lossless).unwrap(), text);
        assert!(render("", "1.4.0.0", Quality::Lossless).is_err());
    }
}
