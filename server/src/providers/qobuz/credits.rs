use super::*;
use crate::credits::{AlbumInfo, Contribution, CreditGroup, album_credits, track_credits};
use qbz_qobuz::performers::{format_role_label, parse_performers};

impl QobuzProvider {
    pub async fn track_credits(&self, track_id: &str) -> ProviderResult<Vec<CreditGroup>> {
        let track = self.client.get_track(validate_track_id(track_id)?).await?;
        Ok(qobuz_credits(&track))
    }

    pub async fn album_info(&self, album_id: &str) -> ProviderResult<AlbumInfo> {
        validate_album_id(album_id)?;
        let album = self.album(album_id).await?;
        let tracks = album
            .tracks
            .as_ref()
            .map(|tracks| tracks.items.as_slice())
            .unwrap_or_default();
        Ok(AlbumInfo {
            source: Some(MusicProvider::Qobuz),
            description: album
                .description
                .clone()
                .filter(|description| !description.trim().is_empty()),
            description_source: None,
            label: album.label.as_ref().map(|label| label.name.clone()),
            copyright: tracks.iter().find_map(|track| track.copyright.clone()),
            credits: album_credits(tracks.iter().map(qobuz_credits).collect()),
        })
    }

    pub async fn album_id_by_upc(&self, upc: &str) -> ProviderResult<Option<String>> {
        let albums = self.client.search_albums(upc, 10, 0, None).await?;
        Ok(albums
            .items
            .into_iter()
            .find(|album| {
                album
                    .upc
                    .as_deref()
                    .is_some_and(|candidate| same_release_upc(upc, candidate))
            })
            .map(|album| album.id))
    }
}

fn qobuz_credits(track: &qbz_models::Track) -> Vec<CreditGroup> {
    let performers = parse_performers(track.performers.as_deref().unwrap_or_default());
    track_credits(performers.into_iter().flat_map(|performer| {
        let name = performer.name;
        // Qobuz credits are names only; the app finds artist pages for them by name.
        performer.roles.into_iter().map(move |role| Contribution {
            name: name.clone(),
            role: format_role_label(&role),
            artist_id: None,
        })
    }))
}
