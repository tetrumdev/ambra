//! This computer's outputs, for the server's core to play through (like a Roon bridge).
//!
//! While the app runs, it reports its outputs and playback status to the server, and carries
//! out what the core asks for: load this song, play, pause, seek, the volume, and output
//! settings that any computer can change (`endpoints.rs` and `session.rs` on the server).
//! The app keeps running with its window closed, so playback carries on.
//!
//! Songs arrive as URLs on the server's address as it was saved; they're moved onto this
//! app's own address and token before playing, and reported back as the core sent them.

use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::native_audio::{self, NativeAudioPlayer};

/// Often while playing, so the core hears of a song ending or moving on promptly.
const REPORT_PLAYING: Duration = Duration::from_millis(500);
const REPORT_IDLE: Duration = Duration::from_secs(1);
const DEVICES_EVERY: u32 = 5;
const COMMANDS_WAIT_SECONDS: u64 = 25;
/// Report round trips remembered; the quickest is the one least delayed by anything but the network.
const ROUND_TRIPS_KEPT: usize = 8;

struct Agent {
    app: AppHandle,
    client: reqwest::Client,
    base_url: String,
    token: Option<String>,
    id: String,
    name: String,
    /// Stable for this agent's lifetime, not across app restarts.
    instance_id: String,
    /// The URL each source was sent as, by the URL it plays as here.
    sent_as: Mutex<HashMap<String, String>>,
}

pub fn start(app: AppHandle, base_url: String, token: Option<String>, id: String, name: String) {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(COMMANDS_WAIT_SECONDS + 10)).build() else {
        return;
    };
    let mut instance = [0_u8; 16];
    getrandom::fill(&mut instance).expect("the operating system's random source is available");
    let instance_id = instance.iter().map(|byte| format!("{byte:02x}")).collect();
    let agent = std::sync::Arc::new(Agent { app, client, base_url, token, id, name, instance_id, sent_as: Mutex::new(HashMap::new()) });
    tauri::async_runtime::spawn(report(agent.clone()));
    tauri::async_runtime::spawn(serve(agent));
}

impl Agent {
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let request = self.client.request(method, format!("{}/api/endpoints/{}/{path}", self.base_url, self.id));
        match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }

    fn local_source(&self, source: &str) -> String {
        let local = local_source(&self.base_url, self.token.as_deref(), source);
        if local == source {
            return local;
        }
        if let Ok(mut sent_as) = self.sent_as.lock() {
            if sent_as.len() > 256 {
                sent_as.clear();
            }
            sent_as.insert(local.clone(), source.to_owned());
        }
        local
    }

    fn sent_source(&self, local: &str) -> String {
        self.sent_as
            .lock()
            .ok()
            .and_then(|sent_as| sent_as.get(local).cloned())
            .unwrap_or_else(|| local.to_owned())
    }

    fn arg_source(&self, args: &Value, key: &str) -> Option<String> {
        args[key].as_str().map(|source| self.local_source(source))
    }
}

/// A server URL as this app reaches the same server; anything else (a file path) as is.
fn local_source(base_url: &str, token: Option<&str>, source: &str) -> String {
    let path_start = if source.starts_with("/api/") { 0 } else {
        let Some(url) = source.strip_prefix("http://").or_else(|| source.strip_prefix("https://")) else { return source.to_owned() };
        let Some(index) = url.find("/api/") else { return source.to_owned() };
        source.len() - url.len() + index
    };
    let (path, query) = source[path_start..].split_once('?').unwrap_or((&source[path_start..], ""));
    let mut parameters = query
        .split('&')
        .filter(|pair| !pair.is_empty() && !pair.starts_with("access_token="))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if let Some(token) = token {
        parameters.push(format!("access_token={}", urlencoding(token)));
    }
    if parameters.is_empty() {
        format!("{base_url}{path}")
    } else {
        format!("{base_url}{path}?{}", parameters.join("&"))
    }
}

fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

async fn report(agent: std::sync::Arc<Agent>) {
    let mut beat = 0_u32;
    let mut round_trips = VecDeque::<Duration>::with_capacity(ROUND_TRIPS_KEPT);
    loop {
        let player = agent.app.state::<NativeAudioPlayer>();
        let mut body = json!({ "name": agent.name, "instanceId": agent.instance_id });
        if beat % DEVICES_EVERY == 0 {
            if let Ok(devices) = native_audio::list_native_audio_devices(player.clone()).await {
                body["devices"] = serde_json::to_value(devices).unwrap_or(json!([]));
            }
            if let Ok(settings) = native_audio::native_audio_settings(player.clone()).await {
                body["selectedDeviceId"] = Value::String(settings.selected_output_id.clone());
            }
        }
        beat = beat.wrapping_add(1);
        // Sampled last, so the position is as fresh as it can be when it leaves.
        let mut status = native_audio::native_audio_status(player.clone())
            .await
            .ok()
            .and_then(|status| serde_json::to_value(status).ok())
            .unwrap_or(Value::Null);
        if let Some(source) = status["currentSource"].as_str() {
            status["currentSource"] = Value::String(agent.sent_source(source));
        }
        let playing = status["isPlaying"].as_bool().unwrap_or(false) || status["buffering"].as_bool().unwrap_or(false);
        body["status"] = status;
        // Half the quickest round trip: how long this report takes to arrive, so the core
        // can tell when the position was true, not just when it heard it.
        if let Some(quickest) = round_trips.iter().min() {
            body["latencyMs"] = json!(quickest.as_secs_f64() * 500.0);
        }
        let started = Instant::now();
        let sent = agent.request(reqwest::Method::POST, "presence").json(&body).send().await;
        if sent.as_ref().is_ok_and(|response| response.status().is_success()) {
            if round_trips.len() == ROUND_TRIPS_KEPT {
                round_trips.pop_front();
            }
            round_trips.push_back(started.elapsed());
        }
        // Unpaired or revoked: there's nothing to do until the app is paired again.
        let wait = match sent {
            Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => Duration::from_secs(30),
            _ if playing => REPORT_PLAYING,
            _ => REPORT_IDLE,
        };
        tokio::time::sleep(wait).await;
    }
}

