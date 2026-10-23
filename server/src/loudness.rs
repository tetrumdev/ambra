//! Each stream's loudness, reported to the desktop player in a response header so it can
//! normalize volume without a separate request. Gains are ReplayGain 2.0 values (-18 LUFS).
use axum::http::{HeaderMap, HeaderValue};

pub const LOUDNESS_HEADER: &str = "x-ambra-loudness";

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Loudness {
    pub track_gain_db: Option<f64>,
    pub track_peak: Option<f64>,
    pub album_gain_db: Option<f64>,
    pub album_peak: Option<f64>,
}

impl Loudness {
    pub fn is_known(&self) -> bool {
        self.track_gain_db.is_some() || self.album_gain_db.is_some()
    }

    fn header_value(&self) -> Option<HeaderValue> {
        if !self.is_known() {
            return None;
        }
        let parts = [
            ("track", self.track_gain_db),
            ("track-peak", self.track_peak),
            ("album", self.album_gain_db),
            ("album-peak", self.album_peak),
        ]
        .into_iter()
        .filter_map(|(key, value)| {
            value
                .filter(|value| value.is_finite())
                .map(|value| format!("{key}={value}"))
        })
        .collect::<Vec<_>>();
        HeaderValue::from_str(&parts.join(";")).ok()
    }

    pub fn insert_into(&self, headers: &mut HeaderMap) {
        if let Some(value) = self.header_value() {
            headers.insert(LOUDNESS_HEADER, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_values_are_reported() {
        let mut headers = HeaderMap::new();
        Loudness::default().insert_into(&mut headers);
        assert!(headers.is_empty());
        Loudness {
            track_gain_db: Some(-7.5),
            track_peak: Some(0.98),
            ..Loudness::default()
        }
        .insert_into(&mut headers);
        assert_eq!(headers[LOUDNESS_HEADER], "track=-7.5;track-peak=0.98");
    }
}
