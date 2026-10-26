use super::{
    database::{Database, normalize},
    ranking::{rank, rotation},
    taste::{DAY_MS, Taste},
};
use serde_json::{Value, json};

pub fn fixture() -> Database {
    Database::fixture("
        INSERT INTO artists VALUES
          (1,1,'Favorite',''),
          (2,2,'New niche',''),
          (3,3,'New broad',''),
          (4,4,'Other favorite',''),
          (5,5,'New jazz',''),
          (6,6,'Ambiguous','first'),
          (7,7,'Ambiguous','second'),
          (8,8,'Child genre',''),
          (9,9,'Multi genre',''),
          (10,10,'Broad ten',''),(11,11,'Broad eleven',''),(12,12,'Broad twelve',''),
          (13,13,'Broad thirteen',''),(14,14,'Broad fourteen',''),(15,15,'Broad fifteen','');
        INSERT INTO artist_mbids VALUES
          (X'00000000000000000000000000000001',1),
          (X'00000000000000000000000000000002',2),
          (X'00000000000000000000000000000003',3),
          (X'00000000000000000000000000000004',4),
          (X'00000000000000000000000000000005',5),
          (X'00000000000000000000000000000006',6),
          (X'00000000000000000000000000000007',7),
          (X'00000000000000000000000000000008',8),
          (X'00000000000000000000000000000009',9),
          (X'00000000000000000000000000000010',1),
          (X'00000000000000000000000000000011',1),(X'00000000000000000000000000000011',2);
        INSERT INTO artist_aliases VALUES
          ('favorite',1),('alias favorite',1),('new niche',2),('new broad',3),('other favorite',4),('new jazz',5),
          ('ambiguous',6),('ambiguous',7),('child genre',8),('multi genre',9),('conflicted alias',1);
        INSERT INTO artist_aliases SELECT lower(name),id FROM artists WHERE id>=10;
        INSERT INTO ambiguous_artist_names VALUES('conflicted alias');
        INSERT INTO genres VALUES (1,'QG1','Shoegaze','shoegaze',3),(2,'QG2','Rock','rock',8),
          (3,'QG3','Jazz','jazz',3),(4,'QG4','Dream pop','dream pop',1);
        INSERT INTO genre_aliases VALUES ('shoegaze',1),('shoe gaze',1),('rock',2),('jazz',3),('dream pop',4);
        INSERT INTO artist_genres VALUES (1,1),(1,2),(2,1),(3,2),(4,3),(5,3),(8,4),(9,1),(9,3);
        INSERT INTO artist_genres SELECT id,2 FROM artists WHERE id>=10;
        INSERT INTO genre_parents VALUES (4,1);
        INSERT INTO artist_provider_ids VALUES (1,'tidal','artist-1'),(6,'spotify','artist-6');
    ")
}

fn entry(name: &str, plays: u64, ago: u64) -> Value {
    json!({"track":{"globalId":format!("tidal:{name}"),"provider":"tidal","artist":name,"artists":[],"genres":[]},
        "playCount":plays,"lastPlayedAt":(1000-ago)*DAY_MS})
}

#[test]
fn bundled_database_has_real_coverage_and_read_only_connections() {
    let db = Database::bundled().unwrap();
    assert!(db.artist_count > 50_000.0);
    let slowdive = db
        .identify(
            "Slowdive",
            Some("a16371b9-7d36-497a-a9d4-42b0a0440c5e"),
            "",
            "",
        )
        .unwrap()
        .unwrap();
    assert!(!db.artist_genres(slowdive).unwrap().is_empty());
    assert!(db.genre("shoegaze").unwrap().is_some());
}

#[test]
fn identity_uses_ids_aliases_and_refuses_ambiguous_names() {
    let db = fixture();
    assert_eq!(
        db.identify(
            "wrong name",
            Some("00000000-0000-0000-0000-000000000001"),
            "",
            ""
        )
        .unwrap(),
        Some(1)
    );
    assert_eq!(
        db.identify("Favorite", Some("unknown-mbid"), "", "")
            .unwrap(),
        None
    );
    assert_eq!(
        db.identify("", Some("00000000-0000-0000-0000-000000000010"), "", "")
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        db.identify("", Some("00000000-0000-0000-0000-000000000011"), "", "")
            .unwrap(),
        None
    );
    assert_eq!(db.identify("Conflicted Alias", None, "", "").unwrap(), None);
    assert_eq!(
        db.identify("Alias Favorite", None, "", "").unwrap(),
        Some(1)
    );
    assert_eq!(db.identify("Ambiguous", None, "", "").unwrap(), None);
    assert_eq!(
        db.identify("Ambiguous", None, "spotify", "artist-6")
            .unwrap(),
        Some(6)
    );
    assert_eq!(
        db.identify("Favorite", None, "tidal", "wrong-id").unwrap(),
        None
    );
    assert_eq!(db.genre("SHOE-GAZE").unwrap(), Some(1));
    assert_eq!(normalize("  Beyoncé & Friends "), "beyoncé friends");
    assert_eq!(db.artist_genres(1).unwrap(), vec![1, 2]);
}

#[test]
fn missing_and_wrong_schema_fail_without_creating_database() {
    let path = std::env::temp_dir().join(format!(
        "ambra-no-database-{}",
        crate::server_config::random_hex(8)
    ));
    assert!(Database::open(&path).is_err());
    assert!(!path.exists());
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA user_version=99;").unwrap();
    drop(connection);
    assert!(Database::open(&path).is_err());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn repeats_and_recency_weight_taste_without_erasing_other_interests() {
    let db = fixture();
    let taste = Taste::build(
        &db,
        &json!({"entries":[entry("Favorite",20,0),entry("Other favorite",1,0)]}),
        &json!({}),
        1000 * DAY_MS,
    )
    .unwrap();
    assert!(taste.listened[&1] > taste.listened[&4]);
    assert!(taste.listened[&1] < 5.0 * taste.listened[&4]);
    let recent = Taste::build(
        &db,
        &json!({"entries":[entry("Favorite",5,0),entry("Other favorite",5,365)]}),
        &json!({}),
        1000 * DAY_MS,
    )
    .unwrap();
    assert!(recent.listened[&1] > recent.listened[&4]);
    assert!((taste.genres.values().sum::<f64>() - 1.0).abs() < 1e-9);
}

#[test]
fn relationship_ranking_specificity_discovery_and_hierarchy() {
    let db = fixture();
    let taste = Taste::build(
        &db,
        &json!({"entries":[entry("Favorite",20,0)]}),
        &json!({}),
        1000 * DAY_MS,
    )
    .unwrap();
    let results = rank(&db, &taste, 1000).unwrap();
    let position = |id| {
        results
            .iter()
            .position(|r| r.artist.id == id)
            .unwrap_or(usize::MAX)
    };
    assert!(position(2) < position(3)); // niche beats broad genre
    assert!(position(2) < position(1)); // discovery beats heavily played artist
    assert!(results.iter().any(|r| r.artist.id == 8)); // explicit child-genre edge
    assert!(!results.iter().any(|r| r.artist.id == 5)); // unrelated jazz artist
    assert!(
        results
            .iter()
            .all(|r| r.reason.contains("Shoegaze") || r.reason.contains("Rock"))
    );
    assert_eq!(
        results
            .iter()
            .map(|r| r.artist.id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        results.len()
    );
}

#[test]
fn combinations_diversity_rotation_and_empty_history() {
    let db = fixture();
    let taste = Taste::build(
        &db,
        &json!({"entries":[entry("Favorite",4,0),entry("Other favorite",4,0)]}),
        &json!({}),
        1000 * DAY_MS,
    )
    .unwrap();
    let one = rank(&db, &taste, 1000).unwrap();
    let two = rank(&db, &taste, 1000).unwrap();
    assert_eq!(
        one.iter().map(|r| r.artist.id).collect::<Vec<_>>(),
        two.iter().map(|r| r.artist.id).collect::<Vec<_>>()
    );
    assert!(one[..3].iter().any(|r| r.reason.contains("Jazz")));
    assert!(one[..3].iter().any(|r| r.artist.id == 9));
    assert_eq!(rotation(42, 1000), rotation(42, 1000));
    assert_ne!(rotation(42, 1000), rotation(42, 1001));
    let empty = Taste::build(&db, &json!({}), &json!({}), 1000 * DAY_MS).unwrap();
    assert!(rank(&db, &empty, 1000).unwrap().is_empty());
}

#[test]
fn unmatched_artists_can_use_existing_track_genres_without_inventing_links() {
    let db = fixture();
    let mut unknown = entry("Unknown", 4, 0);
    unknown["track"]["genres"] = json!(["shoe gaze", "unknown genre"]);
    let taste = Taste::build(
        &db,
        &json!({"entries":[unknown]}),
        &json!({}),
        1000 * DAY_MS,
    )
    .unwrap();
    assert_eq!(taste.genres.len(), 1);
    assert!(taste.genres.contains_key(&1));
    assert!(taste.listened.is_empty());
}
