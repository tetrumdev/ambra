use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};
use tauri::{LogicalSize, Manager, Window, WindowEvent};

#[derive(Clone, Copy, Deserialize, Serialize)]
struct Size {
    width: u32,
    height: u32,
    scale_factor: f64,
}

impl Size {
    fn logical(self) -> Option<LogicalSize<f64>> {
        (self.width > 0
            && self.height > 0
            && self.scale_factor.is_finite()
            && self.scale_factor > 0.0)
            .then(|| {
                LogicalSize::new(
                    f64::from(self.width) / self.scale_factor,
                    f64::from(self.height) / self.scale_factor,
                )
            })
    }
}

fn current_size(window: &Window) -> Option<Size> {
    // Fullscreen, maximized and minimized sizes must never replace normal bounds.
    if window.is_fullscreen().ok()? || window.is_maximized().ok()? || window.is_minimized().ok()? {
        return None;
    }
    let size = window.inner_size().ok()?;
    let size = Size {
        width: size.width,
        height: size.height,
        scale_factor: window.scale_factor().ok()?,
    };
    size.logical()?;
    Some(size)
}

fn save(path: &Path, latest: &Mutex<Option<Size>>) -> Result<(), Box<dyn std::error::Error>> {
    // Read under the write lock so a delayed resize cannot overwrite the closing size.
    let latest = latest.lock().map_err(|_| "Window size lock was poisoned")?;
    let Some(size) = *latest else { return Ok(()) };
    fs::create_dir_all(path.parent().ok_or("Window size path has no parent")?)?;
    let pending = path.with_extension("json.tmp");
    fs::write(&pending, serde_json::to_vec(&size)?)?;
    fs::rename(pending, path)?;
    Ok(())
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?
        .as_ref()
        .window()
        .clone();
    let path = app.path().app_config_dir()?.join("window-bounds.json");
    // Reuse existing bounds files, ignoring position: Wayland does not expose it.
    if let Some(size) = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Size>(&bytes).ok())
        .and_then(Size::logical)
    {
        window.set_size(size)?;
    }

    let latest = Arc::new(Mutex::new(current_size(&window)));
    let (sender, receiver) = mpsc::channel();
    let worker_path = path.clone();
    let worker_latest = latest.clone();
    std::thread::Builder::new()
        .name("ambra-window-size".into())
        .spawn(move || {
            while receiver.recv().is_ok() {
                while receiver.recv_timeout(Duration::from_millis(300)).is_ok() {}
                if let Err(error) = save(&worker_path, &worker_latest) {
                    eprintln!("Could not save window size: {error}");
                }
            }
        })?;
    let observed = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
            if let Some(size) = current_size(&observed) {
                if let Ok(mut latest) = latest.lock() {
                    *latest = Some(size);
                }
                let _ = sender.send(());
            }
        }
        WindowEvent::CloseRequested { .. } => {
            // Flush cached normal bounds, including when closing from fullscreen.
            if let Err(error) = save(&path, &latest) {
                eprintln!("Could not save window size: {error}");
            }
        }
        _ => {}
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_position_fields_are_optional_and_sizes_keep_their_logical_scale() {
        for extra in ["", ",\"x\":20,\"y\":40"] {
            let size: Size = serde_json::from_str(&format!(
                "{{\"width\":1800,\"height\":1200,\"scale_factor\":1.5{extra}}}"
            ))
            .unwrap();
            assert_eq!(size.logical(), Some(LogicalSize::new(1200.0, 800.0)));
        }
    }

    #[test]
    fn invalid_saved_sizes_are_ignored() {
        for (width, height, scale_factor) in [
            (0, 800, 1.0),
            (1200, 0, 1.0),
            (1200, 800, 0.0),
            (1200, 800, f64::NAN),
        ] {
            assert!(
                Size {
                    width,
                    height,
                    scale_factor
                }
                .logical()
                .is_none()
            );
        }
    }
}
