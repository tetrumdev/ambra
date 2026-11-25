use super::*;
use crate::providers::recommendations::{Mix, Recommendations};
use librespot_protocol::{
    extended_metadata::{BatchedEntityRequest, EntityRequest, ExtensionQuery},
    extension_kind::ExtensionKind,
    metadata::Track as TrackProto,
};
use protobuf::{EnumOrUnknown, Message};
use serde_json::{Value, json};
use std::collections::HashSet;

const MADE_FOR_YOU: &str = "spotify:section:0JQ5DAUnp4wcj0bCb3wh3S";
const TOP_MIXES: &str = "spotify:section:0JQ5DAnM3wGh0gz1MXnu89";
const MADE_FOR_YOU_TITLE: &str = "Made for you";
const HOME_SECTION_HASH: &str = "eb3fba2d388cf4fc4d696b1757a58584e9538a3b515ea742e9cc9465807340be";
const DAYLIST: &str = "37i9dQZF1EP6YuccBxUcC1";
const SPOTIFY_DJ: &str = "37i9dQZF1EYkqdzj48dyYq";
const PAGE_SIZE: usize = 20;

impl SpotifyProvider {
    pub async fn recommendations(&self) -> ProviderResult<Recommendations> {
        self.recommendation_cache
            .recommendations(async {
                // Spotifast's homeSection query uses the playback account and a
                // same-account OAuth grant for the sp_t field.
                let context = self.access_token(None).await?;
                let token = self.session.login5().auth_token().await?;
                let client_token = self.session.spclient().client_token().await?;
                let (mut mixes, top_mixes) = tokio::try_join!(
                    self.recommendation_section(
                        MADE_FOR_YOU,
                        MADE_FOR_YOU_TITLE,
                        &token.access_token,
                        &client_token,
                        &context
                    ),
                    self.recommendation_section(
                        TOP_MIXES,
                        "Top mixes",
                        &token.access_token,
                        &client_token,
                        &context
                    ),
                )?;
                // Keep shared cards in the more specific Top mixes shelf.
                let top_ids: HashSet<_> = top_mixes.iter().map(|mix| mix.id.as_str()).collect();
                mixes.retain(|mix| !top_ids.contains(mix.id.as_str()));
                mixes.extend(top_mixes);
                // Spotify exposes daylist at a stable entry point, even on
                // accounts where it is absent from the Home shelves.
                if !mixes.iter().any(|mix| mix.id == DAYLIST) {
                    mixes.insert(
                        0,
                        Mix {
                            id: DAYLIST.into(),
                            title: "daylist".into(),
                            image_url: None,
                            section: MADE_FOR_YOU_TITLE,
                        },
                    );
                }
                Ok(Recommendations {
                    mixes,
                    albums: Vec::new(),
                })
            })
            .await
    }

    pub async fn recommendation_tracks(&self, id: &str) -> ProviderResult<Vec<TrackMetadata>> {
        self.recommendation_cache
            .tracks(id, async {
                let playlist = self.playlist(id).await?;
                let mut seen = HashSet::new();
                let ids: Vec<_> = playlist
                    .entries
                    .into_iter()
                    .map(|entry| entry.track_id)
                    .filter(|id| seen.insert(id.clone()))
                    .take(100)
                    .collect();
                let mut tracks = HashMap::new();
                let mut missing = Vec::new();
                for id in &ids {
                    if let Some(track) = self.track_metadata.get(id) {
                        tracks.insert(id.clone(), track);
                    } else {
                        missing.push(id.as_str());
                    }
                }
                // Spotify returns the album and credited artists in the track
                // batch. Avoid individual track, album and artist lookups.
                for ids in missing.chunks(40) {
                    let request = BatchedEntityRequest {
                        entity_request: ids
                            .iter()
                            .map(|id| EntityRequest {
                                entity_uri: format!("spotify:track:{id}"),
                                query: vec![ExtensionQuery {
                                    extension_kind: EnumOrUnknown::new(ExtensionKind::TRACK_V4),
                                    ..Default::default()
                                }],
                                ..Default::default()
                            })
                            .collect(),
                        ..Default::default()
                    };
                    let reply = self
                        .session
                        .spclient()
                        .get_extended_metadata(request)
                        .await?;
                    for entry in reply
                        .extended_metadata
                        .into_iter()
                        .flat_map(|group| group.extension_data)
                    {
                        let Some(id) = entry.entity_uri.strip_prefix("spotify:track:") else {
                            continue;
                        };
                        let Some(track) = entry
                            .extension_data
                            .as_ref()
                            .and_then(|any| TrackProto::parse_from_bytes(&any.value).ok())
                            .and_then(|proto| Track::try_from(&proto).ok())
                        else {
                            continue;
                        };
                        let format = self.selected_audio_file(&track).map(|(format, _)| format);
                        if format.is_none() && track.alternatives.is_empty() {
                            continue;
                        }
                        let artists = summarized_artists(&track.artists);
                        let album_artists = summarized_artists(&track.album.artists);
                        if let Ok(metadata) =
                            describe_track(id, &track, &track.album, artists, album_artists, format)
                        {
                            tracks.insert(id.to_owned(), metadata);
                        }
                    }
                }
                if tracks.is_empty() && !ids.is_empty() {
                    return Err(io::Error::other("No Spotify mix tracks could be loaded").into());
                }
                Ok(ids
                    .into_iter()
                    .filter_map(|id| tracks.remove(&id))
                    .collect())
            })
            .await
    }

