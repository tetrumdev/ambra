//! Song details a service was asked for, kept on disk one row per song.
//!
//! Spotify's were one JSON file read whole into memory at every start and rewritten whole
//! after every burst of new songs. Every search result lands there, so it only grows: tens
//! of thousands of songs and tens of megabytes within months. Here a lookup reads one row,
//! a new song writes one row, and nothing is held in memory but SQLite's small page cache.
//!
//! The rows are a cache: anything missing or unreadable is fetched from the service again.

use std::{
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

/// Songs kept before the least recently used are dropped.
const MAX_SONGS: i64 = 100_000;
/// How many new songs pass between checks of that limit.
const PRUNE_EVERY: u32 = 512;
/// A song's last use is rewritten at most this often, so reading doesn't mean writing.
const TOUCH_AFTER_SECONDS: i64 = 24 * 60 * 60;

pub struct MetadataStore {
    connection: Mutex<Connection>,
    inserted: Mutex<u32>,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs() as i64)
}

fn prepare(connection: &Connection) -> rusqlite::Result<()> {
    // A cache: losing the last moments of it to a power cut costs a refetch.
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.execute_batch(
        // An ordinary table: a song's kilobyte of details fits beside others in one page. Keyed
        // by ID alone (WITHOUT ROWID), each spilled onto a page of its own and the file tripled.
        "CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, used INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS songs_used ON songs (used);",
    )
}

impl MetadataStore {
    /// Opens (or creates) the store at `path`. If that fails, songs are kept for this run only.
    /// A cache file from before (`legacy_json`, one object of songs by ID) is taken in once and removed.
    pub fn open(path: &Path, legacy_json: Option<&Path>, label: &str) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let opened = Connection::open(path).and_then(|connection| prepare(&connection).map(|()| connection));
        let connection = match opened {
            Ok(connection) => connection,
            Err(error) => {
                eprintln!("Could not open {label}: {error}");
                return Self::in_memory();
            }
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        let store = Self { connection: Mutex::new(connection), inserted: Mutex::new(0) };
        if let Some(legacy) = legacy_json.filter(|legacy| legacy.exists()) {
            match store.import(legacy) {
                Ok(songs) => {
                    eprintln!("Moved {songs} songs into {label}");
                    let _ = std::fs::remove_file(legacy);
                }
                // Left in place to be tried again at the next start.
                Err(error) => eprintln!("Could not move the old cache into {label}: {error}"),
            }
        }
        store
    }

    pub fn in_memory() -> Self {
        let connection = Connection::open_in_memory().expect("SQLite opens an in-memory database");
        prepare(&connection).expect("SQLite creates the songs table");
        Self { connection: Mutex::new(connection), inserted: Mutex::new(0) }
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.connection.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads the old file one song at a time, so its size never becomes this process's.
    fn import(&self, legacy: &Path) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let reader = std::io::BufReader::new(std::fs::File::open(legacy)?);
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        let count = {
            let mut insert = transaction.prepare("INSERT OR IGNORE INTO songs (id, metadata, used) VALUES (?1, ?2, ?3)")?;
            let used = now();
            let mut count = 0usize;
            let mut failed: Option<rusqlite::Error> = None;
            let mut deserializer = serde_json::Deserializer::from_reader(reader);
            serde::de::DeserializeSeed::deserialize(
                EachSong(&mut |id: String, song: serde_json::Value| {
                    if failed.is_some() { return; }
                    match insert.execute(params![id, song.to_string(), used]) {
                        Ok(_) => count += 1,
                        Err(error) => failed = Some(error),
                    }
                }),
                &mut deserializer,
            )?;
            if let Some(error) = failed { return Err(error.into()); }
            count
        };
        transaction.commit()?;
        Ok(count)
    }

    pub fn get<T: DeserializeOwned>(&self, id: &str) -> Option<T> {
        let connection = self.connection();
        let (metadata, used): (String, i64) = connection
            .prepare_cached("SELECT metadata, used FROM songs WHERE id = ?1")
            .and_then(|mut select| select.query_row(params![id], |row| Ok((row.get(0)?, row.get(1)?))).optional())
            .ok()
            .flatten()?;
        let now = now();
        if now - used > TOUCH_AFTER_SECONDS {
            let _ = connection
                .prepare_cached("UPDATE songs SET used = ?1 WHERE id = ?2")
                .and_then(|mut touch| touch.execute(params![now, id]));
        }
        // A row written by a version with other fields is simply fetched again.
        serde_json::from_str(&metadata).ok()
    }

