use super::*;
use crate::playlists::{PlaylistContents, PlaylistEntry, ServicePlaylist, revision};
use serde_json::Value;

impl QobuzProvider {
    pub async fn playlists(&self) -> ProviderResult<Vec<ServicePlaylist>> {
        let user = self
            .client
            .playlist_user_id()
            .await
            .ok_or_else(|| io::Error::other("Qobuz is not connected"))?;
        let mut result = Vec::new();
        let mut offset = 0;
        loop {
            let page = self
                .client
                .playlist_api(
                    "getUserPlaylists",
                    &[("limit", "100".into()), ("offset", offset.to_string())],
                )
                .await?;
            let items = page["playlists"]["items"]
                .as_array()
                .ok_or_else(|| io::Error::other("Qobuz returned invalid playlists"))?;
            for item in items {
                result.push(qobuz_playlist(item, user)?);
            }
            offset += items.len();
            if items.is_empty()
                || offset as u64
                    >= page["playlists"]["total"]
                        .as_u64()
                        .ok_or_else(|| io::Error::other("Qobuz playlists have no total"))?
            {
                break;
            }
        }
        Ok(result)
    }

    pub async fn playlist(&self, id: &str) -> ProviderResult<PlaylistContents> {
        let user = self
            .client
            .playlist_user_id()
            .await
            .ok_or_else(|| io::Error::other("Qobuz is not connected"))?;
        let mut entries = Vec::new();
        let mut playlist = None;
        let mut offset = 0;
        let mut updated = None;
        loop {
            let page = self
                .client
                .playlist_api(
                    "get",
                    &[
                        ("playlist_id", id.into()),
                        ("extra", "tracks".into()),
                        ("limit", "100".into()),
                        ("offset", offset.to_string()),
                    ],
                )
                .await?;
            let stamp = page.get("updated_at").cloned();
            if offset > 0 && stamp != updated {
                return Err(io::Error::other(
                    "Qobuz playlist changed while loading. Refresh and try again.",
                )
                .into());
            }
            updated = stamp;
            if playlist.is_none() {
                playlist = Some(qobuz_playlist(&page, user)?);
            }
            let items = page["tracks"]["items"]
                .as_array()
                .ok_or_else(|| io::Error::other("Qobuz returned invalid playlist tracks"))?;
            for item in items {
                if let Ok(track) = serde_json::from_value::<qbz_models::Track>(item.clone()) {
                    let metadata = map_search_track(track);
                    self.track_metadata_cache
                        .lock()
                        .await
                        .entry(metadata.provider_track_id.clone())
                        .or_insert(metadata);
                }
                entries.push(PlaylistEntry {
                    id: item["playlist_track_id"]
                        .as_u64()
                        .ok_or_else(|| io::Error::other("Qobuz playlist entry has no ID"))?
                        .to_string(),
                    track_id: item["id"]
                        .as_u64()
                        .ok_or_else(|| io::Error::other("Qobuz playlist track has no ID"))?
                        .to_string(),
                });
            }
            offset += items.len();
            if items.is_empty()
                || offset as u64
                    >= page["tracks"]["total"]
                        .as_u64()
                        .ok_or_else(|| io::Error::other("Qobuz playlist tracks have no total"))?
            {
                break;
            }
        }
        let playlist = playlist.ok_or_else(|| io::Error::other("Qobuz playlist is missing"))?;
        let revision = revision(&playlist.name, &entries);
        Ok(PlaylistContents {
            playlist,
            entries,
            revision,
        })
    }

    pub async fn add_playlist_track(
        &self,
        id: &str,
        track_id: &str,
        _revision: &str,
    ) -> ProviderResult<()> {
        self.client
            .playlist_api(
                "addTracks",
                &[
                    ("playlist_id", id.into()),
                    ("track_ids", track_id.into()),
                    ("no_duplicate", "true".into()),
                ],
            )
            .await?;
        Ok(())
    }

    pub async fn rename_playlist(
        &self,
        id: &str,
        name: &str,
        _revision: &str,
    ) -> ProviderResult<()> {
        self.client
            .playlist_api(
                "update",
                &[("playlist_id", id.into()), ("name", name.into())],
            )
            .await?;
        Ok(())
    }

    pub async fn delete_playlist(&self, id: &str) -> ProviderResult<()> {
        self.client
            .playlist_api("delete", &[("playlist_id", id.into())])
            .await?;
        Ok(())
    }

    pub async fn remove_playlist_tracks(
        &self,
        id: &str,
        entries: &[PlaylistEntry],
        _revision: &str,
    ) -> ProviderResult<()> {
        let ids = entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        self.client
            .playlist_api(
                "deleteTracks",
                &[("playlist_id", id.into()), ("playlist_track_ids", ids)],
            )
            .await?;
        Ok(())
    }
}

fn qobuz_playlist(value: &Value, user_id: u64) -> ProviderResult<ServicePlaylist> {
    Ok(ServicePlaylist {
        id: value["id"]
            .as_u64()
            .ok_or_else(|| io::Error::other("Qobuz playlist has no ID"))?
            .to_string(),
        name: value["name"]
            .as_str()
            .unwrap_or("Untitled playlist")
            .to_owned(),
        editable: value["owner"]["id"].as_u64() == Some(user_id),
        track_count: value["tracks_count"].as_u64().unwrap_or(0),
    })
}