    async fn recommendation_section(
        &self,
        section: &str,
        title: &'static str,
        token: &str,
        client_token: &str,
        context: &str,
    ) -> ProviderResult<Vec<Mix>> {
        let mut mixes = Vec::new();
        let mut seen = HashSet::new();
        let mut offset = 0;
        let country = self.session.country();
        for _ in 0..10 {
            let value: Value = self
                .http_client
                .post(SEARCH_ENDPOINT)
                .bearer_auth(token)
                .header("client-token", client_token)
                .json(&json!({
                    "operationName": "homeSection",
                    "variables": {
                        "uri": section,
                        "country": country,
                        "timeZone": "UTC",
                        "sp_t": context,
                        "sectionItemsLimit": PAGE_SIZE,
                        "sectionItemsOffset": offset,
                    },
                    "extensions": {
                        "persistedQuery": { "version": 1, "sha256Hash": HOME_SECTION_HASH }
                    }
                }))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            let (page, count, more) = section_page(&value, offset, title)?;
            mixes.extend(page.into_iter().filter(|mix| seen.insert(mix.id.clone())));
            if !more {
                return Ok(mixes);
            }
            offset += count;
        }
        Err(io::Error::other("Spotify's personalized shelf exceeded the page limit").into())
    }
}

fn section_page(
    value: &Value,
    offset: usize,
    title: &'static str,
) -> ProviderResult<(Vec<Mix>, usize, bool)> {
    let invalid = || io::Error::other("Spotify did not return a personalized Home shelf");
    if value.get("errors").is_some_and(|errors| {
        !errors.is_null() && errors.as_array().is_none_or(|errors| !errors.is_empty())
    }) {
        return Err(invalid().into());
    }
    let sections = value
        .pointer("/data/homeSections/sections")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let mut mixes = Vec::new();
    let mut count = 0;
    let mut total = Some(0);
    for section in sections {
        let items = section
            .pointer("/sectionItems/items")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        count += items.len();
        total = total.and_then(|sum| {
            section
                .pointer("/sectionItems/totalCount")
                .and_then(Value::as_u64)
                .map(|n| sum + n)
        });
        mixes.extend(items.iter().filter_map(|item| playlist(item, title)));
    }
    let more = count > 0
        && total.map_or(count == PAGE_SIZE, |total| {
            ((offset + count) as u64) < total
        });
    Ok((mixes, count, more))
}

fn playlist(item: &Value, section: &'static str) -> Option<Mix> {
    let data = item.pointer("/content/data")?;
    if data.get("__typename")?.as_str()? != "Playlist" {
        return None;
    }
    let id = data
        .get("uri")?
        .as_str()?
        .strip_prefix("spotify:playlist:")?;
    if id == SPOTIFY_DJ || id.len() != 22 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    let title = data.get("name")?.as_str()?.to_owned();
    let image_url = data
        .pointer("/images/items/0/sources")
        .and_then(Value::as_array)
        .and_then(|images| {
            images
                .iter()
                .filter_map(|image| {
                    Some((
                        image.get("url")?.as_str()?,
                        image.get("width").and_then(Value::as_u64),
                    ))
                })
                .filter(|(url, _)| url.starts_with("https://"))
                .min_by_key(|(_, width)| width.map_or(u64::MAX, |width| width.abs_diff(320)))
                .map(|(url, _)| url.to_owned())
        });
    Some(Mix {
        id: id.to_owned(),
        title,
        image_url,
        section,
    })
}

fn summarized_artists(artists: &librespot_metadata::artist::Artists) -> Vec<ArtistMetadata> {
    artists
        .iter()
        .filter(|artist| !artist.name.trim().is_empty())
        .map(|artist| ArtistMetadata {
            provider_id: artist.id.to_id().unwrap_or_default(),
            name: artist.name.clone(),
            image_url: best_image_url(&artist.portraits),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_unplayable_cards_without_shortening_the_next_page_offset() {
        let body = json!({"data": {"homeSections": {"sections": [{"sectionItems": {
            "totalCount": 12,
            "items": [
                {"content": {"data": {"__typename": "Playlist", "uri": format!("spotify:playlist:{DAYLIST}"), "name": "daylist"}}},
                {"content": {"data": {"__typename": "Playlist", "uri": format!("spotify:playlist:{SPOTIFY_DJ}"), "name": "DJ"}}},
                {"content": {"data": {"__typename": "Album", "name": "Ignored"}}}
            ]
        }}]}}});
        let (mixes, count, more) = section_page(&body, 4, MADE_FOR_YOU_TITLE).unwrap();
        assert_eq!(
            mixes.iter().map(|mix| mix.id.as_str()).collect::<Vec<_>>(),
            [DAYLIST]
        );
        assert_eq!(mixes[0].section, MADE_FOR_YOU_TITLE);
        assert_eq!(count, 3);
        assert!(more);
        assert!(
            section_page(
                &json!({"errors": [{"message": "Unavailable"}]}),
                0,
                "Top mixes"
            )
            .is_err()
        );
    }
}
