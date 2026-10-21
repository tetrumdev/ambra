use super::*;
use crate::playlists::{PlaylistContents, PlaylistEntry, ServicePlaylist};
use base64::{Engine, engine::general_purpose};
use librespot_protocol::playlist4_external::{self as protocol, SelectedListContent};
use protobuf::{Message, MessageField};

impl SpotifyProvider {
    pub async fn playlists(&self) -> ProviderResult<Vec<ServicePlaylist>> {
        self.access_token(None).await?;
        let mut result = Vec::new();
        let mut offset = 0;
        loop {
            let bytes = self
                .session
                .spclient()
                .get_rootlist(offset, Some(100))
                .await?;
            let page = SelectedListContent::parse_from_bytes(&bytes)?;
            let contents = page.contents.get_or_default();
            for (index, item) in contents.items.iter().enumerate() {
                let Ok(SpotifyUri::Playlist { id, .. }) = SpotifyUri::from_uri(item.uri()) else {
                    continue;
                };
                let id = id.to_base62()?;
                if result
                    .iter()
                    .any(|playlist: &ServicePlaylist| playlist.id == id)
                {
                    continue;
                }
                if let Some(metadata) = contents
                    .meta_items
                    .get(index)
                    .filter(|item| !item.attributes.get_or_default().name().is_empty())
                {
                    result.push(ServicePlaylist {
                        id,
                        name: metadata.attributes.get_or_default().name().to_owned(),
                        editable: metadata.capabilities.get_or_default().can_edit_items(),
                        track_count: metadata.length().max(0) as u64,
                    });
                } else {
                    result.push(self.playlist(&id).await?.playlist);
                }
            }
            offset += contents.items.len();
            if contents.items.is_empty()
                || !contents.truncated()
                || offset >= page.length().max(0) as usize
            {
                break;
            }
        }
        Ok(result)
    }

    pub async fn playlist(&self, id: &str) -> ProviderResult<PlaylistContents> {
        self.access_token(None).await?;
        let mut playlist = None;
        let mut revision = None;
        let mut entries = Vec::new();
        let mut offset = 0;
        loop {
            let bytes = self
                .session
                .spclient()
                .request(
                    &reqwest::Method::GET,
                    &format!("/playlist/v2/playlist/{id}?from={offset}&length=100"),
                    None,
                    None,
                )
                .await?;
            let page = SelectedListContent::parse_from_bytes(&bytes)?;
            if revision
                .as_ref()
                .is_some_and(|revision: &Vec<u8>| revision.as_slice() != page.revision())
            {
                return Err(io::Error::other(
                    "Spotify playlist changed while loading. Refresh and try again.",
                )
                .into());
            }
            revision = Some(page.revision().to_vec());
            if playlist.is_none() {
                playlist = Some(ServicePlaylist {
                    id: id.to_owned(),
                    name: page.attributes.get_or_default().name().to_owned(),
                    editable: page.capabilities.get_or_default().can_edit_items(),
                    track_count: page.length().max(0) as u64,
                });
            }
            let contents = page.contents.get_or_default();
            for (index, item) in contents.items.iter().enumerate() {
                if let Ok(SpotifyUri::Track { id }) = SpotifyUri::from_uri(item.uri()) {
                    entries.push(PlaylistEntry {
                        id: (offset + index).to_string(),
                        track_id: id.to_base62()?,
                    });
                }
            }
            offset += contents.items.len();
            if contents.items.is_empty()
                || !contents.truncated()
                || offset >= page.length().max(0) as usize
            {
                break;
            }
        }
        Ok(PlaylistContents {
            playlist: playlist.ok_or_else(|| io::Error::other("Spotify playlist is missing"))?,
            entries,
            revision: general_purpose::STANDARD.encode(revision.unwrap_or_default()),
        })
    }

    async fn change_playlist(
        &self,
        id: &str,
        revision: &str,
        ops: Vec<protocol::Op>,
    ) -> ProviderResult<()> {
        self.send_changes(
            &format!("/playlist/v2/playlist/{id}/changes"),
            revision,
            ops,
        )
        .await
    }

