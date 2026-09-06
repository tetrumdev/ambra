use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MusicProvider {
    Tidal,
    Qobuz,
    Spotify,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistMetadata {
    pub provider_id: String,
    pub name: String,
    #[serde(default)]
    pub image_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumMetadata {
    pub provider_id: String,
    pub title: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub artists: Vec<ArtistMetadata>,
    pub cover_url: Option<String>,
    pub release_date: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub upc: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackKind {
    Direct,
    Dash,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackMetadata {
    pub kind: PlaybackKind,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetadata {
    /// Stable application-wide ID. Provider prefix prevents collisions.
    pub id: String,
    pub provider: MusicProvider,
    pub provider_track_id: String,
    pub title: String,
    #[serde(default)]
    pub version: Option<String>,
    pub primary_artist: ArtistMetadata,
    pub artists: Vec<ArtistMetadata>,
    pub album: Option<AlbumMetadata>,
    pub duration_seconds: u64,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub explicit: bool,
    pub isrc: Option<String>,
    #[serde(default)]
    pub copyright: Option<String>,
    pub quality: Option<String>,
    #[serde(default, rename = "maximumSamplingRateKHz")]
    pub maximum_sampling_rate_khz: Option<f64>,
    #[serde(default)]
    pub maximum_bit_depth: Option<u32>,
    /// Provider-neutral playback descriptor. Desktop never receives provider credentials.
    pub playback: PlaybackMetadata,
}

/// Pagination is measured before availability filtering, so a short playable page is not exhaustion.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub tracks: Vec<TrackMetadata>,
    pub next_offset: Option<u32>,
}

pub fn search_next_offset(offset: u32, raw_count: usize, total: u32) -> Option<u32> {
    let next = offset.saturating_add(raw_count as u32);
    (raw_count > 0 && next < total && next > offset).then_some(next)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryResponse {
    pub tracks: Vec<TrackMetadata>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: &'static str,
}

#[cfg(test)]
mod tests {
    use super::{ArtistMetadata, MusicProvider, PlaybackKind, PlaybackMetadata, TrackMetadata};

    #[test]
    fn serializes_provider_neutral_metadata_for_desktop() {
        let track = TrackMetadata {
            id: "qobuz:1".into(),
            provider: MusicProvider::Qobuz,
            provider_track_id: "1".into(),
            title: "Track".into(),
            version: None,
            primary_artist: ArtistMetadata {
                provider_id: "2".into(),
                name: "Artist".into(),
                image_url: Some("https://images.example/artist.jpg".into()),
            },
            artists: Vec::new(),
            album: None,
            duration_seconds: 180,
            track_number: Some(1),
            disc_number: Some(1),
            explicit: false,
            isrc: None,
            copyright: None,
            quality: Some("FLAC 24-bit/192 kHz".into()),
            maximum_sampling_rate_khz: Some(192.0),
            maximum_bit_depth: Some(24),
            playback: PlaybackMetadata {
                kind: PlaybackKind::Direct,
                url: "/api/providers/qobuz/tracks/1/stream".into(),
            },
        };

        let json = serde_json::to_value(track).unwrap();
        assert_eq!(json["provider"], "qobuz");
        assert_eq!(
            json["primaryArtist"]["imageUrl"],
            "https://images.example/artist.jpg"
        );
        assert_eq!(json["maximumSamplingRateKHz"], 192.0);
        assert_eq!(json["playback"]["kind"], "direct");
    }
}

#[cfg(test)]
mod search_tests {
    use super::search_next_offset;
    #[test]
    fn pagination_uses_raw_count_and_total() {
        assert_eq!(search_next_offset(0, 20, 100), Some(20));
        assert_eq!(search_next_offset(20, 7, 100), Some(27));
        assert_eq!(search_next_offset(20, 0, 100), None);
        assert_eq!(search_next_offset(80, 20, 100), None);
        assert_eq!(search_next_offset(u32::MAX, 20, u32::MAX), None);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogArtist {
    pub id: String,
    pub provider: MusicProvider,
    pub name: String,
    pub image_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAlbum {
    pub id: String,
    pub provider: MusicProvider,
    pub title: String,
    pub artist: String,
    pub image_url: Option<String>,
    pub upc: Option<String>,
    pub release_date: Option<String>,
    pub version: Option<String>,
    pub explicit: Option<bool>,
    pub maximum_bit_depth: Option<u32>,
    #[serde(rename = "maximumSamplingRateKHz")]
    pub maximum_sampling_rate_khz: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSearchPage {
    pub tracks: Vec<TrackMetadata>,
    pub artists: Vec<CatalogArtist>,
    pub albums: Vec<CatalogAlbum>,
}
