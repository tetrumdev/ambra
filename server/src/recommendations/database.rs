use std::{collections::BTreeMap, io::Read, path::Path};

use rusqlite::{Connection, OpenFlags, params};
use sha2::{Digest, Sha256};

pub const SCHEMA_VERSION: i64 = 1;

/// Deliberately conservative: retain diacritics and word boundaries; never fuzzy-match names.
pub fn normalize(name: &str) -> String {
    name.chars()
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Clone, Debug)]
pub struct Artist {
    pub id: i64,
    pub name: String,
    pub names: Vec<String>,
    pub provider_ids: BTreeMap<String, Vec<String>>,
    pub unambiguous_name: bool,
}

pub struct Database {
    connection: Connection,
    pub artist_count: f64,
}

impl Database {
    /// Lazily unpack the embedded release asset. Every server distribution includes it,
    /// including cargo install and the desktop sidecar. No runtime network dependency.
    pub fn bundled() -> Result<Self, String> {
        // Multiple instances/tests may unpack the same asset in this process. The
        // existing private-file writer uses one temporary path per process.
        static EXTRACTION: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _extraction = EXTRACTION.lock().map_err(|e| e.to_string())?;
        let compressed = include_bytes!("../../assets/recommendations.sqlite.gz");
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../assets/recommendations.sqlite.manifest.json"
        ))
        .map_err(|e| e.to_string())?;
        let expected = manifest["sqliteSha256"]
            .as_str()
            .ok_or("Missing metadata digest")?;
        #[cfg(not(test))]
        let path = crate::storage::cache_path(&format!("recommendations-{expected}.sqlite"));
        #[cfg(test)]
        let path = std::env::temp_dir().join(format!(
            "ambra-test-recommendations-{}-{expected}.sqlite",
            std::process::id()
        ));
        let valid = std::fs::read(&path)
            .is_ok_and(|bytes| format!("{:x}", Sha256::digest(&bytes)) == expected);
        if !valid {
            let mut bytes = Vec::new();
            flate2::read::GzDecoder::new(&compressed[..])
                .take(64 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if format!("{:x}", Sha256::digest(&bytes)) != expected {
                return Err("Bundled recommendation database digest mismatch".into());
            }
            crate::server_config::write_private(&path, &bytes)?;
        }
        Self::open(&path)
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        Self::validate(connection).map_err(|e| e.to_string())
    }

    fn validate(connection: Connection) -> rusqlite::Result<Self> {
        if connection.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?
            != SCHEMA_VERSION
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        connection.execute_batch(
            "PRAGMA query_only=ON; PRAGMA cache_size=-2048; PRAGMA trusted_schema=OFF;",
        )?;
        // Indexed PK lookups validate the tables used at runtime without scanning the asset.
        for table in [
            "artist_mbids",
            "ambiguous_artist_names",
            "artist_aliases",
            "genres",
            "artist_genres",
            "genre_aliases",
            "genre_parents",
            "artist_provider_ids",
            "metadata",
        ] {
            connection.prepare(&format!("SELECT * FROM {table} LIMIT 0"))?;
        }
        let artist_count = connection
            .query_row("SELECT count(*) FROM artists", [], |r| r.get::<_, i64>(0))?
            as f64;
        Ok(Self {
            connection,
            artist_count,
        })
    }

    #[cfg(test)]
    pub fn fixture(sql: &str) -> Self {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../assets/recommendations-schema.sql"))
            .unwrap();
        connection.execute_batch(sql).unwrap();
        Self::validate(connection).unwrap()
    }

    pub fn identify(
        &self,
        name: &str,
        mbid: Option<&str>,
        provider: &str,
        provider_id: &str,
    ) -> rusqlite::Result<Option<i64>> {
        if let Some(mbid) = mbid {
            // An explicit identifier never falls back to a potentially different same-name artist.
            let Ok(mbid) = uuid::Uuid::parse_str(mbid) else {
                return Ok(None);
            };
            let ids = self
                .connection
                .prepare_cached("SELECT artist_id FROM artist_mbids WHERE mbid=? LIMIT 2")?
                .query_map([mbid.as_bytes().as_slice()], |r| r.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok((ids.len() == 1).then(|| ids[0]));
        }
        if !provider_id.is_empty() {
            let ids = self.connection.prepare_cached("SELECT artist_id FROM artist_provider_ids WHERE provider=? AND provider_id=? LIMIT 2")?
                .query_map(params![provider, provider_id], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            if !ids.is_empty() {
                return Ok((ids.len() == 1).then_some(ids[0]));
            }
        }
        let ids = self.connection.prepare_cached("SELECT artist_id FROM artist_aliases WHERE normalized_name=?1 AND NOT EXISTS (SELECT 1 FROM ambiguous_artist_names WHERE normalized_name=?1) LIMIT 2")?
            .query_map([normalize(name)], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        if ids.len() != 1 {
            return Ok(None);
        }
        if !provider_id.is_empty() {
            let mut known = self.connection.prepare_cached(
                "SELECT provider_id FROM artist_provider_ids WHERE artist_id=? AND provider=?",
            )?;
            let identities = known
                .query_map(params![ids[0], provider], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if !identities.is_empty() && !identities.iter().any(|id| id == provider_id) {
                return Ok(None);
            }
        }
        Ok(Some(ids[0]))
    }

    pub fn artist_genres(&self, artist: i64) -> rusqlite::Result<Vec<i64>> {
        self.connection
            .prepare_cached("SELECT genre_id FROM artist_genres WHERE artist_id=?")?
            .query_map([artist], |r| r.get(0))?
            .collect()
    }

    pub fn genre(&self, name: &str) -> rusqlite::Result<Option<i64>> {
        let ids = self
            .connection
            .prepare_cached("SELECT genre_id FROM genre_aliases WHERE normalized_name=? LIMIT 2")?
            .query_map([normalize(name)], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((ids.len() == 1).then(|| ids[0]))
    }

    pub fn genre_info(&self, id: i64) -> rusqlite::Result<(String, f64)> {
        self.connection.query_row(
            "SELECT name,artist_count FROM genres WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as f64)),
        )
    }

    pub fn related_genres(&self, genre: i64) -> rusqlite::Result<Vec<i64>> {
        // Only explicit P279 parent/child edges; no inferred similarity or multi-hop drift.
        self.connection.prepare_cached("SELECT g.id FROM genres g JOIN (SELECT parent_id AS id FROM genre_parents WHERE child_id=?1 UNION SELECT child_id AS id FROM genre_parents WHERE parent_id=?1) edges ON edges.id=g.id WHERE g.artist_count>0 ORDER BY g.artist_count DESC,g.id LIMIT 12")?
            .query_map([genre], |r| r.get(0))?.collect()
    }

    pub fn genre_artists(
        &self,
        genre: i64,
        limit: usize,
        offset: usize,
    ) -> rusqlite::Result<Vec<i64>> {
        self.connection.prepare_cached("SELECT artist_id FROM artist_genres WHERE genre_id=? ORDER BY artist_id LIMIT ? OFFSET ?")?
            .query_map(params![genre, limit as i64, offset as i64], |r| r.get(0))?.collect()
    }

    pub fn artist(&self, id: i64) -> rusqlite::Result<Artist> {
        let name: String =
            self.connection
                .query_row("SELECT name FROM artists WHERE id=?", [id], |r| r.get(0))?;
        let names: Vec<String> = self.connection.prepare_cached("SELECT normalized_name FROM artist_aliases a WHERE artist_id=? AND NOT EXISTS (SELECT 1 FROM ambiguous_artist_names b WHERE b.normalized_name=a.normalized_name)")?
            .query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        let mut provider_ids = BTreeMap::<String, Vec<String>>::new();
        for row in self
            .connection
            .prepare_cached(
                "SELECT provider,provider_id FROM artist_provider_ids WHERE artist_id=?",
            )?
            .query_map([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
        {
            let (provider, identity) = row?;
            provider_ids.entry(provider).or_default().push(identity);
        }
        let unambiguous_name = self.identify(&name, None, "", "")? == Some(id);
        Ok(Artist {
            id,
            name,
            names,
            provider_ids,
            unambiguous_name,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_connection_refuses_writes_and_uses_reverse_genre_index() {
        let db = Database::bundled().unwrap();
        assert!(db.connection.execute("DELETE FROM genres", []).is_err());
        let plan: String = db.connection.query_row(
            "EXPLAIN QUERY PLAN SELECT artist_id FROM artist_genres WHERE genre_id=1 ORDER BY artist_id LIMIT 4096 OFFSET 0",
            [], |row| row.get(3)).unwrap();
        assert!(plan.contains("genre_artists"), "{plan}");
        assert!(!plan.contains("SCAN"), "{plan}");
    }
}
