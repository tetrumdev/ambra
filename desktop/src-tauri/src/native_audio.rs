#![allow(unexpected_cfgs)] // objc 0.2 macros still probe the removed cargo-clippy cfg.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{App, Manager, State};

#[cfg(target_os = "macos")]
use cocoa::{
    base::{YES, id, nil},
    foundation::NSString,
};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

pub struct NativeAudioPlayer {
    inner: Mutex<NativeAudioState>,
}

struct NativeAudioState {
    current_source: Option<String>,
    next_source: Option<String>,
    #[cfg(target_os = "macos")]
    player: id,
    #[cfg(target_os = "macos")]
    next_item: id,
}

// AVQueuePlayer is safe to address from serialized command calls. The mutex ensures
// that a player cannot be replaced while another command is using it.
#[cfg(target_os = "macos")]
unsafe impl Send for NativeAudioState {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioStatus {
    current_source: Option<String>,
    current_time: f64,
    duration: f64,
    is_playing: bool,
    ended: bool,
}

pub fn setup(app: &mut App) {
    app.manage(NativeAudioPlayer {
        inner: Mutex::new(NativeAudioState {
            current_source: None,
            next_source: None,
            #[cfg(target_os = "macos")]
            player: nil,
            #[cfg(target_os = "macos")]
            next_item: nil,
        }),
    });
}

#[tauri::command]
pub fn load_native_audio(
    player: State<'_, NativeAudioPlayer>,
    source: String,
    next_source: Option<String>,
    position_seconds: f64,
    autoplay: bool,
) -> Result<(), String> {
    load(&player, source, next_source, position_seconds, autoplay)
}

#[tauri::command]
pub fn queue_native_audio(
    player: State<'_, NativeAudioPlayer>,
    source: String,
) -> Result<(), String> {
    queue(&player, source)
}

#[tauri::command]
pub fn play_native_audio(player: State<'_, NativeAudioPlayer>) -> Result<(), String> {
    play(&player)
}

#[tauri::command]
pub fn pause_native_audio(player: State<'_, NativeAudioPlayer>) -> Result<(), String> {
    pause(&player)
}

#[tauri::command]
pub fn seek_native_audio(
    player: State<'_, NativeAudioPlayer>,
    position_seconds: f64,
) -> Result<(), String> {
    seek(&player, position_seconds)
}

#[tauri::command]
pub fn native_audio_status(
    player: State<'_, NativeAudioPlayer>,
) -> Result<NativeAudioStatus, String> {
    status(&player)
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

#[cfg(target_os = "macos")]
fn source_url(source: &str) -> Result<id, String> {
    unsafe {
        let source_string = NSString::alloc(nil).init_str(source);
        let url: id = if source.starts_with("https://") || source.starts_with("http://") {
            msg_send![class!(NSURL), URLWithString: source_string]
        } else if source.starts_with("file://") {
            msg_send![class!(NSURL), URLWithString: source_string]
        } else {
            msg_send![class!(NSURL), fileURLWithPath: source_string]
        };
        let _: () = msg_send![source_string, release];

        if url == nil {
            Err(format!("Could not create an audio URL for {source}"))
        } else {
            Ok(url)
        }
    }
}

#[cfg(target_os = "macos")]
fn player_item(source: &str) -> Result<id, String> {
    let url = source_url(source)?;
    let item: id = unsafe { msg_send![class!(AVPlayerItem), playerItemWithURL: url] };
    if item == nil {
        Err(format!("AVPlayer could not load {source}"))
    } else {
        Ok(item)
    }
}

#[cfg(target_os = "macos")]
fn seconds(time: CMTime) -> Option<f64> {
    if time.timescale <= 0 || time.flags & 1 == 0 {
        return None;
    }

    let value = time.value as f64 / f64::from(time.timescale);
    value.is_finite().then_some(value.max(0.0))
}

#[cfg(target_os = "macos")]
fn seek_player(player: id, position_seconds: f64) {
    let timescale = 1_000_000_i32;
    let time = CMTime {
        value: (position_seconds.max(0.0) * f64::from(timescale)).round() as i64,
        timescale,
        flags: 1,
        epoch: 0,
    };

    unsafe {
        let _: () = msg_send![player, seekToTime: time];
    }
}

#[cfg(target_os = "macos")]
fn load(
    state: &NativeAudioPlayer,
    source: String,
    next_source: Option<String>,
    position_seconds: f64,
    autoplay: bool,
) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Native audio playback is unavailable".to_owned())?;

    unsafe {
        if inner.player != nil {
            let _: () = msg_send![inner.player, pause];
            let _: () = msg_send![inner.player, release];
            inner.player = nil;
        }

        let current_item = player_item(&source)?;
        let queued_item = match next_source.as_deref() {
            Some(next_source) => player_item(next_source)?,
            None => nil,
        };
        let items: id = msg_send![class!(NSMutableArray), array];
        let _: () = msg_send![items, addObject: current_item];
        if queued_item != nil {
            let _: () = msg_send![items, addObject: queued_item];
        }

        let new_player: id = msg_send![class!(AVQueuePlayer), queuePlayerWithItems: items];
        if new_player == nil {
            return Err(format!("AVQueuePlayer could not load {source}"));
        }

        let retained_player: id = msg_send![new_player, retain];
        let _: () = msg_send![retained_player, setAutomaticallyWaitsToMinimizeStalling: YES];
        inner.player = retained_player;
        inner.current_source = Some(source);
        inner.next_source = next_source;
        inner.next_item = queued_item;

        if position_seconds > 0.0 {
            seek_player(retained_player, position_seconds);
        }
        if autoplay {
            let _: () = msg_send![retained_player, play];
        }
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn load(
    _state: &NativeAudioPlayer,
    _source: String,
    _next_source: Option<String>,
    _position_seconds: f64,
    _autoplay: bool,
) -> Result<(), String> {
    Err("Native audio playback is only available on macOS".to_owned())
}

#[cfg(target_os = "macos")]
fn queue(state: &NativeAudioPlayer, source: String) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Native audio playback is unavailable".to_owned())?;
    if inner.player == nil {
        return Err("No native audio player is loaded".to_owned());
    }
    if inner.next_item != nil {
        return Ok(());
    }

    let item = player_item(&source)?;
    unsafe {
        let can_insert: cocoa::base::BOOL =
            msg_send![inner.player, canInsertItem: item afterItem: nil];
        if can_insert != YES {
            return Err(format!("AVQueuePlayer could not queue {source}"));
        }
        let _: () = msg_send![inner.player, insertItem: item afterItem: nil];
    }
    inner.next_source = Some(source);
    inner.next_item = item;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn queue(_state: &NativeAudioPlayer, _source: String) -> Result<(), String> {
    Err("Native audio playback is only available on macOS".to_owned())
}

#[cfg(target_os = "macos")]
fn play(state: &NativeAudioPlayer) -> Result<(), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Native audio playback is unavailable".to_owned())?;
    if inner.player == nil {
        return Err("No native audio track is loaded".to_owned());
    }

    unsafe {
        let _: () = msg_send![inner.player, play];
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn play(_state: &NativeAudioPlayer) -> Result<(), String> {
    Err("Native audio playback is only available on macOS".to_owned())
}

#[cfg(target_os = "macos")]
fn pause(state: &NativeAudioPlayer) -> Result<(), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Native audio playback is unavailable".to_owned())?;
    if inner.player == nil {
        return Ok(());
    }

    unsafe {
        let _: () = msg_send![inner.player, pause];
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn pause(_state: &NativeAudioPlayer) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn seek(state: &NativeAudioPlayer, position_seconds: f64) -> Result<(), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Native audio playback is unavailable".to_owned())?;
    if inner.player == nil {
        return Err("No native audio track is loaded".to_owned());
    }

    seek_player(inner.player, position_seconds);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn seek(_state: &NativeAudioPlayer, _position_seconds: f64) -> Result<(), String> {
    Err("Native audio playback is only available on macOS".to_owned())
}

#[cfg(target_os = "macos")]
fn status(state: &NativeAudioPlayer) -> Result<NativeAudioStatus, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Native audio playback is unavailable".to_owned())?;
    if inner.player == nil {
        return Ok(NativeAudioStatus {
            current_source: None,
            current_time: 0.0,
            duration: 0.0,
            is_playing: false,
            ended: false,
        });
    }

    unsafe {
        let current_item: id = msg_send![inner.player, currentItem];
        if current_item != nil && current_item == inner.next_item {
            inner.current_source = inner.next_source.take();
            inner.next_item = nil;
        }

        let current_time = seconds(msg_send![inner.player, currentTime]).unwrap_or(0.0);
        let duration = if current_item == nil {
            0.0
        } else {
            seconds(msg_send![current_item, duration]).unwrap_or(0.0)
        };
        let rate: f32 = msg_send![inner.player, rate];
        let is_playing = rate > 0.0;
        let ended = current_item == nil && inner.current_source.is_some();

        Ok(NativeAudioStatus {
            current_source: inner.current_source.clone(),
            current_time,
            duration,
            is_playing,
            ended,
        })
    }
}

#[cfg(not(target_os = "macos"))]
fn status(_state: &NativeAudioPlayer) -> Result<NativeAudioStatus, String> {
    Ok(NativeAudioStatus {
        current_source: None,
        current_time: 0.0,
        duration: 0.0,
        is_playing: false,
        ended: false,
    })
}

#[cfg(target_os = "macos")]
impl Drop for NativeAudioState {
    fn drop(&mut self) {
        if self.player == nil {
            return;
        }

        unsafe {
            let _: () = msg_send![self.player, pause];
            let _: () = msg_send![self.player, release];
        }
    }
}
