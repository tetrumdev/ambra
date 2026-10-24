//! Finds a newer signed release on GitHub and installs it. The updater plugin checks signatures;
//! The separately installed server is independent of app updates.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const PROGRESS_EVENT: &str = "app-update-progress";

/// The update the last check found, kept for installing it.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: usize,
    total: Option<u64>,
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<AvailableUpdate>, String> {
    let handle = app.clone();
    let update = app
        .updater_builder()
        // Release the app's resources before Windows exits into the installer.
        .on_before_exit(move || {
            handle.cleanup_before_exit();
        })
        .build()
        .map_err(|error| format!("Could not prepare the updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;
    let available = update.as_ref().map(|update| AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
    });
    *pending
        .0
        .lock()
        .map_err(|_| "The updater state is unavailable".to_owned())? = update;
    Ok(available)
}

/// Downloads and installs the update found by the last check, then restarts into it.
/// On Windows the installer takes over and the app exits before this returns.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "The updater state is unavailable".to_owned())?
        .take()
        .ok_or_else(|| "Check for updates before installing one".to_owned())?;
    let mut downloaded = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk;
                let _ = app.emit(PROGRESS_EVENT, DownloadProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|error| format!("Could not download the update: {error}"))?;
    update
        .install(bytes)
        .map_err(|error| format!("Could not install the update: {error}"))?;
    app.restart();
}
