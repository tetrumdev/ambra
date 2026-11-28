//! TEMPORARY playback diagnostics (remove once the phone desync is found): events the
//! phone's bridge records, drained by the app and sent on to the server's diagnostics log.

use serde_json::{Value, json};
use std::sync::Mutex;

static EVENTS: Mutex<Vec<Value>> = Mutex::new(Vec::new());

pub fn record(event: &str, mut fields: Value) {
    let wall_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64);
    if !fields.is_object() { fields = json!({}); }
    fields["event"] = json!(event);
    fields["phoneWallMs"] = json!(wall_ms);
    if let Ok(mut events) = EVENTS.lock() {
        // Kept bounded if nothing drains it.
        if events.len() >= 2000 { events.remove(0); }
        events.push(fields);
    }
}

pub fn drain() -> Vec<Value> {
    EVENTS.lock().map(|mut events| std::mem::take(&mut *events)).unwrap_or_default()
}
