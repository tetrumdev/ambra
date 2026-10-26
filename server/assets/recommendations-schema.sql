PRAGMA page_size=4096;
PRAGMA foreign_keys=ON;
PRAGMA user_version=1;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE artists (
 id INTEGER PRIMARY KEY, wikidata_id INTEGER NOT NULL UNIQUE,
 name TEXT NOT NULL, disambiguation TEXT NOT NULL DEFAULT ''
);
CREATE TABLE artist_aliases (
 normalized_name TEXT NOT NULL, artist_id INTEGER NOT NULL REFERENCES artists(id),
 PRIMARY KEY(normalized_name,artist_id)
) WITHOUT ROWID;
CREATE INDEX alias_artists ON artist_aliases(artist_id);
CREATE TABLE genres (
 id INTEGER PRIMARY KEY, wikidata_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 normalized_name TEXT NOT NULL, artist_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE genre_aliases (
 normalized_name TEXT NOT NULL, genre_id INTEGER NOT NULL REFERENCES genres(id),
 PRIMARY KEY(normalized_name,genre_id)
) WITHOUT ROWID;
CREATE TABLE artist_genres (
 artist_id INTEGER NOT NULL REFERENCES artists(id), genre_id INTEGER NOT NULL REFERENCES genres(id),
 PRIMARY KEY(artist_id,genre_id)
) WITHOUT ROWID;
CREATE INDEX genre_artists ON artist_genres(genre_id,artist_id);
CREATE TABLE genre_parents (
 child_id INTEGER NOT NULL REFERENCES genres(id), parent_id INTEGER NOT NULL REFERENCES genres(id),
 PRIMARY KEY(child_id,parent_id), CHECK(child_id<>parent_id)
) WITHOUT ROWID;
CREATE INDEX genre_children ON genre_parents(parent_id,child_id);
CREATE TABLE artist_provider_ids (
 artist_id INTEGER NOT NULL REFERENCES artists(id), provider TEXT NOT NULL, provider_id TEXT NOT NULL,
 PRIMARY KEY(artist_id,provider,provider_id)
) WITHOUT ROWID;
CREATE INDEX provider_artists ON artist_provider_ids(provider,provider_id);

CREATE TABLE ambiguous_artist_names (normalized_name TEXT PRIMARY KEY) WITHOUT ROWID;

CREATE TABLE artist_mbids (mbid BLOB NOT NULL, artist_id INTEGER NOT NULL REFERENCES artists(id), PRIMARY KEY(mbid,artist_id)) WITHOUT ROWID;
