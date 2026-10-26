use super::*;
use crate::models::{ArtistMetadata, PlaybackKind, PlaybackMetadata};

fn artist() -> Artist {
    Artist {
        id: 1,
        name: "Artist".into(),
        names: vec!["artist".into()],
        provider_ids: BTreeMap::new(),
        unambiguous_name: true,
    }
}
fn track(id: &str, name: &str, artist_id: &str) -> TrackMetadata {
    TrackMetadata {
        id: format!("tidal:{id}"),
        provider: MusicProvider::Tidal,
        provider_track_id: id.into(),
        title: "Song".into(),
        version: None,
        primary_artist: ArtistMetadata {
            provider_id: artist_id.into(),
            name: name.into(),
            image_url: None,
        },
        artists: vec![],
        album: None,
        duration_seconds: 180,
        track_number: None,
        disc_number: None,
        explicit: false,
        isrc: None,
        copyright: None,
        quality: None,
        maximum_sampling_rate_khz: None,
        maximum_bit_depth: None,
        playback: PlaybackMetadata {
            kind: PlaybackKind::Dash,
            url: format!("/api/providers/tidal/tracks/{id}/manifest.mpd"),
        },
    }
}

#[test]
fn catalog_matching_requires_exact_identity_and_rejects_name_collisions() {
    assert_eq!(
        matching_tracks(
            &artist(),
            MusicProvider::Tidal,
            vec![track("1", "Artist", "a"), track("2", "Different", "b")]
        )
        .len(),
        1
    );
    assert!(
        matching_tracks(
            &artist(),
            MusicProvider::Tidal,
            vec![track("1", "Artist", "a"), track("2", "Artist", "b")]
        )
        .is_empty()
    );
    let mut known = artist();
    known.provider_ids.insert("tidal".into(), vec!["a".into()]);
    assert_eq!(
        matching_tracks(
            &known,
            MusicProvider::Tidal,
            vec![track("1", "Renamed", "a"), track("2", "Artist", "b")]
        )
        .len(),
        1
    );
    known.unambiguous_name = false;
    assert_eq!(
        matching_tracks(
            &known,
            MusicProvider::Tidal,
            vec![track("1", "Artist", "a")]
        )
        .len(),
        1
    );
    assert!(
        matching_tracks(
            &Artist {
                unambiguous_name: false,
                ..artist()
            },
            MusicProvider::Tidal,
            vec![track("1", "Artist", "a")]
        )
        .is_empty()
    );
}

#[test]
fn unavailable_metadata_and_wrong_provider_are_filtered() {
    let mut unavailable = track("1", "Artist", "a");
    unavailable.playback.url.clear();
    assert!(matching_tracks(&artist(), MusicProvider::Tidal, vec![unavailable]).is_empty());
    let mut unavailable = track("2", "Artist", "a");
    unavailable.duration_seconds = 0;
    assert!(matching_tracks(&artist(), MusicProvider::Tidal, vec![unavailable]).is_empty());
    assert!(
        matching_tracks(
            &artist(),
            MusicProvider::Spotify,
            vec![track("1", "Artist", "a")]
        )
        .is_empty()
    );
}

#[test]
fn recording_deduplication_crosses_provider_boundaries() {
    let a = json!({"id":"tidal:1","isrc":"GB123","title":"Song","primaryArtist":{"name":"Artist"}});
    let b = json!({"globalId":"spotify:2","isrc":"gb123","name":"Song","artist":"Artist"});
    assert!(
        track_keys(&a)
            .iter()
            .any(|key| track_keys(&b).contains(key))
    );
    let c = json!({"globalId":"local:3","name":"Song","artist":"Artist"});
    let d = json!({"id":"tidal:4","title":"Song","primaryArtist":{"name":"Artist"}});
    assert!(
        track_keys(&c)
            .iter()
            .any(|key| track_keys(&d).contains(key))
    );
    assert!(
        track_keys(&a)
            .iter()
            .any(|key| track_keys(&c).contains(key))
    );
}

#[tokio::test]
async fn disconnect_invalidates_success_negative_and_error_caches() {
    let discover = Discover::default();
    {
        let mut cache = discover.cache.lock().await;
        cache.result = Some(CachedResult {
            key: "key".into(),
            when: Instant::now(),
            response: DiscoverResponse::empty("ready"),
        });
        cache.matches.insert(
            (1, MusicProvider::Tidal),
            MatchedTracks {
                when: Instant::now(),
                tracks: vec![track("1", "Artist", "a")],
            },
        );
        cache.matches.insert(
            (2, MusicProvider::Tidal),
            MatchedTracks {
                when: Instant::now(),
                tracks: vec![],
            },
        );
        cache.backoff.insert(
            MusicProvider::Tidal,
            Backoff {
                failures: 1,
                until: Some(Instant::now() + ERROR_TTL),
            },
        );
    }
    discover.invalidate().await;
    let cache = discover.cache.lock().await;
    assert!(cache.result.is_none());
    assert!(cache.matches.is_empty());
    assert!(cache.backoff.is_empty());
    assert_eq!(discover.epoch.load(Ordering::SeqCst), 1);
}

