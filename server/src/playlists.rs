use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePlaylist {
    pub id: String,
    pub name: String,
    pub editable: bool,
    pub track_count: u64,
}

#[derive(Clone, Debug, Serialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    pub id: String,
    pub track_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistContents {
    pub playlist: ServicePlaylist,
    pub entries: Vec<PlaylistEntry>,
    pub revision: String,
}

pub fn revision(name: &str, entries: &[PlaylistEntry]) -> String {
    let mut hash = DefaultHasher::new();
    name.hash(&mut hash);
    entries.hash(&mut hash);
    format!("{:x}", hash.finish())
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum PlaylistChange {
    Add {
        track: MatchTrack,
    },
    Remove {
        #[serde(rename = "trackIds")]
        track_ids: Vec<String>,
        revision: String,
    },
    Rename {
        name: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchTrack {
    pub provider: String,
    pub provider_track_id: String,
    pub name: String,
    pub artist: String,
    pub duration_seconds: f64,
    pub isrc: Option<String>,
}