async fn serve(agent: std::sync::Arc<Agent>) {
    loop {
        let response = agent
            .request(reqwest::Method::GET, &format!("commands?wait={COMMANDS_WAIT_SECONDS}"))
            .send()
            .await;
        let commands = match response {
            Ok(response) if response.status().is_success() => response.json::<Vec<Value>>().await.unwrap_or_default(),
            _ => {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        for command in commands {
            let outcome = run(&agent, command["command"].as_str().unwrap_or_default(), &command["args"]).await;
            let body = match outcome {
                Ok(value) => json!({ "id": command["id"], "ok": true, "value": value }),
                Err(error) => json!({ "id": command["id"], "ok": false, "error": error }),
            };
            let _ = agent.request(reqwest::Method::POST, "results").json(&body).send().await;
        }
    }
}

/// Only what the server asks for; the rest of the app stays private.
async fn run(agent: &Agent, command: &str, args: &Value) -> Result<Value, String> {
    let player = agent.app.state::<NativeAudioPlayer>();
    let number = |key: &str| args[key].as_f64().ok_or_else(|| format!("`{key}` is missing"));
    match command {
        "load_native_audio" => native_audio::load_native_audio(
            player,
            agent.arg_source(args, "source").ok_or("`source` is missing")?,
            agent.arg_source(args, "nextSource"),
            number("positionSeconds")?,
            args["autoplay"].as_bool().unwrap_or(false),
        )
        .await
        .map(|()| Value::Null),
        "queue_native_audio" => native_audio::queue_native_audio(player, agent.arg_source(args, "source"), agent.arg_source(args, "expectedSource"))
            .await
            .map(|()| Value::Null),
        "play_native_audio" => native_audio::play_native_audio(player).await.map(|()| Value::Null),
        "pause_native_audio" => native_audio::pause_native_audio(player).await.map(|()| Value::Null),
        "seek_native_audio" => native_audio::seek_native_audio(player, number("positionSeconds")?).await.map(|()| Value::Null),
        "warm_native_audio" => native_audio::warm_native_audio(player, agent.arg_source(args, "source").ok_or("`source` is missing")?).map(|()| Value::Null),
        "set_native_audio_volume" => native_audio::set_native_audio_volume(player, number("volume")?).await.map(|()| Value::Null),
        "native_audio_volume" => native_audio::native_audio_volume(player).await.map(|volume| json!(volume)),
        // The core playing on one of this computer's outputs selects it here.
        "select_native_audio_device" => {
            let device = args["deviceId"].as_str().unwrap_or_default().to_owned();
            let mut settings = native_audio::native_audio_settings(player.clone()).await?;
            if settings.selected_output_id != device {
                settings.selected_output_id = device;
                native_audio::set_native_audio_settings(player, settings).await?;
            }
            Ok(Value::Null)
        }
        "native_audio_settings" => native_audio::native_audio_settings(player)
            .await
            .and_then(|settings| serde_json::to_value(settings).map_err(|error| error.to_string())),
        // One output's own settings: its preset, exclusive mode, resync delay and whether it's shown.
        "set_output_settings" => {
            let output_id = args["outputId"].as_str().ok_or("`outputId` is missing")?.to_owned();
            let change = &args["change"];
            let mut settings = native_audio::native_audio_settings(player.clone()).await?;
            let output = settings
                .outputs
                .iter_mut()
                .find(|output| output.id == output_id)
                .ok_or("That output isn't on this computer")?;
            if let Some(preset) = change.get("presetId") {
                output.preset_id = preset.as_str().map(str::to_owned);
            }
            if let Some(exclusive) = change["exclusiveMode"].as_bool() {
                output.exclusive_mode = exclusive;
            }
            if let Some(enabled) = change["enabled"].as_bool() {
                output.enabled = enabled;
            }
            if let Some(delay) = change["resyncDelayMs"].as_u64() {
                output.resync_delay_ms = u32::try_from(delay).map_err(|_| "That resync delay is too long")?;
            }
            native_audio::set_native_audio_settings(player, settings).await.map(|()| Value::Null)
        }
        _ => Err("This computer doesn't take that command".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_move_onto_this_apps_server_with_its_token() {
        let sent = "http://127.0.0.1:38147/api/providers/qobuz/tracks/1/stream?q=27&access_token=theirs";
        assert_eq!(
            local_source("http://10.0.0.5:38147", Some("mine/+"), sent),
            "http://10.0.0.5:38147/api/providers/qobuz/tracks/1/stream?q=27&access_token=mine%2F%2B"
        );
        assert_eq!(local_source("http://10.0.0.5:38147", Some("t"), r"C:\Music\song.flac"), r"C:\Music\song.flac");
    }

    #[test]
    fn the_server_machine_needs_no_token() {
        assert_eq!(local_source("http://127.0.0.1:38147", None, "http://192.168.1.2:38147/api/x?access_token=t"), "http://127.0.0.1:38147/api/x");
    }

    #[test]
    fn permanent_library_paths_resolve_on_the_outputs_own_connection() {
        assert_eq!(local_source("http://10.0.0.5:38147", Some("mine"), "/api/music/local/files/abc.flac"), "http://10.0.0.5:38147/api/music/local/files/abc.flac?access_token=mine");
    }
}
