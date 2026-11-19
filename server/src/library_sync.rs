//! Process-scoped library cursors. Old or unknown cursors fall back to a snapshot.
use std::collections::VecDeque;

use serde::Serialize;
use tokio::sync::watch;

#[derive(Clone, Default, Serialize)]
pub struct Versions {
    pub local: String,
    pub streaming: String,
}

pub type Events = watch::Sender<Versions>;

const MAX_CHANGES: usize = 4096;

#[derive(Clone)]
pub enum Change<T> {
    Upsert(T),
    Refresh(T),
    Remove(String),
}

pub struct Journal<T> {
    epoch: String,
    revision: u64,
    history: VecDeque<(u64, usize, Vec<T>)>,
    changes: usize,
}

impl<T> Default for Journal<T> {
    fn default() -> Self {
        Self {
            epoch: crate::server_config::random_hex(16),
            revision: 0,
            history: VecDeque::new(),
            changes: 0,
        }
    }
}

impl<T> Journal<T> {
    pub fn cursor(&self) -> String {
        format!("{}:{}", self.epoch, self.revision)
    }

    /// Invalidates existing cursors when the whole view may have changed.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn record(&mut self, changed: Vec<T>) {
        let weight = changed.len();
        self.record_weighted(changed, weight);
    }

    pub fn record_weighted(&mut self, changed: Vec<T>, weight: usize) {
        if changed.is_empty() {
            return;
        }
        self.revision += 1;
        self.changes += weight;
        self.history.push_back((self.revision, weight, changed));
        while self.changes > MAX_CHANGES {
            self.changes -= self.history.pop_front().unwrap().1;
        }
    }

    pub fn since(&self, cursor: &str) -> Option<impl DoubleEndedIterator<Item = &T>> {
        let (epoch, revision) = cursor.split_once(':')?;
        let revision: u64 = revision.parse().ok()?;
        let oldest = self
            .history
            .front()
            .map_or(self.revision, |(first, _, _)| first - 1);
        (epoch == self.epoch && (oldest..=self.revision).contains(&revision)).then(|| {
            self.history
                .iter()
                .filter(move |(at, _, _)| *at > revision)
                .flat_map(|(_, _, changes)| changes)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_cover_reconnects_and_only_the_retained_history() {
        let mut journal = Journal::default();
        let first = journal.cursor();
        journal.record(vec![1, 2]);
        let middle = journal.cursor();
        journal.record(vec![3]);
        assert_eq!(
            journal.since(&first).unwrap().copied().collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert_eq!(
            journal.since(&middle).unwrap().copied().collect::<Vec<_>>(),
            [3]
        );
        assert_eq!(journal.since(&journal.cursor()).unwrap().count(), 0);

        journal.record(vec![4; MAX_CHANGES]);
        assert!(journal.since(&first).is_none());
        assert!(journal.since(&middle).is_none());
        let before_reset = journal.cursor();
        journal.reset();
        assert!(journal.since(&before_reset).is_none());
    }
}
