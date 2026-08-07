use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MusicProvider {
    Tidal,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistMetadata {
    pub provider_id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumMetadata {
    pub provider_id: String,
    pub title: String,
    pub cover_url: Option<String>,
    pub release_date: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackKind {
    Direct,
    Dash,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackMetadata {
    pub kind: PlaybackKind,
    pub url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetadata {
    /// Stable application-wide ID. Provider prefix prevents collisions.
    pub id: String,
    pub provider: MusicProvider,
    pub provider_track_id: String,
    pub title: String,
    pub primary_artist: ArtistMetadata,
    pub artists: Vec<ArtistMetadata>,
    pub album: Option<AlbumMetadata>,
    pub duration_seconds: u64,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub explicit: bool,
    pub isrc: Option<String>,
    pub quality: Option<String>,
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
