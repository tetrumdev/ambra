use super::*;
use crate::providers::recommendations::{Mix, Recommendations};
use serde_json::Value;
use std::collections::HashSet;
use tidlers::{requests::TidalRequest, urls::WEB_API_V2_LOCATION};

impl TidalProvider {
    pub async fn recommendations(&self) -> ProviderResult<Recommendations> {
        self.recommendation_cache
            .recommendations(async {
                // Tidlers 0.5's HomeFeedWeb enum predates the web feed's current
                // row names. Read only the native mix fields through its transport.
                let feed: Value = self
                    .authenticated_request(|client| async move {
                        let country = client
                            .user_info
                            .as_ref()
                            .ok_or(TidalError::NotAuthenticated)?
                            .country_code
                            .clone();
                        let request = TidalRequest {
                            method: reqwest::Method::GET,
                            path: "/home/feed/static".into(),
                            form: None,
                            params: Some(HashMap::from([
                                ("countryCode".into(), country),
                                ("locale".into(), client.session.locale),
                                ("platform".into(), "WEB".into()),
                                ("deviceType".into(), "BROWSER".into()),
                                ("timeOffset".into(), client.session.time_offset),
                                ("limit".into(), "20".into()),
                            ])),
                            basic_auth: None,
                            access_token: client.session.auth.access_token.clone(),
                            data: None,
                            headers: Some(reqwest::header::HeaderMap::from_iter([(
                                reqwest::header::HeaderName::from_static("x-tidal-client-version"),
                                reqwest::header::HeaderValue::from_static("2026.1.5"),
                            )])),
                            base_url: Some(WEB_API_V2_LOCATION.into()),
                            send_params_as_form: false,
                        };
                        Ok(client
                            .session
                            .auth
                            .rq
                            .request(request)
                            .await?
                            .json()
                            .await?)
                    })
                    .await?;
                let rows = feed
                    .get("items")
                    .and_then(Value::as_array)
                    .ok_or_else(|| io::Error::other("TIDAL did not return a Home feed"))?;
                let mut seen = HashSet::new();
                let mixes = rows
                    .iter()
                    .filter_map(|row| row.get("items")?.as_array())
                    .flatten()
                    .filter_map(personalized_mix)
                    .filter(|mix| seen.insert(mix.id.clone()))
                    .collect();
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
                let mix = self
                    .authenticated_request(|client| async move {
                        client.get_mix_tracks(id.to_owned(), Some(100), None).await
                    })
                    .await?;
                let cache = self.track_metadata_cache.lock().await;
                let mut seen = HashSet::new();
                Ok(mix
                    .items
                    .into_iter()
                    .filter(|track| {
                        track.allow_streaming && track.stream_ready && seen.insert(track.id)
                    })
                    .map(|track| {
                        let id = track.id.to_string();
                        if let Some(metadata) = cache.get(&id) {
                            return metadata.clone();
                        }
                        let quality = match track.audio_quality.as_str() {
                            "HI_RES" | "HI_RES_LOSSLESS" | "LOSSLESS" => "FLAC",
                            "HIGH" => "AAC 320 kbps",
                            other => other,
                        }
                        .to_owned();
                        // Just as with search results, the player resolves the actual
                        // playback format when the track is played.
                        describe_track(
                            track,
                            None,
                            TrackPlaybackMetadata {
                                quality,
                                maximum_sampling_rate_khz: None,
                                maximum_bit_depth: None,
                                bitrate_kbps: None,
                                playback: PlaybackMetadata {
                                    kind: PlaybackKind::Dash,
                                    url: format!("/api/providers/tidal/tracks/{id}/manifest.mpd"),
                                },
                            },
                        )
                    })
                    .collect())
            })
            .await
    }
}

fn personalized_mix(item: &Value) -> Option<Mix> {
    if item.get("type")?.as_str()? != "MIX" {
        return None;
    }
    let data = item.get("data")?;
    let section = match data.get("type")?.as_str()? {
        "DISCOVERY_MIX" => "Discovery",
        "DAILY_MIX" => "Daily mixes",
        "NEW_RELEASE_MIX" => "New releases",
        _ => return None,
    };
    let id = data.get("id")?.as_str()?.to_owned();
    let title = data.pointer("/titleTextInfo/text")?.as_str()?.to_owned();
    let image_url = data
        .get("mixImages")
        .and_then(Value::as_array)
        .and_then(|images| {
            images
                .iter()
                .filter_map(|image| {
                    Some((image.get("url")?.as_str()?, image.get("width")?.as_u64()?))
                })
                .filter(|(url, _)| url.starts_with("https://"))
                .min_by_key(|(_, width)| width.abs_diff(320))
                .map(|(url, _)| url.to_owned())
        });
    Some(Mix {
        id,
        title,
        image_url,
        artwork_fallback: false,
        section,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_three_personal_mix_types_from_the_current_web_shape() {
        for (kind, title, section) in [
            ("DISCOVERY_MIX", "My Daily Discovery", "Discovery"),
            ("DAILY_MIX", "My Mix 1", "Daily mixes"),
            ("NEW_RELEASE_MIX", "My New Arrivals", "New releases"),
        ] {
            let card = json!({"type": "MIX", "data": {
                "type": kind, "id": "mix", "titleTextInfo": {"text": title},
                "mixImages": [{"width": 960, "url": "https://image.example/large"},
                              {"width": 320, "url": "https://image.example/medium"}]
            }});
            let mix = personalized_mix(&card).unwrap();
            assert_eq!(mix.title, title);
            assert_eq!(mix.section, section);
            assert_eq!(
                mix.image_url.as_deref(),
                Some("https://image.example/medium")
            );
        }
        assert!(
            personalized_mix(&json!({"type": "MIX", "data": {
                "type": "ARTIST_MIX", "titleTextInfo": {"text": "Artist radio"}, "id": "radio"
            }}))
            .is_none()
        );
    }
}
