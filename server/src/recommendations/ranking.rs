use std::collections::BTreeMap;

use super::{
    database::{Artist, Database},
    taste::Taste,
};

const HIERARCHY_WEIGHT: f64 = 0.2;
const COMBINATION_BONUS: f64 = 0.18;
const ROTATION_WEIGHT: f64 = 0.25;
const DIVERSITY_PENALTY: f64 = 0.6;
const SAVED_ARTIST_WEIGHT: f64 = 0.25;
const LISTENED_ARTIST_WEIGHT: f64 = 0.15;
const GENRE_ARTIST_BUDGET: usize = 4096;
pub const CANDIDATE_BUDGET: usize = 24;

#[derive(Clone, Debug)]
pub struct Candidate {
    pub artist: Artist,
    pub reason: String,
}

/// Fixed integer mixing, independent of hash-map seeds, process, client or platform.
pub fn rotation(identity: u64, day: u64) -> f64 {
    let mut x = identity.wrapping_add(day.wrapping_mul(0x9e3779b97f4a7c15));
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
    ((x ^ (x >> 31)) >> 11) as f64 / ((1u64 << 53) as f64)
}

pub fn rank(db: &Database, taste: &Taste, day: u64) -> rusqlite::Result<Vec<Candidate>> {
    let mut genre_weights = BTreeMap::<i64, (f64, String)>::new();
    for (&genre, &weight) in &taste.genres {
        let (name, _) = db.genre_info(genre)?;
        genre_weights.entry(genre).or_insert((0.0, name.clone())).0 += weight;
        for related in db.related_genres(genre)? {
            let contribution = weight * HIERARCHY_WEIGHT;
            let entry = genre_weights.entry(related).or_insert((0.0, name.clone()));
            entry.0 += contribution;
            // The explanation always names the user's source genre, including hierarchy hops.
        }
    }
    let mut scores = BTreeMap::<i64, (f64, usize, i64, f64, String)>::new();
    for (genre, (weight, reason)) in genre_weights {
        let (_, count) = db.genre_info(genre)?;
        let specificity = (1.0 + db.artist_count / count.max(1.0)).ln();
        let contribution = weight * specificity;
        // Broad genres use a daily rotating contiguous indexed slice; niche genres are exhaustive.
        let offset = if count as usize > GENRE_ARTIST_BUDGET {
            (rotation(genre as u64, day) * (count as usize - GENRE_ARTIST_BUDGET + 1) as f64)
                as usize
        } else {
            0
        };
        for artist in db.genre_artists(genre, GENRE_ARTIST_BUDGET, offset)? {
            let score =
                scores
                    .entry(artist)
                    .or_insert((0.0, 0, genre, contribution, reason.clone()));
            score.0 += contribution;
            score.1 += 1;
            if contribution > score.3 {
                score.2 = genre;
                score.3 = contribution;
                score.4 = reason.clone();
            }
        }
    }
    let mut candidates = scores
        .into_iter()
        .map(|(id, (weight, genres, genre, _, reason))| {
            let discovery = if taste.listened.contains_key(&id) {
                LISTENED_ARTIST_WEIGHT / (1.0 + taste.listened[&id])
            } else if taste.saved_artists.contains(&id) {
                SAVED_ARTIST_WEIGHT
            } else {
                1.0
            };
            let score = weight
                * (1.0 + COMBINATION_BONUS * (genres - 1).min(4) as f64)
                * discovery
                * (1.0 + ROTATION_WEIGHT * rotation(id as u64, day));
            (id, score, genre, reason)
        })
        .collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut selected_genres = BTreeMap::<i64, usize>::new();
    while !candidates.is_empty() && result.len() < CANDIDATE_BUDGET {
        let adjusted = |candidate: &(i64, f64, i64, String)| {
            candidate.1
                / (1.0
                    + DIVERSITY_PENALTY * *selected_genres.get(&candidate.2).unwrap_or(&0) as f64)
        };
        let index = candidates
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| adjusted(a).total_cmp(&adjusted(b)).then(b.0.cmp(&a.0)))
            .unwrap()
            .0;
        let (id, _, genre, reason) = candidates.swap_remove(index);
        *selected_genres.entry(genre).or_default() += 1;
        result.push(Candidate {
            artist: db.artist(id)?,
            reason: format!("Because you listen to {reason}"),
        });
    }
    Ok(result)
}
