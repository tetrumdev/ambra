use super::*;
use crate::providers::recommendations::{Mix, MixArtwork, Recommendations, TTL};
use librespot_core::FileId;
use librespot_protocol::{
    extended_metadata::{BatchedEntityRequest, EntityRequest, ExtensionQuery},
    extension_kind::ExtensionKind,
    metadata::Track as TrackProto,
    playlist4_external::ListAttributes,
};
use protobuf::{EnumOrUnknown, Message};
use serde_json::{Value, json};
use std::collections::HashSet;

const MADE_FOR_YOU: &str = "spotify:section:0JQ5DAUnp4wcj0bCb3wh3S";
const TOP_MIXES: &str = "spotify:section:0JQ5DAnM3wGh0gz1MXnu89";
const MADE_FOR_YOU_TITLE: &str = "Made for you";
const HOME_SECTION_HASH: &str = "eb3fba2d388cf4fc4d696b1757a58584e9538a3b515ea742e9cc9465807340be";
const SPOTIFY_DJ: &str = "37i9dQZF1EYkqdzj48dyYq";
const PAGE_SIZE: usize = 20;

impl SpotifyProvider {
    pub const DAYLIST: &str = "37i9dQZF1EP6YuccBxUcC1";

    pub async fn recommendations(&self) -> ProviderResult<Recommendations> {
        self.recommendation_cache
            .recommendations(async {
                // Spotifast's homeSection query uses the playback account and a
                // same-account OAuth grant for the sp_t field.
                let context = self.access_token(None).await?;
                let token = self.session.login5().auth_token().await?;
                let client_token = self.session.spclient().client_token().await?;
                let (mut mixes, mut top_mixes) = tokio::try_join!(
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
                if let Some(daylist) = top_mixes.iter_mut().find(|mix| mix.id == Self::DAYLIST) {
                    if daylist.image_url.is_none() {
                        daylist.image_url = mixes
                            .iter()
                            .find(|mix| mix.id == Self::DAYLIST)
                            .and_then(|mix| mix.image_url.clone());
                        daylist.artwork_fallback = daylist.image_url.is_none();
                    }
                }
                let top_ids: HashSet<_> = top_mixes.iter().map(|mix| mix.id.as_str()).collect();
                mixes.retain(|mix| !top_ids.contains(mix.id.as_str()));
                mixes.extend(top_mixes);
                // Spotify exposes daylist at a stable entry point, even on
                // accounts where it is absent from the Home shelves.
                if !mixes.iter().any(|mix| mix.id == Self::DAYLIST) {
                    mixes.insert(
                        0,
                        Mix {
                            id: Self::DAYLIST.into(),
                            title: "daylist".into(),
                            image_url: None,
                            artwork_fallback: true,
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

    pub async fn daylist_artwork(&self) -> ProviderResult<MixArtwork> {
        let image_url = self
            .daylist_artwork
            .get_or_load(
                (),
                async {
                    // Read the signed-in account's current playlist metadata first.
                    if let Ok(Ok(page)) = tokio::time::timeout(
                        Duration::from_secs(3),
                        self.playlist_page(Self::DAYLIST, 0, 1),
                    )
                    .await
                    {
                        if let Some(url) = playlist_cover(page.attributes.get_or_default()) {
                            return Ok::<_, reqwest::Error>(Some(url));
                        }
                    }

                    // Spotify also publishes a time-of-day cover through its embed.
                    let value: Value = self
                        .http_client
                        .get("https://open.spotify.com/oembed")
                        .query(&[(
                            "url",
                            format!("https://open.spotify.com/playlist/{}", Self::DAYLIST),
                        )])
                        .timeout(Duration::from_secs(4))
                        .send()
                        .await?
                        .error_for_status()?
                        .json()
                        .await?;
                    Ok(value
                        .get("thumbnail_url")
                        .and_then(Value::as_str)
                        .and_then(spotify_cover_url))
                },
                |url| {
                    if url.is_some() {
                        TTL
                    } else {
                        Duration::from_secs(60)
                    }
                },
            )
            .await?;
        Ok(MixArtwork {
            image_url,
            ..MixArtwork::default()
        })
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
        .pointer("/images/items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .filter_map(|item| item.get("sources")?.as_array())
                .flatten()
                .filter_map(|image| {
                    let url = image.get("url")?.as_str()?;
                    let url = if id == SpotifyProvider::DAYLIST {
                        spotify_cover_url(url)?
                    } else {
                        url.starts_with("https://").then(|| url.to_owned())?
                    };
                    Some((url, image.get("width").and_then(Value::as_u64)))
                })
                .min_by_key(|(_, width)| width.map_or(u64::MAX, |width| width.abs_diff(320)))
                .map(|(url, _)| url)
        });
    Some(Mix {
        artwork_fallback: id == SpotifyProvider::DAYLIST && image_url.is_none(),
        id: id.to_owned(),
        title,
        image_url,
        section,
    })
}

fn playlist_cover(attributes: &ListAttributes) -> Option<String> {
    attributes
        .picture_size
        .iter()
        .find_map(|picture| spotify_cover_url(picture.url()))
        .or_else(|| {
            std::str::from_utf8(attributes.picture())
                .ok()
                .and_then(spotify_cover_url)
        })
        .or_else(|| {
            let bytes = attributes.picture();
            if !attributes.has_picture() || bytes.len() != 20 || bytes.iter().all(|byte| *byte == 0)
            {
                return None;
            }
            spotify_cover_url(&format!("spotify:image:{}", FileId::from_raw(bytes)))
        })
}

fn spotify_cover_url(value: &str) -> Option<String> {
    if let Some(id) = value.strip_prefix("spotify:image:") {
        return (id.len() == 40 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| format!("https://i.scdn.co/image/{id}"));
    }
    let url = reqwest::Url::parse(value).ok()?;
    let host = url.host_str()?;
    (url.scheme() == "https"
        && (matches!(host, "i.scdn.co" | "mosaic.scdn.co") || host.ends_with(".spotifycdn.com")))
    .then(|| value.to_owned())
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
    use librespot_protocol::playlist4_external::PictureSize;

    #[test]
    fn daylist_reads_current_spotify_artwork_from_any_image_group() {
        let mut card = json!({"content": {"data": {
            "__typename": "Playlist", "uri": format!("spotify:playlist:{}", SpotifyProvider::DAYLIST),
            "name": "daylist", "images": {"items": [
                {"sources": [{"url": "https://other.example/cover", "width": 320}]},
                {"sources": [{"url": "https://daylist.spotifycdn.com/playlist-covers-mix/en/evening_default.jpg", "width": 300}]}
            ]}
        }}});
        let mix = playlist(&card, MADE_FOR_YOU_TITLE).unwrap();
        assert!(!mix.artwork_fallback);
        assert_eq!(
            mix.image_url.as_deref(),
            Some("https://daylist.spotifycdn.com/playlist-covers-mix/en/evening_default.jpg")
        );

        card["content"]["data"]["images"]["items"][1]["sources"][0]["url"] = Value::Null;
        let mix = playlist(&card, MADE_FOR_YOU_TITLE).unwrap();
        assert!(mix.artwork_fallback);
        assert!(mix.image_url.is_none());
    }

    #[test]
    fn spotify_playlist_metadata_supports_cdn_urls_and_image_ids() {
        let mut attributes = ListAttributes::new();
        assert!(playlist_cover(&attributes).is_none());

        attributes.set_picture(vec![0xab; 20]);
        assert_eq!(
            playlist_cover(&attributes),
            Some(format!("https://i.scdn.co/image/{}", "ab".repeat(20)))
        );

        let mut picture = PictureSize::new();
        picture.set_url(
            "https://daylist.spotifycdn.com/playlist-covers-mix/en/evening_default.jpg".into(),
        );
        attributes.picture_size.push(picture);
        assert_eq!(
            playlist_cover(&attributes).as_deref(),
            Some(attributes.picture_size[0].url())
        );
    }

    #[test]
    fn skips_unplayable_cards_without_shortening_the_next_page_offset() {
        let body = json!({"data": {"homeSections": {"sections": [{"sectionItems": {
            "totalCount": 12,
            "items": [
                {"content": {"data": {"__typename": "Playlist", "uri": format!("spotify:playlist:{}", SpotifyProvider::DAYLIST), "name": "daylist"}}},
                {"content": {"data": {"__typename": "Playlist", "uri": format!("spotify:playlist:{SPOTIFY_DJ}"), "name": "DJ"}}},
                {"content": {"data": {"__typename": "Album", "name": "Ignored"}}}
            ]
        }}]}}});
        let (mixes, count, more) = section_page(&body, 4, MADE_FOR_YOU_TITLE).unwrap();
        assert_eq!(
            mixes.iter().map(|mix| mix.id.as_str()).collect::<Vec<_>>(),
            [SpotifyProvider::DAYLIST]
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
