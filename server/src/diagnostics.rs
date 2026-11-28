//! TEMPORARY playback diagnostics (remove once the phone desync is found).
//!
//! Every event from the server, the desktop app and the phone lands as one JSON line in
//! `<data>/diagnostics.jsonl`, stamped on arrival with the session clock (`serverMs`, the
//! clock positions are anchored to), so the three timelines can be read side by side.

use axum::{Extension, Json, http::StatusCode};
use serde_json::{Value, json};
use std::{fs::File, io::Write, sync::Mutex};

static FILE: Mutex<Option<File>> = Mutex::new(None);

pub fn record(source: &str, event: &str, fields: Value) {
    // Tests must never write into the real data directory.
    if cfg!(test) { return; }
    let line = json!({
        "serverMs": (crate::session::server_time_ms() * 10.0).round() / 10.0,
        "wallMs": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64),
        "source": source,
        "event": event,
        "fields": fields,
    });
    let Ok(mut slot) = FILE.lock() else { return };
    if slot.is_none() {
        *slot = std::fs::OpenOptions::new().create(true).append(true).open(crate::storage::data_path("diagnostics.jsonl")).ok();
    }
    if let Some(file) = slot.as_mut() {
        let _ = writeln!(file, "{line}");
    }
}

/// `POST /api/diagnostics`: `{ "source": "phone", "events": [{ "event": "...", ... }] }`.
pub async fn receive(caller: Option<Extension<crate::access::Caller>>, Json(body): Json<Value>) -> StatusCode {
    let source = body["source"].as_str().unwrap_or("client");
    let device = caller.and_then(|Extension(caller)| caller.client_id).unwrap_or_default();
    for event in body["events"].as_array().into_iter().flatten() {
        let name = event["event"].as_str().unwrap_or("event");
        record(source, name, json!({ "device": device, "event": event }));
    }
    StatusCode::NO_CONTENT
}
