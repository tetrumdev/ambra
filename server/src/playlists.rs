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
    /// Index in the service's full list, which can hold items AMBRA skips (like videos).
    #[serde(skip)]
    pub position: usize,
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
    /// The playlist's tracks in their new order; tracks left out keep their place.
    Reorder {
        #[serde(rename = "trackIds")]
        track_ids: Vec<String>,
        revision: String,
    },
}

/// One reorder step: the `length` items starting at `from` move up to start at `to`.
/// Steps only move items up (`to < from`), where "insert before" and "final index"
/// name the same position on every service.
#[derive(Debug, PartialEq)]
pub struct PlaylistMove {
    pub from: usize,
    pub length: usize,
    pub to: usize,
    /// The moving entries' IDs, for services that move by ID.
    pub entry_ids: Vec<String>,
}

/// Plans the moves that put tracks in `order`, moving as few items as it can.
/// Returns `None` when `order` repeats a track or names one the playlist lacks.
pub fn reorder_moves(entries: &[PlaylistEntry], order: &[String]) -> Option<Vec<PlaylistMove>> {
    let mut rank_of = std::collections::HashMap::new();
    for (index, track) in order.iter().enumerate() {
        if rank_of.insert(track.as_str(), index).is_some() {
            return None;
        }
    }
    if order
        .iter()
        .any(|track| !entries.iter().any(|entry| &entry.track_id == track))
    {
        return None;
    }
    // Repeats of a track stay together, in their current order.
    let mut ranked: Vec<&PlaylistEntry> = entries
        .iter()
        .filter(|entry| rank_of.contains_key(entry.track_id.as_str()))
        .collect();
    ranked.sort_by_key(|entry| (rank_of[entry.track_id.as_str()], entry.position));
    let length = entries
        .iter()
        .map(|entry| entry.position + 1)
        .max()
        .unwrap_or(0);
    let mut slots: Vec<(Option<&str>, Option<usize>)> = vec![(None, None); length];
    for entry in entries {
        slots[entry.position].0 = Some(&entry.id);
    }
    for (rank, entry) in ranked.iter().enumerate() {
        slots[entry.position].1 = Some(rank);
    }

    // Items on the longest already-ordered run stay put; every other item moves once.
    let ranks: Vec<usize> = slots.iter().filter_map(|slot| slot.1).collect();
    let mut tails: Vec<usize> = Vec::new();
    let mut previous = vec![usize::MAX; ranks.len()];
    for (index, &rank) in ranks.iter().enumerate() {
        let at = tails.partition_point(|&tail| ranks[tail] < rank);
        if at > 0 {
            previous[index] = tails[at - 1];
        }
        if at == tails.len() {
            tails.push(index);
        } else {
            tails[at] = index;
        }
    }
    let mut placed = vec![false; ranks.len()];
    let mut index = tails.last().copied().unwrap_or(usize::MAX);
    while index != usize::MAX {
        placed[ranks[index]] = true;
        index = previous[index];
    }

    let mut moves = Vec::new();
    for rank in 0..ranks.len() {
        if placed[rank] {
            continue;
        }
        let at = |wanted: usize, slots: &[(Option<&str>, Option<usize>)]| {
            slots.iter().position(|slot| slot.1 == Some(wanted))
        };
        let from = at(rank, &slots)?;
        let before = if rank > 0 {
            at(rank - 1, &slots)? + 1
        } else {
            slots
                .iter()
                .position(|slot| slot.1.is_some_and(|rank| placed[rank]))?
        };
        // Moving down is the items in between moving up past it.
        let (start, count, to) = if before < from {
            (from, 1, before)
        } else if before > from + 1 {
            (from + 1, before - from - 1, from)
        } else {
            placed[rank] = true;
            continue;
        };
        moves.push(PlaylistMove {
            from: start,
            length: count,
            to,
            entry_ids: slots[start..start + count]
                .iter()
                .filter_map(|slot| slot.0.map(str::to_owned))
                .collect(),
        });
        slots[to..start + count].rotate_right(count);
        placed[rank] = true;
    }
    Some(moves)
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
