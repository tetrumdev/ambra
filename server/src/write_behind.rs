//! Coalesced persistence for in-memory caches.
//!
//! The provider metadata caches used to serialize and rewrite the *entire* cache
//! file synchronously (while holding the cache lock) for every single track that
//! was looked up. Syncing an album into a library with M cached tracks therefore
//! cost N full rewrites of an M-track file. Here a burst of inserts schedules one
//! write; it runs on the blocking pool after a short delay and persists whatever
//! the cache holds at that moment.
//!
//! The data are caches, so a crash can lose at most the last `SAVE_DELAY` of
//! inserts; they are simply fetched again.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::Duration,
};

use serde::Serialize;
use tokio::sync::Mutex;

const SAVE_DELAY: Duration = Duration::from_millis(1500);

type Writer<V> = fn(&Path, &HashMap<String, V>) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;

fn pending() -> &'static StdMutex<HashSet<PathBuf>> {
    static PENDING: OnceLock<StdMutex<HashSet<PathBuf>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

pub fn schedule<V>(
    cache: Arc<Mutex<HashMap<String, V>>>,
    path: Arc<PathBuf>,
    label: &'static str,
    write: Writer<V>,
) where
    V: Serialize + Send + 'static,
{
    schedule_after(SAVE_DELAY, cache, path, label, write);
}

pub fn schedule_after<V>(
    delay: Duration,
    cache: Arc<Mutex<HashMap<String, V>>>,
    path: Arc<PathBuf>,
    label: &'static str,
    write: Writer<V>,
) where
    V: Serialize + Send + 'static,
{
    // One outstanding write per file; inserts made before it fires ride along.
    let claimed = pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(path.as_ref().clone());
    if !claimed {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        // Release the claim *before* snapshotting so an insert that lands while
        // the write runs schedules a follow-up instead of being lost.
        pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(path.as_ref());
        let guard = cache.lock_owned().await;
        let result = tokio::task::spawn_blocking(move || write(&path, &guard)).await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("Could not persist {label}: {error}"),
            Err(error) => eprintln!("Could not persist {label}: {error}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static WRITES: AtomicUsize = AtomicUsize::new(0);
    static LAST_LEN: AtomicUsize = AtomicUsize::new(0);

    fn counting_writer(
        _: &Path,
        cache: &HashMap<String, u32>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        WRITES.fetch_add(1, Ordering::SeqCst);
        LAST_LEN.store(cache.len(), Ordering::SeqCst);
        Ok(())
    }

    fn write_json(
        path: &Path,
        cache: &HashMap<String, serde_json::Value>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, serde_json::to_vec(cache)?)?;
        std::fs::rename(temporary, path)?;
        Ok(())
    }

    /// `cargo test --release write_behind_benchmark -- --nocapture`
    /// Adding an album of 20 tracks to a library that already has 10,000 cached.
    #[tokio::test]
    async fn write_behind_benchmark() {
        let entry = |index: usize| {
            serde_json::json!({
                "id": format!("tidal:{index}"),
                "title": format!("Track {index}"),
                "padding": "x".repeat(700),
            })
        };
        let base: HashMap<String, serde_json::Value> =
            (0..10_000).map(|index| (index.to_string(), entry(index))).collect();
        let directory = std::env::temp_dir().join(format!("ambra-wb-bench-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();

        // Old behaviour: serialize and rewrite the whole file under the lock per insert.
        let mut old_cache = base.clone();
        let old_path = directory.join("old.json");
        let started = std::time::Instant::now();
        for index in 10_000..10_020 {
            old_cache.insert(index.to_string(), entry(index));
            write_json(&old_path, &old_cache).unwrap();
        }
        let old = started.elapsed();

        // New behaviour: inserts return immediately; one write follows.
        let cache = Arc::new(Mutex::new(base));
        let new_path = Arc::new(directory.join("new.json"));
        let started = std::time::Instant::now();
        for index in 10_000..10_020 {
            cache.lock().await.insert(index.to_string(), entry(index));
            schedule_after(Duration::from_millis(20), cache.clone(), new_path.clone(), "bench", write_json);
        }
        let caller_blocked = started.elapsed();
        tokio::time::sleep(Duration::from_millis(400)).await;
        let on_disk: HashMap<String, serde_json::Value> =
            serde_json::from_slice(&std::fs::read(new_path.as_ref()).unwrap()).unwrap();
        assert_eq!(on_disk.len(), 10_020);
        println!(
            "20 inserts into a 10,000-entry cache: old {old:?} blocked in the request path; new {caller_blocked:?} in the request path (write happens after, off-thread)"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_burst_of_inserts_becomes_one_write_with_everything() {
        let cache = Arc::new(Mutex::new(HashMap::new()));
        let path = Arc::new(PathBuf::from("/tmp/ambra-write-behind-burst"));
        for index in 0..200u32 {
            cache.lock().await.insert(index.to_string(), index);
            schedule_after(
                Duration::from_millis(40),
                cache.clone(),
                path.clone(),
                "test cache",
                counting_writer,
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(WRITES.load(Ordering::SeqCst), 1, "200 inserts coalesce");
        assert_eq!(LAST_LEN.load(Ordering::SeqCst), 200);

        // A later insert schedules a fresh write rather than being dropped.
        cache.lock().await.insert("late".into(), 1);
        schedule_after(
            Duration::from_millis(10),
            cache.clone(),
            path.clone(),
            "test cache",
            counting_writer,
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(WRITES.load(Ordering::SeqCst), 2);
        assert_eq!(LAST_LEN.load(Ordering::SeqCst), 201);
    }
}