    async fn send_changes(
        &self,
        endpoint: &str,
        revision: &str,
        ops: Vec<protocol::Op>,
    ) -> ProviderResult<()> {
        self.access_token(None).await?;
        let mut change = protocol::ListChanges::new();
        change.set_base_revision(general_purpose::STANDARD.decode(revision)?);
        change.set_want_resulting_revisions(true);
        let mut delta = protocol::Delta::new();
        delta.ops = ops;
        let mut info = protocol::ChangeInfo::new();
        info.set_user(self.session.username());
        info.set_timestamp(
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)?
                .as_millis() as i64,
        );
        delta.info = MessageField::some(info);
        change.deltas.push(delta);
        change.nonces.push(
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)?
                .as_nanos() as i64,
        );
        self.session
            .spclient()
            .request_with_protobuf(&reqwest::Method::POST, endpoint, None, &change)
            .await?;
        Ok(())
    }

    pub async fn add_playlist_track(
        &self,
        id: &str,
        track_id: &str,
        revision: &str,
    ) -> ProviderResult<()> {
        let mut item = protocol::Item::new();
        item.set_uri(format!("spotify:track:{track_id}"));
        let mut addition = protocol::Add::new();
        addition.set_add_last(true);
        addition.items.push(item);
        let mut op = protocol::Op::new();
        op.set_kind(protocol::op::Kind::ADD);
        op.add = MessageField::some(addition);
        self.change_playlist(id, revision, vec![op]).await
    }

    pub async fn rename_playlist(
        &self,
        id: &str,
        name: &str,
        revision: &str,
    ) -> ProviderResult<()> {
        let mut attributes = protocol::ListAttributes::new();
        attributes.set_name(name.to_owned());
        let mut state = protocol::ListAttributesPartialState::new();
        state.values = MessageField::some(attributes);
        let mut update = protocol::UpdateListAttributes::new();
        update.new_attributes = MessageField::some(state);
        let mut op = protocol::Op::new();
        op.set_kind(protocol::op::Kind::UPDATE_LIST_ATTRIBUTES);
        op.update_list_attributes = MessageField::some(update);
        self.change_playlist(id, revision, vec![op]).await
    }

    /// Spotify deletes a playlist by removing it from the user's rootlist.
    pub async fn delete_playlist(&self, id: &str) -> ProviderResult<()> {
        self.access_token(None).await?;
        let mut revision = None;
        let mut offset = 0;
        let index = loop {
            let bytes = self
                .session
                .spclient()
                .get_rootlist(offset, Some(100))
                .await?;
            let page = SelectedListContent::parse_from_bytes(&bytes)?;
            if revision
                .as_ref()
                .is_some_and(|revision: &Vec<u8>| revision.as_slice() != page.revision())
            {
                return Err(io::Error::other(
                    "Spotify library changed while loading. Refresh and try again.",
                )
                .into());
            }
            revision = Some(page.revision().to_vec());
            let contents = page.contents.get_or_default();
            let found = contents.items.iter().position(|item| {
                matches!(
                    SpotifyUri::from_uri(item.uri()),
                    Ok(SpotifyUri::Playlist { id: item_id, .. })
                        if item_id.to_base62().is_ok_and(|item_id| item_id == id)
                )
            });
            if let Some(found) = found {
                break offset + found;
            }
            offset += contents.items.len();
            if contents.items.is_empty()
                || !contents.truncated()
                || offset >= page.length().max(0) as usize
            {
                return Err(io::Error::other("Spotify playlist is not in your library").into());
            }
        };
        let mut item = protocol::Item::new();
        item.set_uri(format!("spotify:playlist:{id}"));
        let mut removal = protocol::Rem::new();
        removal.set_from_index(index as i32);
        removal.set_length(1);
        removal.set_items_as_key(true);
        removal.items.push(item);
        let mut op = protocol::Op::new();
        op.set_kind(protocol::op::Kind::REM);
        op.rem = MessageField::some(removal);
        let user = self.session.username();
        self.send_changes(
            &format!("/playlist/v2/user/{user}/rootlist/changes"),
            &general_purpose::STANDARD.encode(revision.unwrap_or_default()),
            vec![op],
        )
        .await
    }

    pub async fn remove_playlist_tracks(
        &self,
        id: &str,
        entries: &[PlaylistEntry],
        revision: &str,
    ) -> ProviderResult<()> {
        let mut positions = entries
            .iter()
            .map(|entry| entry.id.parse::<i32>())
            .collect::<Result<Vec<_>, _>>()?;
        positions.sort_unstable_by(|left, right| right.cmp(left));
        let ops = positions
            .into_iter()
            .map(|index| {
                let mut removal = protocol::Rem::new();
                removal.set_from_index(index);
                removal.set_length(1);
                let mut op = protocol::Op::new();
                op.set_kind(protocol::op::Kind::REM);
                op.rem = MessageField::some(removal);
                op
            })
            .collect();
        self.change_playlist(id, revision, ops).await
    }
}
