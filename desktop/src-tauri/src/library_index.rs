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
