#![allow(unexpected_cfgs)] // objc 0.2 macros still probe the removed cargo-clippy cfg.

use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::Deserialize;
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use tauri::{App, AppHandle, Emitter, Manager, State, Url};

pub const MEDIA_CONTROL_EVENT: &str = "native-media-control";

pub struct NativeMediaControls {
    controls: Mutex<MediaControls>,
    commands_enabled: Arc<AtomicBool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMediaMetadata {
    title: String,
    artist: String,
    album: String,
    duration_seconds: f64,
    cover_source: Option<String>,
    asset_source: Option<String>,
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    let hwnd = {
        let window = app.get_webview_window("main").ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "main window not found")
        })?;

        Some(window.hwnd()?.0)
    };

    #[cfg(not(target_os = "windows"))]
    let hwnd = None;

    let config = PlatformConfig {
        dbus_name: "com.quantium.ambra",
        display_name: "AMBRA",
        hwnd,
    };

    let mut controls = MediaControls::new(config)?;

    let app_handle = app.handle().clone();
    let commands_enabled = Arc::new(AtomicBool::new(false));
    let handler_enabled = commands_enabled.clone();

    controls.attach(move |event| {
        if handler_enabled.load(Ordering::Relaxed)
            && let Some(action) = media_control_action(&event)
        {
            let _ = app_handle.emit(MEDIA_CONTROL_EVENT, action);
        }
    })?;

    app.manage(NativeMediaControls {
        controls: Mutex::new(controls),
        commands_enabled,
    });
    Ok(())
}

fn media_control_action(event: &MediaControlEvent) -> Option<&'static str> {
    match event {
        MediaControlEvent::Play => Some("play"),
        MediaControlEvent::Pause | MediaControlEvent::Stop => Some("pause"),
        MediaControlEvent::Toggle => Some("toggle"),
        MediaControlEvent::Next => Some("next"),
        MediaControlEvent::Previous => Some("previous"),
        _ => None,
    }
}

#[tauri::command]
pub fn set_native_media_metadata(
    app: AppHandle,
    controls: State<'_, NativeMediaControls>,
    metadata: NativeMediaMetadata,
) -> Result<(), String> {
    let cover_url = metadata
        .cover_source
        .as_deref()
        .and_then(|source| native_cover_url(&app, source));
    let asset_url = metadata.asset_source.as_deref().and_then(native_asset_url);

    controls
        .controls
        .lock()
        .map_err(|_| "Native media controls are unavailable".to_owned())?
        .set_metadata(MediaMetadata {
            title: Some(&metadata.title),
            artist: Some(&metadata.artist),
            album: Some(&metadata.album),
            cover_url: cover_url.as_deref(),
            duration: finite_duration(metadata.duration_seconds),
        })
        .map_err(|error| error.to_string())?;
    if let Some(asset_url) = asset_url {
        set_native_asset_url(&asset_url);
    }
    Ok(())
}

fn native_cover_url(app: &AppHandle, source: &str) -> Option<String> {
    if source.starts_with("https://") || source.starts_with("http://") {
        return Some(source.to_owned());
    }

    if source.starts_with("data:") {
        return cache_embedded_cover(app, source)
            .map_err(|error| eprintln!("Could not cache native album artwork: {error}"))
            .ok();
    }

    Url::from_file_path(Path::new(source))
        .ok()
        .map(|url| url.to_string())
}

fn native_asset_url(source: &str) -> Option<String> {
    if source.starts_with("https://") || source.starts_with("http://") {
        return Some(source.to_owned());
    }

    Url::from_file_path(Path::new(source))
        .ok()
        .map(|url| url.to_string())
}

fn cache_embedded_cover(app: &AppHandle, source: &str) -> Result<String, String> {
    let (metadata, encoded) = source
        .split_once(',')
        .ok_or_else(|| "Embedded artwork has no data".to_owned())?;
    if !metadata.ends_with(";base64") {
        return Err("Embedded artwork is not base64 encoded".to_owned());
    }

    let extension = match metadata
        .trim_start_matches("data:")
        .trim_end_matches(";base64")
    {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    };
    let bytes = BASE64
        .decode(encoded)
        .map_err(|error| format!("Could not decode embedded artwork: {error}"))?;
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate Ambra's cache directory: {error}"))?
        .join("now-playing-artwork");
    fs::create_dir_all(&cache_directory)
        .map_err(|error| format!("Could not create artwork cache: {error}"))?;
    let cache_path = cache_directory.join(format!("{:016x}.{extension}", hasher.finish()));
    if !cache_path.is_file() {
        fs::write(&cache_path, bytes)
            .map_err(|error| format!("Could not write artwork cache: {error}"))?;
    }

    Url::from_file_path(cache_path)
        .map(|url| url.to_string())
        .map_err(|_| "Could not create an artwork file URL".to_owned())
}

