use super::*;
use axum::middleware;
use serde_json::json;

pub(crate) fn manager(directory: &Path, ready: bool) -> Arc<Manager> {
    let paths = Paths {
        settings: directory.join("config/playback.json"),
        key: directory.join("config/soloist/key"),
        session: directory.join("config/soloist/session"),
        cache: directory.join("cache/audio"),
        capture: directory.join("cache/capture"),
        install: directory.join("data/bin"),
        lock: directory.join("data/session.lock"),
    };
    paths.prepare().unwrap();
    let config = Config {
        lossless_enabled: ready,
        ..Config::default()
    };
    Arc::new(Manager {
        paths,
        config: RwLock::new(config),
        health: RwLock::new((State::Ready, None, None)),
        expected_account: RwLock::new(Some("fixture".into())),
        operation: Mutex::new(()),
        maintenance: Mutex::new(()),
        force_update: AtomicBool::new(false),
        effective_renderer: RwLock::new(None),
        capture_error: RwLock::new(None),
        active: SyncMutex::new(None),
        shutdown: CancellationToken::new(),
        test_ready: ready,
    })
}

pub(crate) async fn configure_enabled(manager: &Manager, enabled: bool) {
    manager
        .configure(SettingsChange {
            lossless_enabled: Some(enabled),
            ..SettingsChange::default()
        })
        .await
        .unwrap();
}

pub(crate) async fn fail_installation(manager: &Manager) {
    // Persist a recent failure to exercise real maintenance without contacting Spotify.
    crate::server_config::write_private(
        &manager.paths.install.join("managed.json"),
        &serde_json::to_vec(&json!({
            "lastCheck": binary::now(),
            "lastError": "Soloist download failed; previous build and pairing are preserved"
        }))
        .unwrap(),
    )
    .unwrap();
    manager.config.write().unwrap().download_consent = true;
    manager.refresh().await;
    let status = manager.status();
    assert_eq!(status.backend, PlaybackBackend::Librespot);
    assert_eq!(status.preferred_quality, Quality::High);
    assert_eq!(status.error.unwrap().code, ErrorCode::UpdateFailed);
}
pub(super) fn directory() -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "ambra-soloist-{}",
        crate::server_config::random_hex(8)
    ));
    std::fs::create_dir(&directory).unwrap();
    directory
}

#[cfg(unix)]
fn fixture() -> PathBuf {
    static BINARY: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    BINARY
        .get_or_init(|| {
            let directory = directory();
            let binary = directory.join("soloist");
            let result = std::process::Command::new("cc")
                .arg(format!(
                    "-DAMBRA_FIXTURE_BUILD_TIMESTAMP={}",
                    binary::now() - 86_400
                ))
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/soloist.c"
                ))
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "native Soloist fixture must compile"
            );
            binary
        })
        .clone()
}

#[tokio::test]
async fn live_reservations_cancel_old_generations_and_handoffs() {
    let root = directory();
    let manager = manager(&root, true);
    let first = manager
        .reserve("0123456789abcdefghijkl", 1, "output", 0.0, 120.0, false)
        .await
        .unwrap();
    let token = manager
        .active
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .cancel
        .clone();
    let same = manager
        .reserve("0123456789abcdefghijkl", 1, "output", 0.0, 120.0, false)
        .await
        .unwrap();
    assert_eq!(same.stream_id, first.stream_id);
    let seek = manager
        .reserve("0123456789abcdefghijkl", 1, "output", 45.0, 120.0, true)
        .await
        .unwrap();
    assert!(token.is_cancelled());
    assert_ne!(seek.stream_id, first.stream_id);
    assert_eq!(seek.generation, first.generation);
    let handoff = manager
        .reserve(
            "0123456789abcdefghijkl",
            1,
            "another-output",
            50.0,
            120.0,
            false,
        )
        .await
        .unwrap();
    assert_ne!(handoff.stream_id, seek.stream_id);
    manager.state_for_stream(&first.stream_id, State::Error, Some(Error::expired()));
    assert_eq!(manager.health.read().unwrap().0, State::Buffering);
    manager.pause().await;
    assert!(manager.active.lock().unwrap().is_none());
    assert_eq!(manager.status().state, State::ApiKeyRequired);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn bounded_body_backpressure_and_disconnect_cancel_producer() {
    let (sender, receiver) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let body = LiveBody {
        receiver,
        cancel: cancel.clone(),
    };
    for _ in 0..8 {
        sender
            .send(Bytes::from(vec![0; crate::live_pcm::MAX_CHUNK]))
            .await
            .unwrap();
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(20), sender.send(Bytes::new()))
            .await
            .is_err()
    );
    drop(body);
    assert!(cancel.is_cancelled());
    assert!(sender.send(Bytes::new()).await.is_err());
}

