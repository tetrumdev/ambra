//! Read-only live probe for the Qobuz lyrics endpoint (Lyrics epic, slice S1).
//!
//! Validates the inferred contract (`/track/lyricsUrl` + CDN document) against
//! the live API using AMBRA_QOBUZ_USER_AUTH_TOKEN, and prints the RAW JSON
//! of every response so the shapes can be captured into
//! `qbz-nix-docs/qobuz-api/` before freezing the serde structs.
//!
//! Usage:
//!   cargo run -p qbz-qobuz --example lyrics_probe                     # default track ids
//!   cargo run -p qbz-qobuz --example lyrics_probe 123 456             # explicit ids
//!   cargo run -p qbz-qobuz --example lyrics_probe --lang=es 123       # + translation target
//!
//! `--lang=<iso639-1>` exercises the v10 `language` query param (translation
//! request); omitted = original-only fetch.
//!
//! Strictly read-only: login + GETs, no mutations.

use qbz_qobuz::QobuzClient;

/// Minimal stderr logger so the credential/auth log lines are visible
/// without pulling a logger crate into dev-dependencies.
struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Debug
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}", record.level(), record.args());
        }
    }
    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

// Defaults probed 2026-06-10 — one of each observed shape:
//  266725027  Billie Eilish - LUNCH                      -> wsync (word-synced)
//   29006863  Devin Townsend - Vampira (Retinal Circus)  -> plain
//         34  Leehom Wang - Yao Gun Zen Mo Liao! reprise -> miss (HTTP 404)
const DEFAULT_TRACK_IDS: &[u64] = &[266725027, 29006863, 34];

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = log::set_logger(&LOGGER).map(|_| log::set_max_level(log::LevelFilter::Debug));

    let mut language: Option<String> = None;
    let mut ids: Vec<u64> = Vec::new();
    for arg in std::env::args().skip(1) {
        if let Some(lang) = arg.strip_prefix("--lang=") {
            language = Some(lang.to_string());
        } else if let Ok(id) = arg.parse() {
            ids.push(id);
        }
    }
    let track_ids: Vec<u64> = if ids.is_empty() {
        DEFAULT_TRACK_IDS.to_vec()
    } else {
        ids
    };
    if let Some(lang) = &language {
        eprintln!("[probe] translation target language: {}", lang);
    }

    let client = QobuzClient::new()?;
    let warm = client.init().await?;
    eprintln!("[probe] init done (warm bundle cache: {})", warm);

    let token = zeroize::Zeroizing::new(std::env::var("AMBRA_QOBUZ_USER_AUTH_TOKEN")?);
    client.login_with_token(token.trim()).await?;

    for track_id in track_ids {
        println!("\n=== track {} ===", track_id);

        // Identify the track so the report can name what was probed.
        match client.get_track(track_id).await {
            Ok(track) => println!(
                "[meta] \"{}\" - {} (album: {})",
                track.title,
                track.performer.as_ref().map(|p| p.name.as_str()).unwrap_or("?"),
                track.album.as_ref().map(|a| a.title.as_str()).unwrap_or("?"),
            ),
            Err(e) => println!("[meta] get_track failed: {}", e),
        }

        // Step 1 raw: signed GET /track/lyricsUrl
        let (status, body) = match client.get_lyrics_url_raw(track_id, language.as_deref()).await {
            Ok(pair) => pair,
            Err(e) => {
                println!("[lyricsUrl] transport error: {}", e);
                continue;
            }
        };
        println!("[lyricsUrl] HTTP {}", status);
        println!("[lyricsUrl] raw body:\n{}", body);

        // Typed step 1
        let urls = match client.get_lyrics_url(track_id, language.as_deref()).await {
            Ok(Some(urls)) => urls,
            Ok(None) => {
                println!("[lyricsUrl] typed result: MISS (no lyrics)");
                continue;
            }
            Err(e) => {
                println!("[lyricsUrl] typed error: {}", e);
                continue;
            }
        };
        println!(
            "[lyricsUrl] typed: track_id={:?} album_id={:?} translation_requested={}",
            urls.track_id,
            urls.album_id,
            urls.translation_requested.is_some()
        );

        // Step 2 raw: plain GET of the CDN document (public http handle).
        if let Some(lyrics_url) = &urls.lyrics_url {
            println!("[doc] GET {}", lyrics_url);
            match client.get_http().get(lyrics_url).send().await {
                Ok(resp) => {
                    let doc_status = resp.status().as_u16();
                    let doc_body = resp.text().await.unwrap_or_default();
                    println!("[doc] HTTP {}", doc_status);
                    println!("[doc] raw body:\n{}", doc_body);
                }
                Err(e) => println!("[doc] transport error: {}", e),
            }
        }

        // Typed full chain
        match client.get_lyrics(track_id, language.as_deref()).await {
            Ok(Some(doc)) => {
                let content = doc.original.as_ref().expect("get_lyrics guarantees original");
                println!(
                    "[get_lyrics] typed: {} with {} lines (translations: {:?}, writers: {:?})",
                    if content.is_synced() { "SYNCED (wsync)" } else { "PLAIN" },
                    content.line_count(),
                    doc.translation_langs,
                    doc.writers
                );
                match doc.translation.as_ref() {
                    Some(translation) => println!(
                        "[get_lyrics] embedded translation: {} with {} lines (lang: {:?})",
                        if translation.is_synced() { "SYNCED" } else { "PLAIN" },
                        translation.line_count(),
                        translation.lang()
                    ),
                    None => println!("[get_lyrics] no embedded translation"),
                }
            }
            Ok(None) => println!("[get_lyrics] typed result: MISS"),
            Err(e) => println!("[get_lyrics] typed error: {}", e),
        }
    }

    Ok(())
}
