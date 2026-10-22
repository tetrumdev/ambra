//! Liner notes: who made each recording and release, grouped by what they did.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::models::MusicProvider;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditGroup {
    pub role: String,
    pub names: Vec<String>,
    /// The source catalog's artist ID for each name that has an artist page there.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub artist_ids: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackCredits {
    /// The catalog the credits came from; none when no catalog had them.
    pub source: Option<MusicProvider>,
    pub credits: Vec<CreditGroup>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumContributor {
    pub name: String,
    /// The source catalog's artist ID, when they have an artist page there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_id: Option<String>,
    /// Positions in the tracklist; empty when they are on every track.
    pub tracks: Vec<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumCreditGroup {
    pub role: String,
    pub contributors: Vec<AlbumContributor>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumInfo {
    pub source: Option<MusicProvider>,
    pub description: Option<String>,
    pub description_source: Option<String>,
    pub label: Option<String>,
    pub copyright: Option<String>,
    pub credits: Vec<AlbumCreditGroup>,
}

pub struct Contribution {
    pub name: String,
    pub role: String,
    /// The catalog's artist ID, when the catalog links the credit to an artist page.
    pub artist_id: Option<String>,
}

/// Who performed and wrote it come first, as on a sleeve; everyone else follows in catalog order.
const LEADING_ROLES: &[&str] = &[
    "main artist",
    "featured artist",
    "composer",
    "lyricist",
    "songwriter",
    "writer",
    "producer",
];

fn role_rank(role: &str) -> usize {
    LEADING_ROLES
        .iter()
        .position(|leading| leading.eq_ignore_ascii_case(role))
        .unwrap_or(LEADING_ROLES.len())
}

pub fn track_credits(contributions: impl IntoIterator<Item = Contribution>) -> Vec<CreditGroup> {
    let mut groups: Vec<CreditGroup> = Vec::new();
    for contribution in contributions {
        let (name, role) = (contribution.name.trim(), contribution.role.trim());
        if name.is_empty() || role.is_empty() {
            continue;
        }
        let index = match groups
            .iter()
            .position(|group| group.role.eq_ignore_ascii_case(role))
        {
            Some(index) => index,
            None => {
                groups.push(CreditGroup {
                    role: role.to_owned(),
                    names: Vec::new(),
                    artist_ids: BTreeMap::new(),
                });
                groups.len() - 1
            }
        };
        let group = &mut groups[index];
        if !group.names.iter().any(|existing| existing == name) {
            group.names.push(name.to_owned());
        }
        if let Some(id) = contribution.artist_id.filter(|id| !id.is_empty()) {
            group.artist_ids.entry(name.to_owned()).or_insert(id);
        }
    }
    groups.sort_by_key(|group| role_rank(&group.role));
    groups
}

/// Combines each track's credits, in tracklist order, into the album's.
pub fn album_credits(tracks: Vec<Vec<CreditGroup>>) -> Vec<AlbumCreditGroup> {
    let count = tracks.len();
    let mut groups: Vec<AlbumCreditGroup> = Vec::new();
    for (index, credits) in tracks.into_iter().enumerate() {
        let position = index as u32 + 1;
        for credit in credits {
            let group = match groups
                .iter()
                .position(|group| group.role.eq_ignore_ascii_case(&credit.role))
            {
                Some(found) => &mut groups[found],
                None => {
                    groups.push(AlbumCreditGroup {
                        role: credit.role,
                        contributors: Vec::new(),
                    });
                    groups.last_mut().expect("just pushed")
                }
            };
            for name in credit.names {
                let artist_id = credit.artist_ids.get(&name).cloned();
                match group
                    .contributors
                    .iter_mut()
                    .find(|contributor| contributor.name == name)
                {
                    Some(contributor) => {
                        if contributor.tracks.last() != Some(&position) {
                            contributor.tracks.push(position);
                        }
                        if contributor.artist_id.is_none() {
                            contributor.artist_id = artist_id;
                        }
                    }
                    None => group.contributors.push(AlbumContributor {
                        name,
                        artist_id,
                        tracks: vec![position],
                    }),
                }
            }
        }
    }
    for contributor in groups
        .iter_mut()
        .flat_map(|group| group.contributors.iter_mut())
    {
        if contributor.tracks.len() == count {
            contributor.tracks.clear();
        }
    }
    groups.sort_by_key(|group| role_rank(&group.role));
    groups
}

/// Tidal marks artist and album mentions as `[wimpLink artistId="…"]Name[/wimpLink]`.
pub fn plain_tidal_text(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('[') {
        plain.push_str(&rest[..start]);
        let tag = &rest[start..];
        match tag.find(']') {
            Some(end) if tag.starts_with("[wimpLink") || tag.starts_with("[/wimpLink") => {
                rest = &tag[end + 1..];
            }
            _ => {
                plain.push('[');
                rest = &tag[1..];
            }
        }
    }
    plain.push_str(rest);
    plain
}
