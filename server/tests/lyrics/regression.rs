use super::*;
use super::{
    formats::{self, timestamp_ms},
    model::{self, LyricsResponse},
    providers::{AmllRecord, LrclibRecord, ProviderClient, RateState, RedRecord, retry_after},
};
use axum::{
    Router,
    extract::State,
    http::{StatusCode, Uri},
    response::IntoResponse,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::{sync::Mutex, task::JoinHandle};

fn request() -> LyricsRequest {
    serde_json::from_value(json!({"trackName":"Song", "artistName":"Singer", "albumName":"Album", "durationSeconds":30})).unwrap()
}

fn ttml(body: &str) -> String {
    format!(
        r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"><body><div>{body}</div></body></tt>"#
    )
}
fn word_ttml() -> String {
    ttml(
        r#"<p begin="1s" end="3s"><span begin="1s" end="2s">Hello</span> <span begin="2s" end="3s">world</span></p>"#,
    )
}
fn line_ttml() -> String {
    ttml(r#"<p begin="1s" end="3s"><span begin="1s" end="3s">Hello world</span></p>"#)
}
fn yaml(words: bool) -> String {
    let words = if words {
        "\n    words:\n      - { text: 'Hello ', start_ms: 1000, end_ms: 2000 }\n      - { text: world, start_ms: 2000, end_ms: 3000 }"
    } else {
        ""
    };
    format!(
        "version: '1.0'\nmetadata: {{ title: Song, artist: Singer, duration_ms: 30000 }}\nlines:\n  - text: Hello world\n    start_ms: 1000\n    end_ms: 3000{words}\n"
    )
}
fn lrclib(words: bool) -> Value {
    json!({"trackName":"Song", "artistName":"Singer", "albumName":"Album", "duration":30,
        "instrumental":false, "hasWordSync":words, "plainLyrics":"Hello world", "syncedLyrics":"[00:01.00]Hello world", "lyricsfile":yaml(words)})
}
fn amll(id: u64, raw: Option<String>) -> Value {
    json!({"id":id, "musicNames":["Song"], "artistNames":["Singer"], "albumNames":["Album"], "isrcs":[], "lyrics":raw})
}

#[test]
fn ttml_word_sync_preserves_spaces_and_exact_times() {
    let result = ttml::parse(&word_ttml(), Some(30_000)).unwrap();
    assert_eq!(result.sync, "word");
    assert!(result.has_word_sync);
    assert_eq!(result.lines[0].text, "Hello world");
    assert_eq!(result.lines[0].segments[0].end_ms, Some(2000));
    assert_eq!(result.lines[0].segments[1].text, " ");
    assert_eq!(result.lines[0].words.len(), 3);
}

#[test]
fn ttml_word_declaration_does_not_promote_line_timing() {
    let result = ttml::parse(&line_ttml(), Some(30_000)).unwrap();
    assert_eq!(result.sync, "line");
    assert!(!result.has_word_sync);
    assert!(result.lines[0].words.is_empty());
}

#[test]
fn equal_span_times_do_not_claim_word_sync() {
    let result = ttml::parse(&ttml(r#"<p begin="1s" end="3s"><span begin="1s" end="3s">Hello</span><span begin="1s" end="3s">world</span></p>"#), None).unwrap();
    assert!(!result.has_word_sync);
}

#[test]
fn subword_spans_are_preserved_without_inventing_syllables() {
    let result = ttml::parse(&ttml(r#"<p begin="1s" end="3s"><span begin="1s" end="2s">hel</span><span begin="2s" end="3s">lo</span></p>"#), None).unwrap();
    assert_eq!(result.sync, "segment");
    assert_eq!(result.lines[0].text, "hello");
    assert_eq!(result.lines[0].segments.len(), 2);
}

#[test]
fn explicit_syllable_timing_is_supported() {
    let raw = ttml(r#"<p begin="1s" end="3s"><span begin="1s" end="2s">hel</span><span begin="2s" end="3s">lo</span></p>"#).replace("itunes:timing=\"Word\"", "itunes:timing=\"Syllable\"");
    assert_eq!(ttml::parse(&raw, None).unwrap().sync, "syllable");
}

#[test]
fn syllable_declaration_cannot_promote_word_only_timing() {
    let raw = word_ttml().replace("itunes:timing=\"Word\"", "itunes:timing=\"Syllable\"");
    assert_eq!(ttml::parse(&raw, None).unwrap().sync, "word");
}

#[test]
fn no_space_languages_preserve_segment_boundaries() {
    let result = ttml::parse(&ttml(r#"<p begin="1s" end="3s"><span begin="1s" end="2s">你</span><span begin="2s" end="3s">好</span></p>"#), None).unwrap();
    assert_eq!(result.lines[0].text, "你好");
    assert_eq!(result.sync, "segment");
}

#[test]
fn entities_cdata_and_breaks_remain_text() {
    let result = ttml::parse(
        &ttml(
            r#"<p begin="1s" end="3s">You&apos;re &amp; &#x4F60;<![CDATA[<hello>]]><br/>here</p>"#,
        ),
        None,
    )
    .unwrap();
    assert_eq!(result.lines[0].text, "You're & 你<hello>\nhere");
}

#[test]
fn translations_romanization_and_background_vocals_are_separate() {
    let raw = ttml(
        r#"<p begin="1s" end="4s" ttm:agent="v1"><span begin="1s" end="2s">Hello</span> <span begin="2s" end="3s">world</span><span ttm:role="x-translation" xml:lang="fr">Bonjour monde</span><span ttm:role="x-roman">hello</span><span ttm:role="x-bg" ttm:agent="v2"><span begin="2s" end="3s">Oh</span> <span begin="3s" end="4s">yeah</span></span></p>"#,
    );
    let result = ttml::parse(&raw, None).unwrap();
    let line = &result.lines[0];
    assert_eq!(line.text, "Hello world");
    assert_eq!(line.translations[0].language.as_deref(), Some("fr"));
    assert_eq!(line.romanization.len(), 1);
    assert_eq!(line.background_vocals[0].text, "Oh yeah");
    assert_eq!(line.background_vocals[0].singer.as_deref(), Some("v2"));
    assert_eq!(line.background_vocals[0].start_ms, Some(2000));
    assert!(model::has_detail(&line.background_vocals[0]));
}

#[test]
fn external_translations_and_singer_names_are_preserved() {
    let raw = r#"<tt><head><metadata><agent id="v1"><name>Singer</name></agent><translations><translation lang="fr"><text for="L1">Bonjour</text></translation></translations></metadata></head><body><p key="L1" begin="1s" end="2s" agent="v1">Hello</p></body></tt>"#;
    let result = ttml::parse(raw, None).unwrap();
    assert_eq!(result.singers[0].name.as_deref(), Some("Singer"));
    assert_eq!(result.lines[0].translations[0].segments[0].text, "Bonjour");
}

#[test]
fn malformed_or_unsafe_ttml_is_rejected() {
    for raw in [
        "<tt><body>",
        "<tt></body>",
        "<tt/><tt/>",
        "garbage",
        "<!DOCTYPE tt [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><tt>&x;</tt>",
        "<tt>&unknown;</tt>",
        "<tt><body><p begin='NaN'>x</p></body></tt>",
        "<tt><body><p begin='3s' end='1s'>x</p></body></tt>",
    ] {
        assert!(ttml::parse(raw, None).is_err(), "{raw}");
    }
    let nested = format!("<tt>{}x{}</tt>", "<div>".repeat(65), "</div>".repeat(65));
    assert!(ttml::parse(&nested, None).is_err());
}

#[test]
fn untimed_ttml_does_not_claim_sync() {
    let result = ttml::parse(&ttml("<p>Hello world</p>"), None).unwrap();
    assert_eq!(result.status, "lyrics");
    assert_eq!(result.sync, "none");
    assert_eq!(result.lines[0].segments[0].start_ms, None);
}

#[test]
fn timestamps_support_clock_and_offset_forms() {
    for (raw, expected) in [
        ("1:02.345", 62345),
        ("01:02:03.456", 3723456),
        ("1500ms", 1500),
        ("1.5s", 1500),
        ("0.5m", 30000),
        ("1h", 3600000),
    ] {
        assert_eq!(timestamp_ms(raw), Some(expected));
    }
    for raw in ["NaN", "inf", "-1s", "01:60.0", "01:61:00", "100000h"] {
        assert_eq!(timestamp_ms(raw), None);
    }
}

#[test]
fn lrc_offsets_multiple_stamps_and_last_line_end_are_preserved() {
    let result = formats::lrc(
        "[offset:250]\n[00:01.00][00:02.00]Hello\n[00:04.00]World",
        Some(5000),
    )
    .unwrap();
    assert_eq!(result.offset_ms, 250);
    assert_eq!(result.lines.len(), 3);
    assert_eq!(result.lines[0].start_ms, Some(1000));
    assert_eq!(result.lines[2].end_ms, Some(5000));
    assert_eq!(result.sync, "line");
}

#[test]
fn enhanced_lrc_keeps_word_timing() {
    let result = formats::lrc(
        "[00:01.00]<00:01.00>Hello <00:02.00>world<00:03.00>",
        Some(4000),
    )
    .unwrap();
    assert_eq!(result.sync, "word");
    assert_eq!(result.lines[0].text, "Hello world");
    assert_eq!(result.lines[0].segments[1].end_ms, Some(3000));
}

#[test]
fn lyricsfile_word_sync_uses_actual_data_not_provider_flag() {
    let mut raw = lrclib(true);
    raw["hasWordSync"] = json!(false);
    let record: LrclibRecord = serde_json::from_value(raw).unwrap();
    assert!(record.parse(Some(30000)).has_word_sync);
    let mut raw = lrclib(false);
    raw["hasWordSync"] = json!(true);
    assert!(
        !serde_json::from_value::<LrclibRecord>(raw)
            .unwrap()
            .parse(Some(30000))
            .has_word_sync
    );
}

#[test]
fn invalid_word_ranges_or_text_keep_valid_line_lyrics() {
    for raw in [
        yaml(true).replace("start_ms: 2000", "start_ms: 9000"),
        yaml(true).replace("text: world", "text: other"),
        yaml(true).replace("end_ms: 2000", "end_ms: 9000"),
    ] {
        let result = formats::lyricsfile(&raw, Some(30000)).unwrap();
        assert_eq!(result.sync, "line");
        assert_eq!(result.lines[0].text, "Hello world");
    }
}

#[test]
fn unknown_yaml_version_duplicates_and_instrumental_conflicts_are_rejected() {
    for raw in [
        yaml(true).replace("'1.0'", "'2.0'"),
        format!("{}\nversion: '1.0'", yaml(true)),
        yaml(false).replace("duration_ms: 30000", "instrumental: true"),
    ] {
        assert!(formats::lyricsfile(&raw, None).is_err());
    }
}

#[test]
fn malformed_lyricsfile_falls_back_to_lrc_or_plain() {
    let mut raw = lrclib(true);
    raw["lyricsfile"] = json!("bad: [");
    assert_eq!(
        serde_json::from_value::<LrclibRecord>(raw.clone())
            .unwrap()
            .parse(None)
            .sync,
        "line"
    );
    raw["syncedLyrics"] = Value::Null;
    let plain = serde_json::from_value::<LrclibRecord>(raw)
        .unwrap()
        .parse(None);
    assert_eq!(plain.sync, "none");
    assert_eq!(plain.lines[0].segments[0].text, "Hello world");
}

#[test]
fn instrumental_is_distinct_from_missing() {
    let mut raw = lrclib(false);
    raw["instrumental"] = json!(true);
    let result = serde_json::from_value::<LrclibRecord>(raw)
        .unwrap()
        .parse(None);
    assert_eq!(result.status, "instrumental");
    assert!(result.lines.is_empty());
    assert_eq!(LyricsResponse::empty(None).status, "unavailable");
}

#[test]
fn overlapping_lines_keep_explicit_ends() {
    let raw = "version: '1.0'\nmetadata: { title: Song, artist: Singer }\nlines:\n- { text: Hello, start_ms: 1000, end_ms: 5000 }\n- { text: World, start_ms: 2000, end_ms: 4000 }";
    let result = formats::lyricsfile(raw, None).unwrap();
    assert_eq!(result.lines[0].end_ms, Some(5000));
}

#[test]
fn matching_rejects_wrong_artist_live_version_duration_and_isrc() {
    let mut raw = lrclib(true);
    for (field, value) in [
        ("artistName", json!("Other")),
        ("trackName", json!("Song (Live)")),
        ("duration", json!(90)),
    ] {
        raw[field] = value;
        assert!(
            serde_json::from_value::<LrclibRecord>(raw.clone())
                .unwrap()
                .score(&request())
                .is_none()
        );
        raw = lrclib(true);
    }
    let mut req = request();
    req.isrc = Some("USAAA2400001".into());
    let raw = json!({"isrc":"USAAA2400002", "title":"Song", "artist":"Singer", "album":"Album", "duration":30});
    assert!(
        serde_json::from_value::<RedRecord>(raw)
            .unwrap()
            .score(&req)
            .is_none()
    );
}

#[test]
fn exact_recording_ids_override_spelling_but_not_conflicting_isrc() {
    let mut req = request();
    req.isrc = Some("USAAA2400001".into());
    let mut raw = amll(1, None);
    raw["musicNames"] = json!(["Different localization"]);
    raw["isrcs"] = json!(["USAAA2400001"]);
    assert!(
        serde_json::from_value::<AmllRecord>(raw.clone())
            .unwrap()
            .score(&req)
            .is_some()
    );
    raw["isrcs"] = json!(["USAAA2400002"]);
    assert!(
        serde_json::from_value::<AmllRecord>(raw)
            .unwrap()
            .score(&req)
            .is_none()
    );
}

#[test]
fn metadata_only_amll_matching_requires_album() {
    let mut raw = amll(1, None);
    raw["albumNames"] = json!(["Other album"]);
    assert!(
        serde_json::from_value::<AmllRecord>(raw)
            .unwrap()
            .score(&request())
            .is_none()
    );
}

#[test]
fn request_versions_and_invalid_metadata_are_checked() {
    let mut req = request();
    req.version = "Live".into();
    assert_eq!(req.title(), "Song (Live)");
    assert!(
        serde_json::from_value::<LrclibRecord>(lrclib(true))
            .unwrap()
            .score(&req)
            .is_none()
    );
    req.duration_seconds = Some(f64::NAN);
    assert!(req.validate().is_err());
    req.duration_seconds = Some(30.0);
    req.isrc = Some("../../path".into());
    assert!(req.validate().is_err());
}

#[test]
fn retry_after_accepts_seconds_and_http_dates() {
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    assert_eq!(retry_after(Some("30"), now), Duration::from_secs(30));
    let future = httpdate::fmt_http_date(now + Duration::from_secs(120));
    assert_eq!(retry_after(Some(&future), now), Duration::from_secs(120));
    assert_eq!(retry_after(Some("garbage"), now), Duration::from_secs(5));
}

#[test]
fn strict_selection_keeps_fallback_priority() {
    let mut selection = Selection::default();
    for provider in [Provider::Amll, Provider::Red, Provider::Lrclib] {
        let mut result = formats::lrc("[00:01.00]Hello", Some(30000)).unwrap();
        result.source = Some(provider.name());
        assert!(selection.consider(provider, result).is_none());
    }
    assert_eq!(selection.finish().source, Some("lrclib"));
    let mut selection = Selection::default();
    let mut result = ttml::parse(&line_ttml(), None).unwrap();
    result.source = Some("amll");
    selection.consider(Provider::Amll, result);
    let mut result = formats::lrc("[00:01.00]Hello", Some(30000)).unwrap();
    result.source = Some("lrc.red");
    selection.consider(Provider::Red, result);
    assert_eq!(selection.finish().source, Some("lrc.red"));
}

#[derive(Clone)]
struct Reply {
    status: u16,
    body: String,
    json: bool,
    delay: Duration,
}
impl Reply {
    fn json(value: Value) -> Self {
        Self {
            status: 200,
            body: value.to_string(),
            json: true,
            delay: Duration::ZERO,
        }
    }
    fn text(body: String) -> Self {
        Self {
            status: 200,
            body,
            json: false,
            delay: Duration::ZERO,
        }
    }
}
#[derive(Clone)]
struct MockState {
    replies: Arc<HashMap<String, Reply>>,
    calls: Arc<Mutex<Vec<String>>>,
}
struct MockServer {
    base: String,
    state: MockState,
    task: JoinHandle<()>,
}
impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn mock(replies: Vec<(&str, Reply)>) -> MockServer {
    let state = MockState {
        replies: Arc::new(
            replies
                .into_iter()
                .map(|(path, reply)| (path.to_owned(), reply))
                .collect(),
        ),
        calls: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .fallback(async |State(state): State<MockState>, uri: Uri| {
            state.calls.lock().await.push(uri.to_string());
            let reply = state
                .replies
                .get(&uri.to_string())
                .or_else(|| state.replies.get(uri.path()))
                .cloned()
                .unwrap_or(Reply {
                    status: 404,
                    body: String::new(),
                    json: true,
                    delay: Duration::ZERO,
                });
            tokio::time::sleep(reply.delay).await;
            (
                StatusCode::from_u16(reply.status).unwrap(),
                [
                    (
                        "content-type",
                        if reply.json {
                            "application/json"
                        } else {
                            "text/plain"
                        },
                    ),
                    ("retry-after", "30"),
                ],
                reply.body,
            )
                .into_response()
        })
        .with_state(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    MockServer { base, state, task }
}
fn rates() -> [Mutex<RateState>; 3] {
    std::array::from_fn(|_| Mutex::new(RateState::default()))
}
fn client<'a>(
    http: &'a reqwest::Client,
    bases: [&'a str; 3],
    rates: &'a [Mutex<RateState>; 3],
) -> ProviderClient<'a> {
    ProviderClient {
        http,
        bases,
        rates,
        budget: Duration::from_secs(3),
    }
}
fn search(record: Value) -> Reply {
    Reply::json(json!({"data":{"items":[record]}}))
}

#[tokio::test]
async fn detailed_amll_stops_before_other_providers() {
    let server = mock(vec![
        ("/amll/v1/lyrics/search", search(amll(1, None))),
        (
            "/amll/v1/lyrics/get",
            Reply::json(json!({"data":amll(1, Some(word_ttml()))})),
        ),
    ])
    .await;
    let bases = [
        format!("{}/amll", server.base),
        format!("{}/red", server.base),
        format!("{}/lrclib", server.base),
    ];
    let rates = rates();
    let http = reqwest::Client::new();
    let result = fetch_with(
        &client(&http, [&bases[0], &bases[1], &bases[2]], &rates),
        &request(),
    )
    .await;
    assert_eq!(result.source, Some("amll"));
    assert!(result.has_word_sync);
    assert_eq!(server.state.calls.lock().await.len(), 2);
}

#[tokio::test]
async fn amll_line_lyrics_do_not_block_red_word_lyrics() {
    let server = mock(vec![
        ("/amll/v1/lyrics/search", search(amll(1, None))),
        ("/amll/v1/lyrics/get", Reply::json(json!({"data":amll(1, Some(line_ttml()))}))),
        ("/red/search.json", Reply::json(json!({"hits":[{"isrc":"USAAA2400001", "title":"Song", "artist":"Singer", "album":"Album", "duration":30}]}))),
        ("/red/s/USAAA2400001.ttml", Reply::text(word_ttml())),
    ]).await;
    let bases = [
        format!("{}/amll", server.base),
        format!("{}/red", server.base),
        format!("{}/lrclib", server.base),
    ];
    let rates = rates();
    let http = reqwest::Client::new();
    let result = fetch_with(
        &client(&http, [&bases[0], &bases[1], &bases[2]], &rates),
        &request(),
    )
    .await;
    assert_eq!(result.source, Some("lrc.red"));
    assert!(result.has_word_sync);
    assert!(
        !server
            .state
            .calls
            .lock()
            .await
            .iter()
            .any(|path| path.starts_with("/lrclib"))
    );
}

#[tokio::test]
async fn lrclib_search_upgrades_line_result_to_real_words() {
    let server = mock(vec![
        ("/lrclib/api/get", Reply::json(lrclib(false))),
        ("/lrclib/api/search", Reply::json(json!([lrclib(true)]))),
    ])
    .await;
    let bases = [
        format!("{}/amll", server.base),
        format!("{}/red", server.base),
        format!("{}/lrclib", server.base),
    ];
    let rates = rates();
    let http = reqwest::Client::new();
    let result = fetch_with(
        &client(&http, [&bases[0], &bases[1], &bases[2]], &rates),
        &request(),
    )
    .await;
    assert_eq!(result.source, Some("lrclib"));
    assert!(result.has_word_sync);
}

#[tokio::test]
async fn api_failure_and_malformed_ttml_do_not_break_lrclib_fallback() {
    let server = mock(vec![
        (
            "/amll/v1/lyrics/search",
            Reply {
                status: 500,
                ..Reply::text("upstream failed".into())
            },
        ),
        ("/red/s/USAAA2400001.ttml", Reply::text("<tt><body>".into())),
        ("/lrclib/api/get", Reply::json(lrclib(false))),
    ])
    .await;
    let mut req = request();
    req.isrc = Some("USAAA2400001".into());
    let bases = [
        format!("{}/amll", server.base),
        format!("{}/red", server.base),
        format!("{}/lrclib", server.base),
    ];
    let rates = rates();
    let http = reqwest::Client::new();
    let result = fetch_with(
        &client(&http, [&bases[0], &bases[1], &bases[2]], &rates),
        &req,
    )
    .await;
    assert_eq!(result.source, Some("lrclib"));
    assert_eq!(result.sync, "line");
    assert_eq!(result.failed_providers, vec!["amll", "lrc.red"]);
}

#[tokio::test]
async fn red_malformed_ttml_can_use_lyricsfile() {
    let server = mock(vec![
        ("/red/s/USAAA2400001.ttml", Reply::text("<bad>".into())),
        (
            "/red/s/USAAA2400001.lyricsfile.yaml",
            Reply::text(yaml(true)),
        ),
    ])
    .await;
    let mut req = request();
    req.isrc = Some("USAAA2400001".into());
    let bases = [
        format!("{}/amll", server.base),
        format!("{}/red", server.base),
        format!("{}/lrclib", server.base),
    ];
    let rates = rates();
    let http = reqwest::Client::new();
    let result = fetch_with(
        &client(&http, [&bases[0], &bases[1], &bases[2]], &rates),
        &req,
    )
    .await;
    assert_eq!(result.source, Some("lrc.red"));
    assert_eq!(result.original_format, Some("lyricsfile"));
}

#[tokio::test]
async fn missing_everywhere_returns_proper_no_lyrics() {
    let server = mock(vec![]).await;
    let bases = [
        format!("{}/amll", server.base),
        format!("{}/red", server.base),
        format!("{}/lrclib", server.base),
    ];
    let rates = rates();
    let http = reqwest::Client::new();
    let result = fetch_with(
        &client(&http, [&bases[0], &bases[1], &bases[2]], &rates),
        &request(),
    )
    .await;
    assert_eq!(result.status, "unavailable");
    assert!(result.failed_providers.is_empty());
}

#[tokio::test]
async fn late_timeout_does_not_discard_valid_lrclib_line_lyrics() {
    let server = mock(vec![
        ("/lrclib/api/get", Reply::json(lrclib(false))),
        (
            "/lrclib/api/search",
            Reply {
                delay: Duration::from_secs(2),
                ..Reply::json(json!([]))
            },
        ),
    ])
    .await;
    let base = format!("{}/lrclib", server.base);
    let rates = rates();
    let http = reqwest::Client::new();
    let mut client = client(&http, [&base, &base, &base], &rates);
    client.budget = Duration::from_millis(500);
    let result = client
        .fetch(Provider::Lrclib, &request())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.sync, "line");
}

#[tokio::test]
async fn cooldown_is_shared_across_requests_without_caching_lyrics() {
    let server = mock(vec![(
        "/amll/v1/lyrics/search",
        Reply {
            status: 429,
            ..Reply::text("rate limited".into())
        },
    )])
    .await;
    let base = format!("{}/amll", server.base);
    let rates = rates();
    let http = reqwest::Client::new();
    let client = client(&http, [&base, &base, &base], &rates);
    assert!(client.fetch(Provider::Amll, &request()).await.is_err());
    assert!(client.fetch(Provider::Amll, &request()).await.is_err());
    assert_eq!(server.state.calls.lock().await.len(), 1);
}

#[tokio::test]
async fn successful_lyrics_are_fetched_again_not_cached() {
    let server = mock(vec![("/lrclib/api/get", Reply::json(lrclib(true)))]).await;
    let base = format!("{}/lrclib", server.base);
    let rates = rates();
    let http = reqwest::Client::new();
    let client = client(&http, [&base, &base, &base], &rates);
    for _ in 0..2 {
        assert!(
            client
                .fetch(Provider::Lrclib, &request())
                .await
                .unwrap()
                .unwrap()
                .has_word_sync
        );
    }
    assert_eq!(server.state.calls.lock().await.len(), 2);
}

#[tokio::test]
async fn cancellation_drops_pending_lookup_before_next_provider() {
    let server = mock(vec![(
        "/amll/v1/lyrics/search",
        Reply {
            delay: Duration::from_secs(2),
            ..Reply::json(json!({"data":{"items":[]}}))
        },
    )])
    .await;
    let bases = [
        format!("{}/amll", server.base),
        format!("{}/red", server.base),
        format!("{}/lrclib", server.base),
    ];
    let rates = rates();
    let http = reqwest::Client::new();
    let client = client(&http, [&bases[0], &bases[1], &bases[2]], &rates);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), fetch_with(&client, &request()))
            .await
            .is_err()
    );
    assert_eq!(server.state.calls.lock().await.len(), 1);
}

#[test]
fn plain_lrclib_still_precedes_line_red_and_amll_fallbacks() {
    let mut selection = Selection::default();
    for provider in [Provider::Amll, Provider::Red] {
        let mut lyrics = ttml::parse(&line_ttml(), None).unwrap();
        lyrics.source = Some(provider.name());
        selection.consider(provider, lyrics);
    }
    let mut raw = lrclib(false);
    raw["lyricsfile"] = Value::Null;
    raw["syncedLyrics"] = Value::Null;
    selection.consider(
        Provider::Lrclib,
        serde_json::from_value::<LrclibRecord>(raw)
            .unwrap()
            .parse(None),
    );
    let selected = selection.finish();
    assert_eq!(selected.source, Some("lrclib"));
    assert_eq!(selected.sync, "none");
}

#[test]
fn amll_line_fallback_is_used_when_others_have_no_lyrics() {
    let mut selection = Selection::default();
    let mut lyrics = ttml::parse(&line_ttml(), None).unwrap();
    lyrics.source = Some("amll");
    selection.consider(Provider::Amll, lyrics);
    selection.consider(Provider::Lrclib, LyricsResponse::empty(None));
    assert_eq!(selection.finish().source, Some("amll"));
}

#[test]
fn lyricsfile_subword_timing_uses_same_segment_model_as_ttml() {
    let raw = yaml(true)
        .replace("Hello world", "Helloworld")
        .replace("'Hello '", "Hello");
    let result = formats::lyricsfile(&raw, None).unwrap();
    assert_eq!(result.sync, "segment");
    assert!(result.has_word_sync);
}

#[test]
fn excessive_plain_line_count_is_not_materialized() {
    let mut result = LyricsResponse::empty(None);
    result.plain_lyrics = Some("text\n".repeat(model::MAX_LINES + 1));
    result.normalize(None);
    assert_eq!(result.status, "unavailable");
    assert!(result.lines.is_empty());
}

#[tokio::test]
async fn malformed_latest_amll_revision_does_not_hide_valid_older_revision() {
    let server = mock(vec![
        (
            "/amll/v1/lyrics/search",
            Reply::json(json!({"data":{"items":[amll(1,None),amll(2,None)]}})),
        ),
        (
            "/amll/v1/lyrics/get?id=1",
            Reply::json(json!({"data":amll(1,Some("<tt><body>".into()))})),
        ),
        (
            "/amll/v1/lyrics/get?id=2",
            Reply::json(json!({"data":amll(2,Some(word_ttml()))})),
        ),
    ])
    .await;
    let base = format!("{}/amll", server.base);
    let rates = rates();
    let http = reqwest::Client::new();
    let selected = client(&http, [&base, &base, &base], &rates)
        .fetch(Provider::Amll, &request())
        .await
        .unwrap()
        .unwrap();
    assert!(selected.has_word_sync);
    assert_eq!(server.state.calls.lock().await.len(), 3);
}

#[tokio::test]
async fn implausible_amll_timing_cannot_match_shorter_recording() {
    let raw = ttml(
        r#"<p begin="100s" end="102s"><span begin="100s" end="101s">Hello</span> <span begin="101s" end="102s">world</span></p>"#,
    );
    let server = mock(vec![
        ("/amll/v1/lyrics/search", search(amll(1, None))),
        (
            "/amll/v1/lyrics/get",
            Reply::json(json!({"data":amll(1,Some(raw))})),
        ),
    ])
    .await;
    let base = format!("{}/amll", server.base);
    let rates = rates();
    let http = reqwest::Client::new();
    assert!(
        client(&http, [&base, &base, &base], &rates)
            .fetch(Provider::Amll, &request())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn oversized_response_does_not_break_next_provider() {
    let server = mock(vec![
        (
            "/amll/v1/lyrics/search",
            Reply {
                json: true,
                ..Reply::text(" ".repeat(formats::MAX_RESPONSE_BYTES + 1))
            },
        ),
        ("/lrclib/api/get", Reply::json(lrclib(true))),
    ])
    .await;
    let bases = [
        format!("{}/amll", server.base),
        format!("{}/red", server.base),
        format!("{}/lrclib", server.base),
    ];
    let rates = rates();
    let http = reqwest::Client::new();
    let selected = fetch_with(
        &client(&http, [&bases[0], &bases[1], &bases[2]], &rates),
        &request(),
    )
    .await;
    assert_eq!(selected.source, Some("lrclib"));
    assert_eq!(selected.failed_providers, vec!["amll"]);
}

#[test]
fn overlapping_words_with_distinct_ends_have_real_detailed_timing() {
    let raw = ttml(
        r#"<p begin="1s" end="3s"><span begin="1s" end="2s">Hello</span> <span begin="1s" end="3s">world</span></p>"#,
    );
    assert!(ttml::parse(&raw, None).unwrap().has_word_sync);
}

#[test]
fn literal_angle_text_is_not_an_enhanced_lrc_timestamp() {
    let result = formats::lrc("[00:01.00]I <3> music", Some(30000)).unwrap();
    assert_eq!(result.lines[0].text, "I <3> music");
    assert_eq!(result.sync, "line");
}

#[test]
fn missing_line_ends_do_not_inherit_entire_container_duration() {
    let result = ttml::parse(
        "<tt><body dur='30s'><p begin='1s'>Hello</p><p begin='5s'>World</p></body></tt>",
        Some(30000),
    )
    .unwrap();
    assert_eq!(result.lines[0].end_ms, Some(5000));
    assert_eq!(result.lines[1].end_ms, Some(30000));
}
