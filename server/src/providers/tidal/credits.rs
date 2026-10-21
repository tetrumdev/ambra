use super::*;
use crate::credits::{
    AlbumInfo, Contribution, CreditGroup, album_credits, plain_tidal_text, track_credits,
};
use serde_json::Value;

impl TidalProvider {
    pub async fn track_credits(&self, track_id: &str) -> ProviderResult<Vec<CreditGroup>> {
        validate_track_id(track_id)?;
        let (credits, _) = self
            .v1_api(
                reqwest::Method::GET,
                &format!("tracks/{track_id}/credits?includeContributors=true"),
                &[],
                None,
            )
            .await?;
        Ok(tidal_credits(&credits))
    }

    pub async fn album_info(&self, album_id: &str) -> ProviderResult<AlbumInfo> {
        validate_album_id(album_id)?;
        let mut tracks = Vec::new();
        let mut copyright = None;
        let mut offset = 0;
        loop {
            let (page, _) = self
                .v1_api(
                    reqwest::Method::GET,
                    &format!(
                        "albums/{album_id}/items/credits?replace=true&includeContributors=true&limit=100&offset={offset}"
                    ),
                    &[],
                    None,
                )
                .await?;
            let items = page["items"]
                .as_array()
                .ok_or_else(|| io::Error::other("Tidal returned invalid album credits"))?;
            for item in items {
                if copyright.is_none() {
                    copyright = item["item"]["copyright"].as_str().map(str::to_owned);
                }
                tracks.push(tidal_credits(&item["credits"]));
            }
            offset += items.len();
            if items.is_empty() || offset as u64 >= page["totalNumberOfItems"].as_u64().unwrap_or(0)
            {
                break;
            }
        }
        // Most albums have no review.
        let review = self
            .v1_api(
                reqwest::Method::GET,
                &format!("albums/{album_id}/review"),
                &[],
                None,
            )
            .await
            .ok()
            .map(|(review, _)| review);
        Ok(AlbumInfo {
            source: Some(MusicProvider::Tidal),
            description: review
                .as_ref()
                .and_then(|review| review["text"].as_str())
                .map(plain_tidal_text)
                .filter(|text| !text.trim().is_empty()),
            description_source: review
                .as_ref()
                .and_then(|review| review["source"].as_str())
                .map(str::to_owned),
            label: None,
            copyright,
            credits: album_credits(tracks),
        })
    }
}

fn tidal_credits(credits: &Value) -> Vec<CreditGroup> {
    track_credits(credits.as_array().into_iter().flatten().flat_map(|credit| {
        let role = credit["type"].as_str().unwrap_or_default().to_owned();
        credit["contributors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(move |contributor| {
                contributor["name"].as_str().map(|name| Contribution {
                    name: name.to_owned(),
                    role: role.clone(),
                })
            })
    }))
}
