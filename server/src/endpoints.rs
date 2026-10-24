//! Audio outputs attached to the server. Apps report their devices and engine status,
//! then execute the core's commands. Other apps may inspect and configure outputs;
//! transport commands go through the core so there is only one playback state.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, oneshot};

/// An endpoint that hasn't reported for this long is offline.
const OFFLINE_AFTER: Duration = Duration::from_secs(8);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_WAIT_SECONDS: u64 = 30;
const MAX_QUEUED: usize = 64;
/// What another device may ask an endpoint to do; anything else is refused here and there.
pub const COMMANDS: &[&str] = &[
    "native_audio_settings",
    "set_output_settings",
    "native_audio_volume",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueuedCommand {
    id: u64,
    command: String,
    args: Value,
}

struct Endpoint {
    name: String,
    devices: Value,
    selected_device_id: Value,
    status: Value,
    status_at: Instant,
    seen: Instant,
    queue: VecDeque<QueuedCommand>,
    work: Arc<Notify>,
}

#[derive(Default)]
pub struct Endpoints {
    endpoints: Mutex<HashMap<String, Endpoint>>,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
}

type Shared = Arc<Endpoints>;

pub fn router<S: Clone + Send + Sync + 'static>(endpoints: Shared) -> Router<S> {
    Router::new()
        .route("/api/endpoints", get(list))
        .route("/api/endpoints/{endpoint_id}/presence", post(presence))
        .route("/api/endpoints/{endpoint_id}/commands", get(collect))
        .route("/api/endpoints/{endpoint_id}/results", post(result))
        .route("/api/endpoints/{endpoint_id}/command", post(command))
        .with_state(endpoints)
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EndpointView {
    id: String,
    name: String,
    devices: Value,
    selected_device_id: Value,
    status: Value,
}

async fn list(State(endpoints): State<Shared>) -> Json<Vec<EndpointView>> {
    let mut endpoints = endpoints.endpoints.lock().await;
    endpoints.retain(|_, endpoint| endpoint.seen.elapsed() < OFFLINE_AFTER * 4);
    let mut online = endpoints
        .iter()
        .filter(|(_, endpoint)| endpoint.seen.elapsed() < OFFLINE_AFTER)
        .map(|(id, endpoint)| EndpointView {
            id: id.clone(),
            name: endpoint.name.clone(),
            devices: endpoint.devices.clone(),
            selected_device_id: endpoint.selected_device_id.clone(),
            status: endpoint.status.clone(),
        })
        .collect::<Vec<_>>();
    online.sort_by(|a, b| a.name.cmp(&b.name));
    Json(online)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Presence {
    name: String,
    /// Sent when they change or every few seconds; kept from the last report otherwise.
    devices: Option<Value>,
    selected_device_id: Option<Value>,
    status: Option<Value>,
}

async fn presence(State(endpoints): State<Shared>, Path(endpoint_id): Path<String>, Json(report): Json<Presence>) -> Response {
    if !valid_id(&endpoint_id) || report.name.trim().is_empty() || report.name.chars().count() > 64 {
        return error(StatusCode::BAD_REQUEST, "An endpoint needs an ID and a name");
    }
    let mut endpoints = endpoints.endpoints.lock().await;
    let endpoint = endpoints.entry(endpoint_id).or_insert_with(|| Endpoint {
        name: String::new(),
        devices: json!([]),
        selected_device_id: Value::Null,
        status: Value::Null,
        status_at: Instant::now(),
        seen: Instant::now(),
        queue: VecDeque::new(),
        work: Arc::new(Notify::new()),
    });
    endpoint.name = report.name.trim().to_owned();
    endpoint.seen = Instant::now();
    if let Some(devices) = report.devices.filter(Value::is_array) {
        endpoint.devices = devices;
    }
    if let Some(selected) = report.selected_device_id {
        endpoint.selected_device_id = selected;
    }
    if let Some(status) = report.status {
        endpoint.status = status;
        endpoint.status_at = Instant::now();
    }
    Json(json!({})).into_response()
}

#[derive(Deserialize)]
struct CollectQuery {
    wait: Option<u64>,
}

/// The endpoint's queued commands, waiting up to `wait` seconds for one to arrive.
async fn collect(State(endpoints): State<Shared>, Path(endpoint_id): Path<String>, Query(query): Query<CollectQuery>) -> Response {
    let deadline = Instant::now() + Duration::from_secs(query.wait.unwrap_or(0).min(MAX_WAIT_SECONDS));
    loop {
        let work = {
            let mut endpoints = endpoints.endpoints.lock().await;
            let Some(endpoint) = endpoints.get_mut(&endpoint_id) else {
                return error(StatusCode::NOT_FOUND, "Report presence before collecting commands");
            };
            endpoint.seen = Instant::now();
            if !endpoint.queue.is_empty() {
                return Json(endpoint.queue.drain(..).collect::<Vec<_>>()).into_response();
            }
            endpoint.work.clone()
        };
        let Some(remaining) = deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()) else {
            return Json(Vec::<QueuedCommand>::new()).into_response();
        };
        let _ = tokio::time::timeout(remaining, work.notified()).await;
    }
}

#[derive(Deserialize)]
struct CommandResult {
    id: u64,
    ok: bool,
    #[serde(default)]
    value: Value,
    error: Option<String>,
}

async fn result(State(endpoints): State<Shared>, Json(result): Json<CommandResult>) -> Response {
    if let Some(waiter) = endpoints.waiting.lock().await.remove(&result.id) {
        let _ = waiter.send(if result.ok {
            Ok(result.value)
        } else {
            Err(result.error.unwrap_or_else(|| "The device couldn't do that".into()))
        });
    }
    Json(json!({})).into_response()
}

#[derive(Deserialize)]
struct CommandRequest {
    command: String,
    #[serde(default)]
    args: Value,
}

async fn command(State(endpoints): State<Shared>, Path(endpoint_id): Path<String>, Json(request): Json<CommandRequest>) -> Response {
    if request.command == "native_audio_status" {
        let endpoints = endpoints.endpoints.lock().await;
        return match endpoints.get(&endpoint_id).filter(|endpoint| endpoint.seen.elapsed() < OFFLINE_AFTER) {
            Some(endpoint) if !endpoint.status.is_null() => Json(endpoint.status.clone()).into_response(),
            Some(_) => error(StatusCode::SERVICE_UNAVAILABLE, "That device hasn't reported its playback yet"),
            None => error(StatusCode::SERVICE_UNAVAILABLE, "That device is offline"),
        };
    }
    if !COMMANDS.contains(&request.command.as_str()) {
        return error(StatusCode::BAD_REQUEST, "Other devices can't be asked to do that");
    }
    let (reply, answer) = oneshot::channel();
    // The waiter is registered first, so an answer can't arrive before anyone listens for it.
    let id = next_id(&endpoints);
    endpoints.waiting.lock().await.insert(id, reply);
    if let Err(response) = enqueue(&endpoints, &endpoint_id, id, &request.command, request.args).await {
        endpoints.waiting.lock().await.remove(&id);
        return response;
    }
    match tokio::time::timeout(COMMAND_TIMEOUT, answer).await {
        Ok(Ok(Ok(value))) => Json(value).into_response(),
        Ok(Ok(Err(message))) => error(StatusCode::BAD_GATEWAY, message),
        _ => {
            endpoints.waiting.lock().await.remove(&id);
            error(StatusCode::GATEWAY_TIMEOUT, "That device didn't answer in time")
        }
    }
}

impl Endpoints {
    /// Runs a command on an endpoint for the server itself, and waits for its answer.
    pub async fn call(&self, endpoint_id: &str, command: &str, args: Value) -> Result<Value, String> {
        let (reply, answer) = oneshot::channel();
        let id = next_id(self);
        self.waiting.lock().await.insert(id, reply);
        if enqueue(self, endpoint_id, id, command, args).await.is_err() {
            self.waiting.lock().await.remove(&id);
            return Err(format!("{} is offline", self.name(endpoint_id).await.unwrap_or_else(|| "That device".into())));
        }
        match tokio::time::timeout(COMMAND_TIMEOUT, answer).await {
            Ok(Ok(result)) => result,
            _ => {
                self.waiting.lock().await.remove(&id);
                Err("The device didn't answer in time".into())
            }
        }
    }

    /// The endpoint's latest playback report and when it came, while it's online.
    pub async fn status(&self, endpoint_id: &str) -> Option<(Value, Instant)> {
        let endpoints = self.endpoints.lock().await;
        let endpoint = endpoints.get(endpoint_id).filter(|endpoint| endpoint.seen.elapsed() < OFFLINE_AFTER)?;
        Some((endpoint.status.clone(), endpoint.status_at))
    }

    pub async fn online(&self, endpoint_id: &str) -> bool {
        self.endpoints.lock().await.get(endpoint_id).is_some_and(|endpoint| endpoint.seen.elapsed() < OFFLINE_AFTER)
    }

    pub async fn name(&self, endpoint_id: &str) -> Option<String> {
        self.endpoints.lock().await.get(endpoint_id).map(|endpoint| endpoint.name.clone())
    }
}

/// Puts a command in an online endpoint's queue without waiting for its answer.
async fn enqueue(endpoints: &Endpoints, endpoint_id: &str, id: u64, command: &str, args: Value) -> Result<(), Response> {
    let mut all = endpoints.endpoints.lock().await;
    let Some(endpoint) = all.get_mut(endpoint_id).filter(|endpoint| endpoint.seen.elapsed() < OFFLINE_AFTER) else {
        return Err(error(StatusCode::SERVICE_UNAVAILABLE, "That device is offline"));
    };
    if endpoint.queue.len() >= MAX_QUEUED {
        return Err(error(StatusCode::SERVICE_UNAVAILABLE, "That device isn't keeping up"));
    }
    endpoint.queue.push_back(QueuedCommand { id, command: command.to_owned(), args });
    endpoint.work.notify_waiters();
    endpoint.work.notify_one();
    Ok(())
}

fn next_id(endpoints: &Endpoints) -> u64 {
    endpoints.next_id.fetch_add(1, Ordering::Relaxed) + 1
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn report(status: Value) -> Json<Presence> {
        Json(Presence { name: "Desk".into(), devices: Some(json!([{ "id": "d1", "name": "Speakers" }])), selected_device_id: None, status: Some(status) })
    }

    #[tokio::test]
    async fn a_command_reaches_the_endpoint_and_its_answer_comes_back() {
        let endpoints = Shared::default();
        presence(State(endpoints.clone()), Path("pc-1".into()), report(json!({ "isPlaying": false }))).await;

        let sender = tokio::spawn({
            let endpoints = endpoints.clone();
            async move {
                body(command(State(endpoints), Path("pc-1".into()), Json(CommandRequest { command: "set_output_settings".into(), args: json!({ "outputId": "d1", "change": { "enabled": true } }) })).await).await
            }
        });
        let (_, work) = body(collect(State(endpoints.clone()), Path("pc-1".into()), Query(CollectQuery { wait: Some(2) })).await).await;
        assert_eq!(work[0]["command"], "set_output_settings");
        assert_eq!(work[0]["args"]["outputId"], "d1");
        let id = work[0]["id"].as_u64().unwrap();
        result(State(endpoints.clone()), Json(CommandResult { id, ok: true, value: json!(null), error: None })).await;
        let (status, _) = tokio::time::timeout(Duration::from_secs(2), sender).await.unwrap().unwrap();
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn status_comes_from_the_last_report_and_unknown_commands_are_refused() {
        let endpoints = Shared::default();
        presence(State(endpoints.clone()), Path("pc-1".into()), report(json!({ "isPlaying": true }))).await;
        let (status, value) = body(command(State(endpoints.clone()), Path("pc-1".into()), Json(CommandRequest { command: "native_audio_status".into(), args: Value::Null })).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["isPlaying"], true);
        let (status, _) = body(command(State(endpoints.clone()), Path("pc-1".into()), Json(CommandRequest { command: "load_native_audio".into(), args: Value::Null })).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "Only the core may direct playback");
        let (status, _) = body(command(State(endpoints.clone()), Path("pc-1".into()), Json(CommandRequest { command: "export_playlist_csv".into(), args: Value::Null })).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = body(command(State(endpoints), Path("other".into()), Json(CommandRequest { command: "native_audio_settings".into(), args: Value::Null })).await).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn the_list_shows_online_endpoints_with_their_outputs() {
        let endpoints = Shared::default();
        presence(State(endpoints.clone()), Path("pc-1".into()), report(json!({}))).await;
        let Json(list) = list(State(endpoints)).await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Desk");
        assert_eq!(list[0].devices[0]["name"], "Speakers");
    }
}
