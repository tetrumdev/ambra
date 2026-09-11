use serde::{Deserialize, Serialize};
use std::{fs, sync::mpsc, time::Duration};
use tauri::{LogicalSize, Manager, PhysicalPosition, Window, WindowEvent};

#[derive(Serialize, Deserialize)]
struct Bounds {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    scale_factor: f64,
}

fn save(window: &Window) -> Result<(), Box<dyn std::error::Error>> {
    // Fullscreen and maximized dimensions must never replace the normal bounds.
    if window.is_fullscreen()? || window.is_maximized()? || window.is_minimized()? {
        return Ok(());
    }
    let size = window.inner_size()?;
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }
    let position = window.outer_position()?;
    let bounds = Bounds {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        scale_factor: window.scale_factor()?,
    };
    let directory = window.app_handle().path().app_config_dir()?;
    static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "Window bounds write lock was poisoned")?;
    fs::create_dir_all(&directory)?;
    let pending = directory.join("window-bounds.json.tmp");
    fs::write(&pending, serde_json::to_vec(&bounds)?)?;
    fs::rename(pending, directory.join("window-bounds.json"))?;
    Ok(())
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("window-bounds")
        .on_webview_ready(|webview| {
            let window = webview.window();
            if window.label() == "main" {
                if let Err(error) = setup(window.clone()) {
                    eprintln!("Could not restore window bounds: {error}");
                }
            }
        })
        .build()
}

fn setup(window: Window) -> Result<(), Box<dyn std::error::Error>> {
    let path = window
        .app_handle()
        .path()
        .app_config_dir()?
        .join("window-bounds.json");
    if let Some(bounds) = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Bounds>(&bytes).ok())
        .filter(|bounds| {
            bounds.width > 0
                && bounds.height > 0
                && bounds.scale_factor.is_finite()
                && bounds.scale_factor > 0.0
        })
    {
        window.set_size(LogicalSize::new(
            f64::from(bounds.width) / bounds.scale_factor,
            f64::from(bounds.height) / bounds.scale_factor,
        ))?;
        let monitor_present = window.available_monitors()?.iter().any(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            i64::from(bounds.x) >= i64::from(position.x)
                && i64::from(bounds.x) + 64 < i64::from(position.x) + i64::from(size.width)
                && i64::from(bounds.y) >= i64::from(position.y)
                && i64::from(bounds.y) + 64 < i64::from(position.y) + i64::from(size.height)
        });
        if monitor_present {
            window.set_position(PhysicalPosition::new(bounds.x, bounds.y))?;
        } else {
            window.center()?;
        }
    }

    // Rebuilds can terminate the process without a normal exit event.
    // Persist after movement settles instead of relying on shutdown alone.
    let (sender, receiver) = mpsc::channel();
    let worker_window = window.clone();
    std::thread::Builder::new()
        .name("ambra-window-bounds".into())
        .spawn(move || {
            while receiver.recv().is_ok() {
                while receiver.recv_timeout(Duration::from_millis(300)).is_ok() {}
                if let Err(error) = save(&worker_window) {
                    eprintln!("Could not save window bounds: {error}");
                }
            }
        })?;
    let closing_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let _ = sender.send(());
        }
        WindowEvent::CloseRequested { .. } => {
            // The last move may have happened less than 300 ms before closing.
            if let Err(error) = save(&closing_window) {
                eprintln!("Could not save window bounds: {error}");
            }
        }
        _ => {}
    });
    Ok(())
}