#[test]
fn data_directory_lease_excludes_overlapping_sessions() {
    let root = directory();
    let manager = manager(&root, false);
    let lease = manager.paths.lock().unwrap();
    assert_eq!(manager.paths.lock().unwrap_err().code, ErrorCode::Busy);
    drop(lease);
    assert!(manager.paths.lock().is_ok());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn normal_build_selects_soloist_after_setup_and_preserves_readiness_checks() {
    let root = directory();
    let manager = manager(&root, false);
    updater::migrate(&manager.paths.install, &fixture())
        .await
        .unwrap();
    crate::server_config::write_private(&manager.paths.key, b"fixture-personal-api-key").unwrap();
    std::fs::create_dir_all(manager.paths.session.join("settings/Users/fixture-user")).unwrap();
    manager.config.write().unwrap().lossless_enabled = true;
    manager.inspect_installed().await;

    let status = manager.status();
    assert!(status.forwarding_enabled);
    assert!(status.paired);
    assert_eq!(status.account_matches, Some(true));
    assert_eq!(status.state, State::Ready);
    if status.capture.available {
        assert_eq!(status.backend, PlaybackBackend::Soloist);
        assert_eq!(status.preferred_quality, Quality::Lossless);
    } else {
        assert_eq!(status.backend, PlaybackBackend::Librespot);
        assert_eq!(status.preferred_quality, Quality::High);
    }
    if crate::service_auth::disconnected("spotify") {
        assert_eq!(
            manager.readiness().unwrap_err().code,
            ErrorCode::AuthenticationFailed
        );
    } else if status.capture.available {
        manager.readiness().unwrap();
    } else {
        assert_eq!(
            manager.readiness().unwrap_err().code,
            ErrorCode::CaptureUnavailable
        );
    }

    manager.set_account(Some("different-account".into()));
    assert_eq!(manager.status().preferred_quality, Quality::High);
    assert_eq!(
        manager.readiness().unwrap_err().code,
        ErrorCode::AuthenticationFailed
    );

    manager.set_account(Some("fixture".into()));
    std::fs::remove_file(&manager.paths.key).unwrap();
    assert_eq!(manager.status().state, State::ApiKeyRequired);
    assert_eq!(manager.status().preferred_quality, Quality::High);
    if !crate::service_auth::disconnected("spotify") {
        assert_eq!(
            manager.readiness().unwrap_err().code,
            ErrorCode::ApiKeyRequired
        );
    }

    manager.config.write().unwrap().lossless_enabled = false;
    assert_eq!(manager.status().backend, PlaybackBackend::Librespot);
    assert_eq!(
        manager.readiness().unwrap_err().code,
        ErrorCode::NotInstalled
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_pairing_persists_across_restart_update_and_sign_out() {
    let root = directory();
    let manager = manager(&root, false);
    let binary = fixture();
    let key = ApiKey::parse("fixture-personal-api-key".into()).unwrap();
    let build = binary::inspect(&binary).await.unwrap();
    assert!(!build.expired(binary::now()));
    crate::server_config::write_private(&manager.paths.key, key.expose().as_bytes()).unwrap();
    let mut runtime = runtime::Runtime::new(&manager.paths).unwrap();
    runtime.pair(&binary, &key, &manager.paths).await.unwrap();
    runtime.close().await;
    drop(runtime);
    assert!(manager.paths.paired());
    assert_eq!(manager.account_matches(), Some(true));
    let before = std::fs::read(
        manager
            .paths
            .session
            .join("settings/Users/fixture-user/prefs"),
    )
    .unwrap();
    let settings = Config {
        migration_executable: Some(binary.clone()),
        ..Config::default()
    };
    settings.save(&manager.paths.settings).unwrap();
    assert!(
        !Config::load(&manager.paths.settings)
            .unwrap()
            .lossless_enabled
    );
    updater::migrate(&manager.paths.install, &binary)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(
            manager
                .paths
                .session
                .join("settings/Users/fixture-user/prefs")
        )
        .unwrap(),
        before
    );
    assert_eq!(manager.paths.key().unwrap().expose(), key.expose());
    let installed = updater::installed(&manager.paths.install).unwrap();
    assert!(installed.starts_with(&manager.paths.install));
    let failed = root.join("not-a-binary");
    std::fs::write(&failed, "invalid").unwrap();
    assert!(
        updater::migrate(&manager.paths.install, &failed)
            .await
            .is_err()
    );
    assert_eq!(updater::installed(&manager.paths.install), Some(installed));
    manager.disconnect().await.unwrap();
    assert!(!manager.paths.paired());
    assert!(!manager.paths.key.exists());
    assert_eq!(manager.status().backend, PlaybackBackend::Librespot);
    assert!(
        !Config::load(&manager.paths.settings)
            .unwrap()
            .lossless_enabled
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_expired_process_has_specific_exit_code_and_no_restart() {
    let root = directory();
    let manager = manager(&root, false);
    let mut runtime = runtime::Runtime::new(&manager.paths).unwrap();
    let error = runtime
        .pair(
            &fixture(),
            &ApiKey::parse("fixture-expired-key".into()).unwrap(),
            &manager.paths,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Expired);
    runtime.close().await;
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn invalid_key_diagnostic_survives_exit_without_a_newline() {
    let root = directory();
    let manager = manager(&root, false);
    let mut runtime = runtime::Runtime::new(&manager.paths).unwrap();
    let error = runtime
        .pair(
            &fixture(),
            &ApiKey::parse("fixture-invalid-key".into()).unwrap(),
            &manager.paths,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidApiKey);
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("fixture-invalid-key")
    );
    runtime.close().await;
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn missing_binary_does_not_inherit_previous_build_expiration() {
    let root = directory();
    let manager = manager(&root, false);
    manager.health.write().unwrap().1 = Some(binary::Build {
        version: "1.3.7.349".into(),
        build_timestamp: 1,
        expires_at: 2,
        refresh_at: 1,
    });
    manager.config.write().unwrap().migration_executable = Some(root.join("missing-soloist"));
    manager.refresh().await;
    let status = manager.status();
    assert_eq!(status.state, State::NotInstalled);
    assert!(status.build.is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_capture_cleanup_requires_the_session_lease() {
    let root = directory();
    let manager = manager(&root, false);
    let stale = manager.paths.capture.join("0123456789abcdef");
    std::fs::create_dir(&stale).unwrap();
    std::fs::write(stale.join("audio.pcm"), b"stale").unwrap();
    std::fs::write(manager.paths.capture.join("unrelated"), b"keep").unwrap();
    let _lease = manager.paths.lock().unwrap();
    manager.paths.clear_runtime().unwrap();
    assert!(!stale.exists());
    assert!(manager.paths.capture.join("unrelated").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn status_requires_pairing_but_administration_stays_host_only() {
    let root = directory();
    let manager = manager(&root, false);
    crate::server_config::write_private(&manager.paths.key, b"fixture-personal-api-key").unwrap();
    let mut config = crate::server_config::ServerConfig::load_default_for_tests();
    config
        .paired_clients
        .push(crate::server_config::PairedClient {
            id: "output".into(),
            name: "Output".into(),
            token_sha256: crate::server_config::token_hash("paired-output-token"),
            paired_at_ms: 0,
            public_key: None,
        });
    let access = crate::access::AccessPolicy::from_env(crate::network::Network::new(config));
    let app: Router = router(manager.clone())
        .layer(middleware::from_fn_with_state(
            access,
            crate::access::enforce,
        ))
        .layer(middleware::from_fn(
            |mut request: axum::extract::Request, next: axum::middleware::Next| async move {
                if request
                    .headers()
                    .get("host")
                    .is_some_and(|h| h == "192.168.1.2:38147")
                {
                    request
                        .extensions_mut()
                        .insert(ambra_net::transport::RemotePeer {
                            public_key: ambra_net::Identity::generate().unwrap().public_key(),
                            address: "192.0.2.2:1".parse().unwrap(),
                            session: std::sync::Arc::new(()),
                        });
                }
                next.run(request).await
            },
        ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let client = reqwest::Client::new();
    let base = format!("http://{address}");
    let remote = || {
        client
            .get(format!("{base}/api/spotify/playback/status"))
            .header(header::HOST, "192.168.1.2:38147")
    };
    assert_eq!(
        remote().send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let response = remote()
        .bearer_auth("paired-output-token")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let text = response.text().await.unwrap();
    assert!(!text.contains("fixture-personal-api-key"));
    assert!(!text.contains(root.to_str().unwrap()));
    for route in [
        "/api/local/spotify/playback",
        "/api/local/spotify/soloist/pair",
        "/api/local/spotify/soloist/reset",
        "/api/local/spotify/soloist/check",
        "/api/local/spotify/soloist/sign-out",
    ] {
        assert_eq!(
            client
                .post(format!("{base}{route}"))
                .header(header::HOST, "192.168.1.2:38147")
                .bearer_auth("paired-output-token")
                .json(&json!({"apiKey":"attacker-key"}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        client
            .get(format!("{base}/api/playback/live/unknown"))
            .header(header::HOST, "192.168.1.2:38147")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .head(format!("{base}/api/playback/live/unknown"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    task.abort();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn automatic_quality_covers_capability_lifecycle() {
    let select = |state, binary, key, pairing, capture| {
        preferred_lossless(true, state, binary, key, pairing, capture)
    };
    for state in [
        State::NotInstalled,
        State::Downloading,
        State::Expired,
        State::Error,
        State::UnsupportedPlatform,
    ] {
        assert!(!select(state, true, true, true, true), "{state:?}");
    }
    assert!(!select(State::PairingRequired, true, true, false, true));
    assert!(!select(State::ApiKeyRequired, true, false, true, true));
    assert!(!select(State::Ready, false, true, true, true));
    assert!(!select(State::Ready, true, true, true, false));
    for state in [
        State::Ready,
        State::Playing,
        State::Paused,
        State::Buffering,
        State::Updating,
    ] {
        assert!(select(state, true, true, true, true), "{state:?}");
    }
    assert!(!preferred_lossless(false, State::Ready, true, true, true, true));
    // Recovery is current capability, never a stored backend preference.
    assert!(select(State::Ready, true, true, true, true));
}

#[tokio::test]
async fn legacy_settings_migrate_without_granting_consent_or_losing_pairing() {
    let root = directory();
    let manager = manager(&root, false);
    std::fs::write(&manager.paths.settings, br#"{"backend":"soloist","quality":"very_high","fallback":"never","updateChecks":true,"executable":null}"#).unwrap();
    let config = Config::load(&manager.paths.settings).unwrap();
    assert!(config.lossless_enabled);
    assert!(!config.download_consent);
    config.save(&manager.paths.settings).unwrap();
    let saved = std::fs::read_to_string(&manager.paths.settings).unwrap();
    for removed in [
        "backend",
        "quality",
        "fallback",
        "updateChecks",
        "executable",
    ] {
        assert!(!saved.contains(removed));
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn removed_manual_controls_reject_requests() {
    let root = directory();
    let manager = manager(&root, false);
    for body in [
        r#"{"executable":"/tmp/soloist"}"#,
        r#"{"backend":"soloist"}"#,
        r#"{"quality":"very_high"}"#,
    ] {
        assert!(serde_json::from_str::<SettingsChange>(body).is_err());
    }
    assert_eq!(manager.status().backend, PlaybackBackend::Librespot);
    assert!(manager.active.lock().unwrap().is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn local_inspection_cannot_clear_capture_failure_or_claim_lossless() {
    let root = directory();
    let manager = manager(&root, true);
    let info = manager
        .reserve("0123456789abcdefghijkl", 1, "output", 0.0, 120.0, false)
        .await
        .unwrap();
    manager.state_for_stream(
        &info.stream_id,
        State::Error,
        Some(Error::new(
            ErrorCode::CaptureUnavailable,
            "Permission denied",
        )),
    );
    manager.health.write().unwrap().0 = State::Ready;
    assert!(!manager.status().capture.available);
    assert_eq!(manager.status().preferred_quality, Quality::High);
    manager.state_for_stream(&info.stream_id, State::Playing, None);
    assert!(manager.capture_error.read().unwrap().is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn pairing_exit_ten_requests_automatic_refresh_without_losing_key() {
    let root = directory();
    let manager = manager(&root, false);
    updater::migrate(&manager.paths.install, &fixture())
        .await
        .unwrap();
    crate::server_config::write_private(&manager.paths.key, b"fixture-expired-key").unwrap();
    manager.pair().await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while manager.health.read().unwrap().0 != State::Expired {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(manager.force_update.load(Ordering::Acquire));
    assert!(manager.paths.key.exists());
    manager.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}
