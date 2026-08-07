use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MusicProvider {
    Tidal,
    Qobuz,
    Spotify,
    YoutubeMusic,
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
