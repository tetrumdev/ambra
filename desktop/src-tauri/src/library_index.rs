//! Incremental library scanning.
//!
//! A full scan reads tags (and possibly rewrites FLAC headers) for every file on
//! every launch, which is O(library) disk and CPU work for information that
//! almost never changes. The index remembers each file's size and modification
//! time; `reconcile` reuses the stored track for unchanged files, reads only new
//! or modified ones, and drops entries for files that disappeared.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicUsize, Ordering},
    thread,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry<T> {
    pub path: String,
    pub size: u64,
    pub modified_ms: u64,
    pub track: T,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileStamp {
    pub path: String,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, PartialEq, Eq, Default, Clone, Copy)]
pub struct ScanStats {
    pub reused: usize,
    pub read: usize,
    pub failed: usize,
    pub removed: usize,
}

impl ScanStats {
    pub fn changed(&self) -> bool {
        self.read > 0 || self.failed > 0 || self.removed > 0
    }
}

pub struct Reconciled<T> {
    pub entries: Vec<IndexEntry<T>>,
    pub stats: ScanStats,
}

/// Number of tag-reading threads. Leaves a core free for audio and the UI.
pub fn default_workers() -> usize {
    thread::available_parallelism()
        .map(|cores| cores.get().saturating_sub(1))
        .unwrap_or(1)
        .clamp(1, 4)
}

/// Keep `previous` entries whose file is unchanged and still `is_reusable`, read
/// the rest with `read` on up to `workers` threads, and preserve the order of
/// `files` in the result.
pub fn reconcile<T, F, R>(
    previous: Vec<IndexEntry<T>>,
    files: &[FileStamp],
    is_reusable: F,
    read: R,
    workers: usize,
) -> Reconciled<T>
where
    T: Send,
    F: Fn(&IndexEntry<T>) -> bool,
    R: Fn(&FileStamp) -> Option<T> + Sync,
{
    let mut remembered: HashMap<String, IndexEntry<T>> = previous
        .into_iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect();

    let mut slots: Vec<Option<IndexEntry<T>>> = Vec::with_capacity(files.len());
    let mut misses = Vec::new();
    let mut stats = ScanStats::default();
    for (index, file) in files.iter().enumerate() {
        match remembered.remove(&file.path) {
            Some(entry)
                if entry.size == file.size
                    && entry.modified_ms == file.modified_ms
                    && is_reusable(&entry) =>
            {
                stats.reused += 1;
                slots.push(Some(entry));
            }
            _ => {
                misses.push(index);
                slots.push(None);
            }
        }
    }
    stats.removed = remembered.len();
    stats.read = misses.len();

    let next = AtomicUsize::new(0);
    let workers = workers.clamp(1, misses.len().max(1));
    let mut read_results: Vec<(usize, Option<T>)> = Vec::with_capacity(misses.len());
    thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut local = Vec::new();
                    loop {
                        let claimed = next.fetch_add(1, Ordering::Relaxed);
                        let Some(&file_index) = misses.get(claimed) else {
                            break;
                        };
                        local.push((file_index, read(&files[file_index])));
                    }
                    local
                })
            })
            .collect();
        for handle in handles {
            if let Ok(local) = handle.join() {
                read_results.extend(local);
            }
        }
    });

    for (file_index, track) in read_results {
        match track {
            Some(track) => {
                let file = &files[file_index];
                slots[file_index] = Some(IndexEntry {
                    path: file.path.clone(),
                    size: file.size,
                    modified_ms: file.modified_ms,
                    track,
                });
            }
            None => stats.failed += 1,
        }
    }
    stats.read -= stats.failed.min(stats.read);

    Reconciled {
        entries: slots.into_iter().flatten().collect(),
        stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn stamp(path: &str, size: u64, modified_ms: u64) -> FileStamp {
        FileStamp {
            path: path.to_owned(),
            size,
            modified_ms,
        }
    }

    fn entry(path: &str, size: u64, modified_ms: u64, track: &str) -> IndexEntry<String> {
        IndexEntry {
            path: path.to_owned(),
            size,
            modified_ms,
            track: track.to_owned(),
        }
    }

    #[test]
    fn unchanged_files_are_not_read_again() {
        let reads = Mutex::new(Vec::new());
        let result = reconcile(
            vec![entry("a", 1, 10, "old-a"), entry("b", 2, 20, "old-b")],
            &[stamp("a", 1, 10), stamp("b", 2, 20)],
            |_| true,
            |file| {
                reads.lock().unwrap().push(file.path.clone());
                Some(format!("new-{}", file.path))
            },
            4,
        );
        assert!(reads.lock().unwrap().is_empty());
        assert_eq!(
            result.stats,
            ScanStats {
                reused: 2,
                read: 0,
                failed: 0,
                removed: 0
            }
        );
        assert!(!result.stats.changed());
        assert_eq!(result.entries[0].track, "old-a");
    }

    #[test]
    fn new_modified_and_removed_files_are_reconciled_in_order() {
        let reads = Mutex::new(Vec::new());
        let result = reconcile(
            vec![
                entry("keep", 1, 1, "kept"),
                entry("edit", 1, 1, "stale"),
                entry("gone", 1, 1, "x"),
            ],
            &[stamp("new", 5, 5), stamp("edit", 2, 1), stamp("keep", 1, 1)],
            |_| true,
            |file| {
                reads.lock().unwrap().push(file.path.clone());
                Some(format!("read-{}", file.path))
            },
            2,
        );
        let mut read = reads.into_inner().unwrap();
        read.sort();
        assert_eq!(read, ["edit", "new"]);
        let tracks: Vec<_> = result
            .entries
            .iter()
            .map(|entry| entry.track.as_str())
            .collect();
        assert_eq!(tracks, ["read-new", "read-edit", "kept"]);
        assert_eq!(
            result.stats,
            ScanStats {
                reused: 1,
                read: 2,
                failed: 0,
                removed: 1
            }
        );
        assert!(result.stats.changed());
    }

    #[test]
    fn entries_that_are_no_longer_reusable_are_reread() {
        let result = reconcile(
            vec![entry("a", 1, 1, "missing-cache")],
            &[stamp("a", 1, 1)],
            |entry| entry.track != "missing-cache",
            |_| Some("rebuilt".to_owned()),
            1,
        );
        assert_eq!(result.entries[0].track, "rebuilt");
        assert_eq!(result.stats.read, 1);
    }

    #[test]
    fn unreadable_files_are_dropped_and_counted() {
        let result: Reconciled<String> = reconcile(
            Vec::new(),
            &[stamp("bad", 1, 1), stamp("good", 1, 1)],
            |_| true,
            |file| (file.path == "good").then(|| "ok".to_owned()),
            3,
        );
        assert_eq!(result.entries.len(), 1);
        assert_eq!(
            result.stats,
            ScanStats {
                reused: 0,
                read: 1,
                failed: 1,
                removed: 0
            }
        );
    }

    #[test]
    fn many_files_are_read_exactly_once_in_parallel() {
        let files: Vec<_> = (0..500)
            .map(|index| stamp(&format!("f{index}"), 1, 1))
            .collect();
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let result = reconcile(
            Vec::new(),
            &files,
            |_: &IndexEntry<usize>| true,
            |file| {
                reads.fetch_add(1, Ordering::Relaxed);
                file.path[1..].parse::<usize>().ok()
            },
            4,
        );
        assert_eq!(reads.load(Ordering::Relaxed), 500);
        assert!(
            result
                .entries
                .iter()
                .enumerate()
                .all(|(index, entry)| entry.track == index)
        );
    }
}
