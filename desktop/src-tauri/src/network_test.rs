//! Opt-in stdin driver for physical networking tests in the real debug Desktop.
//! Uses the selected server's existing authenticated bridge and native player.

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    Status {},
    Tracks {},
    UseDefaultOutput {},
    Play {},
    Pause {},
    Seek { position_seconds: f64 },
    PlayTrack { track_id: String },
    Reconnect {},
    UiTogglePlayback {},
    Quit {},
}

pub fn start(app: AppHandle) {
    if !std::env::args().any(|arg| arg == "--network-test-stdin") {
        return;
    }
    std::thread::spawn(move || {
        use std::io::{BufRead, Write};
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let result = match serde_json::from_str::<Command>(&line) {
                Ok(Command::Quit {}) => {
                    app.exit(0);
                    break;
                }
                Ok(command) => tauri::async_runtime::block_on(run(&app, command)),
                Err(error) => Err(error.to_string()),
            };
            let mut response = match result {
                Ok(value) => json!({ "networkTest": true, "ok": true, "value": value }),
                Err(error) => json!({ "networkTest": true, "ok": false, "error": error }),
            };
            let connection = app.state::<crate::server_link::ServerLink>().connection();
            redact(
                &mut response,
                &connection.base_url,
                connection.token.as_deref(),
            );
            println!("{response}");
            let _ = std::io::stdout().flush();
        }
    });
}

fn redact(value: &mut Value, base_url: &str, token: Option<&str>) {
    match value {
        Value::String(text) => {
            *text = text.replace(base_url, "[selected-server]");
            if let Some(token) = token.filter(|token| !token.is_empty()) {
                *text = text.replace(token, "[redacted]");
            }
        }
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| redact(value, base_url, token)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|value| redact(value, base_url, token)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_redact_capabilities_and_bearers_in_nested_errors() {
        let base = "http://127.0.0.1:38123/private-capability";
        let mut value = json!({ "native": { "error": format!("Failed to read {base}/api/music?access_token=device-bearer") }, "items": ["device-bearer"] });
        redact(&mut value, base, Some("device-bearer"));
        let output = value.to_string();
        assert!(!output.contains("private-capability"));
        assert!(!output.contains("device-bearer"));
        assert!(output.contains("[selected-server]/api/music"));
    }

    #[test]
    fn driver_rejects_unknown_actions_and_fields() {
        assert!(
            serde_json::from_str::<Command>(r#"{"action":"request","url":"http://example.com"}"#)
                .is_err()
        );
        assert!(serde_json::from_str::<Command>(r#"{"action":"play","unexpected":true}"#).is_err());
    }
}

async fn run(app: &AppHandle, command: Command) -> Result<Value, String> {
    let link = app.state::<crate::server_link::ServerLink>();
    if matches!(command, Command::UiTogglePlayback {}) {
        app.get_webview_window("main")
            .ok_or("Desktop window missing")?
            .eval("document.getElementById('playBtn')?.click()")
            .map_err(|error| error.to_string())?;
        return Ok(json!({ "clicked": true }));
    }
    if matches!(command, Command::Reconnect {}) {
        link.reconnect_for_test().await?;
        return Ok(json!({ "closed": true }));
    }
    if matches!(command, Command::Status {}) {
        let mut native = serde_json::to_value(
            crate::native_audio::native_audio_status(
                app.state::<crate::native_audio::NativeAudioPlayer>(),
            )
            .await?,
        )
        .map_err(|error| error.to_string())?;
        // Sources contain the private bridge capability. Never print them.
        if let Some(object) = native.as_object_mut() {
            let source = object.remove("currentSource");
            object.insert(
                "hasSource".into(),
                json!(source.is_some_and(|value| value.is_string())),
            );
        }
        return Ok(
            json!({ "network": crate::server_link::network_connection_status(link), "native": native }),
        );
    }
    let connection = link.connection();
    if connection.server.is_none() {
        return Err("No paired server selected".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let response = match command {
        Command::UseDefaultOutput {} => {
            // The frontend owns switching between local and shared playback.
            // Wait for its own output agent; starting another one races that
            // transition and can pause the player after the test starts it.
            let output = tokio::time::timeout(std::time::Duration::from_secs(15),async {
                loop {
                    let endpoints: Value = client.get(format!("{}/api/endpoints",connection.base_url)).send().await
                        .map_err(|e|e.without_url().to_string())?.error_for_status().map_err(|e|e.without_url().to_string())?
                        .json().await.map_err(|e|e.without_url().to_string())?;
                    if let Some(endpoint) = endpoints.as_array().into_iter().flatten().find(|e|e["id"]==connection.client_id) {
                        if let Some(device) = endpoint["devices"].as_array().into_iter().flatten().find(|d|d["isDefault"]==true && d["enabled"]!=false) {
                            break Ok::<_,String>(json!({"endpointId":connection.client_id,"deviceId":device["id"],"endpointName":endpoint["name"],"deviceName":device["name"]}));
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }).await.map_err(|_|"This Desktop's default output did not register within 15 seconds".to_owned())??;
            client.post(format!("{}/api/session/command",connection.base_url)).json(&json!({"action":"output","output":output})).send().await
        }
        Command::Tracks {} => client.get(format!("{}/api/music/local/tracks", connection.base_url)).send().await,
        Command::PlayTrack { track_id } => {
            let session: Value = client.get(format!("{}/api/session", connection.base_url)).send().await
                .map_err(|error| error.without_url().to_string())?.error_for_status()
                .map_err(|error| error.without_url().to_string())?.json().await
                .map_err(|error| error.without_url().to_string())?;
            let mut queue = session["queue"].clone();
            if !queue["tracks"].as_array().is_some_and(|tracks| tracks.iter().any(|track| track["globalId"] == track_id)) {
                return Err("Track is absent from the server queue catalog".into());
            }
            // Keep the previous selection available; preserve history and all queued songs.
            if !queue["current"].is_null() && queue["current"]["globalTrackId"] != track_id {
                let previous = queue["current"].take();
                queue["upcoming"].as_array_mut().ok_or("Invalid server queue")?.insert(0, previous);
            }
            queue["current"] = json!({ "globalTrackId": track_id, "source": { "kind": "library", "id": "network-test", "entryId": 0 }, "shufflePackageId": null });
            client.post(format!("{}/api/session/queue", connection.base_url))
                .json(&json!({ "base": session["queueRevision"], "queue": queue, "playTrackId": track_id })).send().await
        }
        command => {
            let body = match command {
                Command::Play {} => json!({ "action": "play" }),
                Command::Pause {} => json!({ "action": "pause" }),
                Command::Seek { position_seconds } if position_seconds.is_finite() && position_seconds >= 0.0 => json!({ "action": "seek", "positionSeconds": position_seconds }),
                _ => return Err("Invalid playback command".into()),
            };
            client.post(format!("{}/api/session/command", connection.base_url)).json(&body).send().await
        }
    }.map_err(|error| error.without_url().to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Server answered {status}"));
    }
    let mut value: Value = response
        .json()
        .await
        .map_err(|error| error.without_url().to_string())?;
    if let Some(object) = value.as_object_mut() {
        object.remove("queue");
    }
    Ok(value)
}