    pub fn insert<T: Serialize>(&self, id: &str, value: &T) {
        let Ok(metadata) = serde_json::to_string(value) else { return };
        let connection = self.connection();
        let saved = connection
            .prepare_cached("INSERT INTO songs (id, metadata, used) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata, used = excluded.used")
            .and_then(|mut insert| insert.execute(params![id, metadata, now()]));
        if let Err(error) = saved {
            eprintln!("Could not keep song details: {error}");
            return;
        }
        let mut inserted = self.inserted.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *inserted += 1;
        if *inserted % PRUNE_EVERY == 0 {
            // Down to nine tenths of the limit, so this runs rarely rather than on every song after.
            let _ = connection.execute(
                "DELETE FROM songs WHERE (SELECT COUNT(*) FROM songs) > ?1 AND id IN (SELECT id FROM songs ORDER BY used LIMIT max(0, (SELECT COUNT(*) FROM songs) - ?2))",
                params![MAX_SONGS, MAX_SONGS / 10 * 9],
            );
        }
    }

    #[cfg(test)]
    fn len(&self) -> i64 {
        self.connection().query_row("SELECT COUNT(*) FROM songs", [], |row| row.get(0)).unwrap()
    }
}

/// Calls its function with each entry of a JSON object as it is parsed.
struct EachSong<'a>(&'a mut dyn FnMut(String, serde_json::Value));
impl<'de> serde::de::DeserializeSeed<'de> for EachSong<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> serde::de::Visitor<'de> for EachSong<'_> {
    type Value = ();
    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("an object of songs by ID")
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut songs: A) -> Result<(), A::Error> {
        while let Some((id, song)) = songs.next_entry::<String, serde_json::Value>()? {
            (self.0)(id, song);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn directory() -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("ambra-metadata-store-{}-{}", std::process::id(), crate::server_config::random_hex(6)));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn songs_survive_a_restart_and_the_old_cache_file_is_taken_in_once() {
        let directory = directory();
        let (path, legacy) = (directory.join("songs.sqlite"), directory.join("songs.json"));
        std::fs::write(&legacy, json!({ "one": { "title": "One" }, "two": { "title": "Two \"quoted\"" } }).to_string()).unwrap();
        let store = MetadataStore::open(&path, Some(&legacy), "test songs");
        assert!(!legacy.exists(), "the old file is removed once its songs are in");
        assert_eq!(store.get::<Value>("two").unwrap()["title"], "Two \"quoted\"");
        assert!(store.get::<Value>("missing").is_none());
        store.insert("three", &json!({ "title": "Three" }));
        store.insert("one", &json!({ "title": "One again" }));
        drop(store);

        let store = MetadataStore::open(&path, Some(&legacy), "test songs");
        assert_eq!(store.len(), 3);
        assert_eq!(store.get::<Value>("one").unwrap()["title"], "One again");
        assert_eq!(store.get::<Value>("three").unwrap()["title"], "Three");
        // A row another version wrote in a shape this one can't read is a miss, not an error.
        assert!(store.get::<Vec<u8>>("three").is_none());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn an_unreadable_old_cache_is_left_alone_and_the_store_still_works() {
        let directory = directory();
        let (path, legacy) = (directory.join("songs.sqlite"), directory.join("songs.json"));
        std::fs::write(&legacy, b"{ \"one\": { \"title\": \"One\" }, broken").unwrap();
        let store = MetadataStore::open(&path, Some(&legacy), "test songs");
        assert!(legacy.exists());
        assert_eq!(store.len(), 0, "a half-read file adds nothing");
        store.insert("new", &json!({ "title": "New" }));
        assert!(store.get::<Value>("new").is_some());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn the_least_recently_used_songs_leave_once_there_are_too_many() {
        let store = MetadataStore::in_memory();
        {
            let mut connection = store.connection();
            let transaction = connection.transaction().unwrap();
            {
                let mut insert = transaction.prepare("INSERT INTO songs (id, metadata, used) VALUES (?1, '{}', ?2)").unwrap();
                for index in 0..MAX_SONGS + 100 {
                    insert.execute(params![format!("old-{index}"), index]).unwrap();
                }
            }
            transaction.commit().unwrap();
        }
        for index in 0..PRUNE_EVERY {
            store.insert(&format!("new-{index}"), &json!({}));
        }
        assert_eq!(store.len(), MAX_SONGS / 10 * 9);
        assert!(store.get::<Value>("old-0").is_none(), "the oldest went first");
        assert!(store.get::<Value>(&format!("new-{}", PRUNE_EVERY - 1)).is_some());
    }
}
