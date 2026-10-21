use super::*;
use crate::playlists::{PlaylistContents, PlaylistEntry, ServicePlaylist};
use serde_json::Value;

impl TidalProvider {
    pub(super) async fn v1_api(
        &self,
        method: reqwest::Method,
        path: &str,
        form: &[(&str, String)],
        revision: Option<&str>,
    ) -> ProviderResult<(Value, Option<String>)> {
        let mut client = self.refreshed_client(None).await?;
        for attempt in 0..2 {
            let token = client
                .session
                .auth
                .access_token
                .clone()
                .ok_or_else(|| io::Error::other("Tidal is not connected"))?;
            let country = client
                .user_info
                .as_ref()
                .map(|user| user.country_code.as_str())
                .unwrap_or("US");
            let mut request = self
                .http_client
                .request(method.clone(), format!("{TIDAL_API_BASE_URL}/{path}"))
                .bearer_auth(&token)
                .query(&[("countryCode", country)]);
            if !form.is_empty() {
                request = request.form(form);
            }
            if let Some(revision) = revision {
                request = request.header("If-None-Match", revision);
            }
            let response = request.send().await?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                client = self.refreshed_client(Some(token)).await?;
                continue;
            }
            if response.status() == reqwest::StatusCode::PRECONDITION_FAILED {
                return Err(io::Error::other(
                    "Tidal playlist changed on another device. Refresh and try again.",
                )
                .into());
            }
            let response = response.error_for_status()?;
            let etag = response
                .headers()
                .get("etag")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let bytes = response.bytes().await?;
            let value = if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes)?
            };
            return Ok((value, etag));
        }
        Err(io::Error::other("Tidal playlist authorization failed").into())
    }

    pub async fn playlists(&self) -> ProviderResult<Vec<ServicePlaylist>> {
        let client = self.refreshed_client(None).await?;
        let user = client
            .user_info
            .as_ref()
            .ok_or_else(|| io::Error::other("Tidal user is missing"))?
            .user_id;
        let mut result = Vec::new();
        for section in ["playlists", "favorites/playlists"] {
            let mut offset = 0;
            loop {
                let (page, _) = self
                    .v1_api(
                        reqwest::Method::GET,
                        &format!("users/{user}/{section}?limit=100&offset={offset}"),
                        &[],
                        None,
                    )
                    .await?;
                let items = page["items"]
                    .as_array()
                    .ok_or_else(|| io::Error::other("Tidal returned invalid playlists"))?;
                for item in items {
                    let playlist = tidal_playlist(item.get("item").unwrap_or(item), user)?;
                    if !result
                        .iter()
                        .any(|existing: &ServicePlaylist| existing.id == playlist.id)
                    {
                        result.push(playlist);
                    }
                }
                offset += items.len();
                if items.is_empty()
                    || offset as u64 >= page["totalNumberOfItems"].as_u64().unwrap_or(offset as u64)
                {
                    break;
                }
            }
        }
        Ok(result)
    }

    pub async fn playlist(&self, id: &str) -> ProviderResult<PlaylistContents> {
        let client = self.refreshed_client(None).await?;
        let user = client
            .user_info
            .as_ref()
            .ok_or_else(|| io::Error::other("Tidal user is missing"))?
            .user_id;
        let (metadata, _) = self
            .v1_api(reqwest::Method::GET, &format!("playlists/{id}"), &[], None)
            .await?;
        let playlist = tidal_playlist(&metadata, user)?;
        let mut entries = Vec::new();
        let mut revision = None;
        let mut offset = 0;
        loop {
            let (page, etag) = self
                .v1_api(
                    reqwest::Method::GET,
                    &format!("playlists/{id}/items?limit=100&offset={offset}"),
                    &[],
                    None,
                )
                .await?;
            let etag = etag.ok_or_else(|| io::Error::other("Tidal playlist has no revision"))?;
            if revision.as_ref().is_some_and(|revision| revision != &etag) {
                return Err(io::Error::other(
                    "Tidal playlist changed while loading. Refresh and try again.",
                )
                .into());
            }
            revision = Some(etag);
            let items = page["items"]
                .as_array()
                .ok_or_else(|| io::Error::other("Tidal returned invalid playlist items"))?;
            for (index, item) in items.iter().enumerate() {
                if item["type"] == "track"
                    && let Some(id) = item["item"]["id"].as_u64()
                {
                    if let Ok(track) =
                        serde_json::from_value::<SearchTrackHit>(item["item"].clone())
                    {
                        let metadata = search_track_metadata(track);
                        self.track_metadata_cache
                            .lock()
                            .await
                            .entry(id.to_string())
                            .or_insert(metadata);
                    }
                    entries.push(PlaylistEntry {
                        id: (offset + index).to_string(),
                        track_id: id.to_string(),
                    });
                }
            }
            offset += items.len();
            if items.is_empty()
                || offset as u64
                    >= page["totalNumberOfItems"]
                        .as_u64()
                        .ok_or_else(|| io::Error::other("Tidal playlist has no total"))?
            {
                break;
            }
        }
        Ok(PlaylistContents {
            playlist,
            entries,
            revision: revision.unwrap_or_default(),
        })
    }

    pub async fn add_playlist_track(
        &self,
        id: &str,
        track_id: &str,
        revision: &str,
    ) -> ProviderResult<()> {
        let (page, etag) = self
            .v1_api(
                reqwest::Method::GET,
                &format!("playlists/{id}/items?limit=1&offset=0"),
                &[],
                None,
            )
            .await?;
        if etag.as_deref() != Some(revision) {
            return Err(io::Error::other(
                "Tidal playlist changed on another device. Refresh and try again.",
            )
            .into());
        }
        let index = page["totalNumberOfItems"]
            .as_u64()
            .ok_or_else(|| io::Error::other("Tidal playlist has no total"))?;
        self.v1_api(
            reqwest::Method::POST,
            &format!("playlists/{id}/items"),
            &[
                ("itemIds", track_id.into()),
                ("toIndex", index.to_string()),
                ("onDupes", "SKIP".into()),
                ("onArtifactNotFound", "FAIL".into()),
            ],
            Some(revision),
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
        self.v1_api(
            reqwest::Method::POST,
            &format!("playlists/{id}"),
            &[("title", name.into())],
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn delete_playlist(&self, id: &str) -> ProviderResult<()> {
        self.v1_api(
            reqwest::Method::DELETE,
            &format!("playlists/{id}"),
            &[],
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn remove_playlist_tracks(
        &self,
        id: &str,
        entries: &[PlaylistEntry],
        revision: &str,
    ) -> ProviderResult<()> {
        let indices = entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        self.v1_api(
            reqwest::Method::DELETE,
            &format!("playlists/{id}/items/{indices}"),
            &[],
            Some(revision),
        )
        .await?;
        Ok(())
    }
}

fn tidal_playlist(value: &Value, user_id: u64) -> ProviderResult<ServicePlaylist> {
    Ok(ServicePlaylist {
        id: value["uuid"]
            .as_str()
            .ok_or_else(|| io::Error::other("Tidal playlist has no ID"))?
            .to_owned(),
        name: value["title"]
            .as_str()
            .unwrap_or("Untitled playlist")
            .to_owned(),
        editable: value["creator"]["id"].as_u64() == Some(user_id),
        track_count: value["numberOfTracks"].as_u64().unwrap_or(0),
    })
}