fn candidate(id: i64) -> Candidate {
    Candidate {
        artist: Artist { id, ..artist() },
        reason: "Because you listen to Jazz".into(),
    }
}

#[tokio::test]
async fn successful_and_negative_matches_cache_without_spending_lookup_budget() {
    let discover = Discover::default();
    let budget = AtomicUsize::new(0);
    let calls = AtomicUsize::new(0);
    for _ in 0..2 {
        let tracks = resolve_with(
            &discover,
            &candidate(1),
            MusicProvider::Tidal,
            &budget,
            0,
            || async {
                calls.fetch_add(1, Ordering::Relaxed);
                Ok(SearchPage {
                    tracks: vec![track("1", "Artist", "a")],
                    next_offset: None,
                })
            },
        )
        .await
        .unwrap();
        assert_eq!(tracks.len(), 1);
    }
    for _ in 0..2 {
        let tracks = resolve_with(
            &discover,
            &candidate(2),
            MusicProvider::Tidal,
            &budget,
            0,
            || async {
                calls.fetch_add(1, Ordering::Relaxed);
                Ok(SearchPage {
                    tracks: vec![],
                    next_offset: None,
                })
            },
        )
        .await
        .unwrap();
        assert!(tracks.is_empty());
    }
    assert_eq!(calls.load(Ordering::Relaxed), 2);
    assert_eq!(budget.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn provider_outages_back_off_keep_stale_matches_and_respect_hard_budget() {
    let discover = Discover::default();
    let budget = AtomicUsize::new(0);
    discover.cache.lock().await.matches.insert(
        (1, MusicProvider::Tidal),
        MatchedTracks {
            when: Instant::now() - MATCH_TTL - Duration::from_secs(1),
            tracks: vec![track("1", "Artist", "a")],
        },
    );
    let tracks = resolve_with(
        &discover,
        &candidate(1),
        MusicProvider::Tidal,
        &budget,
        0,
        || async { Err(ApiError::upstream("HTTP 429")) },
    )
    .await
    .unwrap();
    assert_eq!(tracks.len(), 1);
    assert!(
        resolve_with(
            &discover,
            &candidate(2),
            MusicProvider::Tidal,
            &budget,
            0,
            || async { panic!("backoff must prevent lookup") }
        )
        .await
        .is_err()
    );
    assert!(
        discover.cache.lock().await.backoff[&MusicProvider::Tidal]
            .until
            .unwrap()
            > Instant::now() + Duration::from_secs(299)
    );
    budget.store(LOOKUP_BUDGET, Ordering::Relaxed);
    let empty = resolve_with(
        &discover,
        &candidate(3),
        MusicProvider::Qobuz,
        &budget,
        0,
        || async { panic!("budget must prevent lookup") },
    )
    .await
    .unwrap();
    assert!(empty.is_empty());
}

#[tokio::test]
async fn old_sessions_cannot_commit_provider_results_after_disconnect() {
    let discover = Discover::default();
    let budget = AtomicUsize::new(0);
    let result = resolve_with(
        &discover,
        &candidate(1),
        MusicProvider::Tidal,
        &budget,
        0,
        || async {
            discover.invalidate().await;
            Ok(SearchPage {
                tracks: vec![track("1", "Artist", "a")],
                next_offset: None,
            })
        },
    )
    .await;
    assert!(result.is_err());
    assert!(discover.cache.lock().await.matches.is_empty());
}

fn state(directory: &std::path::Path) -> AppState {
    let client = reqwest::Client::new();
    AppState {
        tidal: Arc::new(ProviderSlot::new()),
        qobuz: Arc::new(ProviderSlot::new()),
        spotify: Arc::new(SyncRwLock::new(None)),
        service_login: Arc::new(std::array::from_fn(|_| Mutex::new(()))),
        spotify_login: Arc::new(Mutex::new(())),
        soloist: crate::soloist::tests::manager(directory, false),
        pending_tidal_login: Arc::new(Mutex::new(None)),
        pending_qobuz_login: Arc::new(Mutex::new(None)),
        http_client: client.clone(),
        library_entries: Arc::new(RwLock::new(Vec::new())),
        search_cache: Arc::new(RwLock::new(HashMap::new())),
        catalog_cache: Arc::new(RwLock::new(HashMap::new())),
        search_fetches: Arc::new(Mutex::new(HashMap::new())),
        media_cache: Arc::new(RwLock::new(MediaCache::default())),
        providers_ready: watch::channel(true).1,
        media_fetches: Arc::new(Mutex::new(HashMap::new())),
        artwork_quality_cache: Arc::new(RwLock::new(HashMap::new())),
        artwork_dimensions_cache: Arc::new(RwLock::new(HashMap::new())),
        artwork: Arc::new(crate::artwork_cache::ArtworkCache::with_disk(
            client,
            directory.join("artwork"),
        )),
        artist_metadata: Arc::new(Mutex::new(HashMap::new())),
        playlist_mutations: Arc::new(Mutex::new(HashMap::new())),
        discover: Arc::new(Discover::default()),
        user_state: Arc::new(crate::user_state::UserState::at(
            directory.join("user-state.v1.json"),
        )),
    }
}
fn local_track(name: &str, id: &str) -> Value {
    json!({"globalId":format!("local:{id}"),"providerTrackId":format!("{id}.flac"),"provider":"local","name":"Song","artist":name,"album":"Album",
        "audio":format!("/api/music/local/files/{id}.flac"),"cover":"/white.svg","playbackKind":"direct","durationSeconds":180,"artists":[{"name":name,"providerId":""}],"albumArtists":[]})
}
async fn settled(state: &AppState) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !state.discover.cache.lock().await.running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn synchronized_history_to_playable_local_track_is_single_flight_and_refreshes_on_relevant_changes()
 {
    let directory = std::env::temp_dir().join(format!(
        "ambra-discover-{}",
        crate::server_config::random_hex(8)
    ));
    let state = state(&directory);
    *state.discover.database.lock().unwrap() = Some(crate::recommendations::tests::fixture());
    let favorite = local_track("Favorite", "favorite");
    let discovery = local_track("New niche", "new");
    let history =
        json!({"version":1,"entries":[{"track":favorite,"lastPlayedAt":now(),"playCount":20}]});
    state
        .user_state
        .update("ambra.listening-history.v1", move |_| {
            Ok((Some(history.to_string()), ()))
        })
        .await
        .unwrap();
    std::fs::create_dir_all(directory.join("local-music")).unwrap();
    std::fs::write(
        directory.join("local-music/library.json"),
        json!({"local:new":discovery}).to_string(),
    )
    .unwrap();
    std::fs::write(directory.join("local-music/new.flac"), b"test fixture").unwrap();
    let input = inputs(&state).await.unwrap();
    let key = input.key.clone();
    let (locked, ready) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let database = state.discover.database.clone();
    let blocker = tokio::task::spawn_blocking(move || {
        let _guard = database.lock().unwrap();
        locked.send(()).unwrap();
        released.blocking_recv().unwrap();
    });
    ready.await.unwrap();
    assert_eq!(request(state.clone(), input).await.status, "loading");
    assert_eq!(
        request(state.clone(), inputs(&state).await.unwrap())
            .await
            .status,
        "loading"
    );
    assert!(state.discover.cache.lock().await.running);
    release.send(()).unwrap();
    blocker.await.unwrap();
    settled(&state).await;
    let ready = request(state.clone(), inputs(&state).await.unwrap()).await;
    assert_eq!(ready.status, "ready");
    assert_eq!(ready.tracks.len(), 1);
    assert_eq!(ready.tracks[0]["globalId"], "local:new");
    assert_eq!(ready.tracks[0]["audio"], "/api/music/local/files/new.flac");
    assert_eq!(ready.reasons["local:new"], "Because you listen to Shoegaze");
    state
        .user_state
        .update("ambra.ui-preferences.v1", |_| Ok((Some("{}".into()), ())))
        .await
        .unwrap();
    assert_eq!(inputs(&state).await.unwrap().key, key);
    let cached = request(state.clone(), inputs(&state).await.unwrap()).await;
    assert_eq!(cached.generated_at, ready.generated_at);
    assert!(!state.discover.cache.lock().await.running);
    let history = json!({"version":1,"entries":[{"track":local_track("New niche","new"),"lastPlayedAt":now(),"playCount":1}]});
    state
        .user_state
        .update("ambra.listening-history.v1", move |_| {
            Ok((Some(history.to_string()), ()))
        })
        .await
        .unwrap();
    let refreshing = request(state.clone(), inputs(&state).await.unwrap()).await;
    assert!(refreshing.tracks.is_empty());
    settled(&state).await;
    drop(state);
    std::fs::remove_dir_all(directory).unwrap();
}