#[tauri::command]
pub fn set_native_media_playback(
    controls: State<'_, NativeMediaControls>,
    is_playing: bool,
    position_seconds: f64,
) -> Result<(), String> {
    let progress = finite_duration(position_seconds).map(MediaPosition);
    let playback = if is_playing {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    };

    controls
        .controls
        .lock()
        .map_err(|_| "Native media controls are unavailable".to_owned())?
        .set_playback(playback)
        .map_err(|error| error.to_string())?;
    set_native_playback_rate(if is_playing { 1.0 } else { 0.0 });
    Ok(())
}

#[tauri::command]
pub fn set_native_media_commands_enabled(controls: State<'_, NativeMediaControls>, enabled: bool) {
    controls.commands_enabled.store(enabled, Ordering::Relaxed);
}

#[cfg(target_os = "macos")]
fn set_native_playback_rate(rate: f64) {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    #[allow(non_upper_case_globals)]
    unsafe extern "C" {
        static MPNowPlayingInfoPropertyPlaybackRate: id;
        static MPNowPlayingInfoPropertyDefaultPlaybackRate: id;
    }

    unsafe {
        let media_center: id = msg_send![class!(MPNowPlayingInfoCenter), defaultCenter];
        let previous: id = msg_send![media_center, nowPlayingInfo];
        let now_playing: id = msg_send![class!(NSMutableDictionary), dictionary];
        if previous != nil {
            let _: () = msg_send![now_playing, addEntriesFromDictionary: previous];
        }
        let rate_number: id = msg_send![class!(NSNumber), numberWithDouble: rate];
        let default_rate: id = msg_send![class!(NSNumber), numberWithDouble: 1.0_f64];
        let _: () = msg_send![now_playing, setObject: rate_number
                                        forKey: MPNowPlayingInfoPropertyPlaybackRate];
        let _: () = msg_send![now_playing, setObject: default_rate
                                        forKey: MPNowPlayingInfoPropertyDefaultPlaybackRate];
        let _: () = msg_send![media_center, setNowPlayingInfo: now_playing];
    }
}

#[cfg(not(target_os = "macos"))]
fn set_native_playback_rate(_rate: f64) {}

#[cfg(target_os = "macos")]
fn set_native_asset_url(url: &str) {
    use cocoa::{
        base::{id, nil},
        foundation::NSString,
    };
    use objc::{class, msg_send, sel, sel_impl};

    #[allow(non_upper_case_globals)]
    unsafe extern "C" {
        static MPNowPlayingInfoPropertyAssetURL: id;
    }

    unsafe {
        let url_string = NSString::alloc(nil).init_str(url);
        let asset_url: id = msg_send![class!(NSURL), URLWithString: url_string];
        if asset_url == nil {
            return;
        }

        let media_center: id = msg_send![class!(MPNowPlayingInfoCenter), defaultCenter];
        let previous: id = msg_send![media_center, nowPlayingInfo];
        let now_playing: id = msg_send![class!(NSMutableDictionary), dictionary];
        if previous != nil {
            let _: () = msg_send![now_playing, addEntriesFromDictionary: previous];
        }
        let _: () = msg_send![now_playing, setObject: asset_url
                                        forKey: MPNowPlayingInfoPropertyAssetURL];
        let _: () = msg_send![media_center, setNowPlayingInfo: now_playing];
    }
}

#[cfg(not(target_os = "macos"))]
fn set_native_asset_url(_url: &str) {}

fn finite_duration(seconds: f64) -> Option<Duration> {
    seconds
        .is_finite()
        .then(|| Duration::from_secs_f64(seconds.max(0.0)))
}

#[cfg(test)]
mod tests {
    use super::{finite_duration, media_control_action};
    use souvlaki::MediaControlEvent;
    use std::time::Duration;

    #[test]
    fn maps_headphone_navigation_events() {
        assert_eq!(media_control_action(&MediaControlEvent::Next), Some("next"));
        assert_eq!(
            media_control_action(&MediaControlEvent::Previous),
            Some("previous")
        );
        assert_eq!(
            media_control_action(&MediaControlEvent::Toggle),
            Some("toggle")
        );
    }

    #[test]
    fn rejects_non_finite_media_positions() {
        assert_eq!(finite_duration(f64::NAN), None);
        assert_eq!(finite_duration(-1.0), Some(Duration::ZERO));
    }
}
