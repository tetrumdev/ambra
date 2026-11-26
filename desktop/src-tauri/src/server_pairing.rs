//! Pairing new devices with a server running on this computer. The server only takes pairing
//! from its own machine (`/api/local/`, loopback with a loopback host name), and the app's usual
//! connection goes through the encrypted bridge, so these calls go to loopback directly.

use serde_json::{Value, json};
use std::time::Duration;

// shortcut: assumes the server's default port; read its config if servers on other ports need pairing here.
const LOCAL_SERVER: &str = "http://127.0.0.1:38147";

/// `qr` (the pairing link and its QR code), `list` (devices waiting and paired), `approve` or `deny` a code.
#[tauri::command]
pub async fn local_pairing(action: String, code: Option<String>) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let request = match action.as_str() {
        "qr" => client.get(format!("{LOCAL_SERVER}/api/local/pairing/qr")),
        "list" => client.get(format!("{LOCAL_SERVER}/api/local/pairing")),
        "approve" | "deny" => {
            let code = code.ok_or("A pairing code is needed")?;
            client.post(format!("{LOCAL_SERVER}/api/local/pairing/{action}")).json(&json!({ "code": code }))
        }
        _ => return Err("Unknown pairing action".into()),
    };
    let response = request.send().await.map_err(|error| {
        if error.is_connect() || error.is_timeout() {
            "No Ambra server is running on this computer. Pair devices from the computer that runs it.".to_owned()
        } else {
            error.to_string()
        }
    })?;
    let status = response.status();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(value)
    } else {
        Err(value["error"].as_str().map(str::to_owned).unwrap_or_else(|| format!("The server answered {status}")))
    }
}
