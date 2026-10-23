#[cfg(target_os = "macos")]
static TRACKPAD_MONITOR: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

// DOM wheel events do not expose when fingers leave a trackpad. Forward only the
// native phase boundaries; the WebView still owns scrolling and gesture targeting.
#[cfg(target_os = "macos")]
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use block::ConcreteBlock;
    use cocoa::{
        appkit::{NSEventMask, NSEventPhase},
        base::id,
    };
    use objc::{class, msg_send, sel, sel_impl};
    use tauri::{Emitter, Manager};

    let window = app.get_webview_window("main").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "main window not found")
    })?;
    let native_window = window.ns_window()? as usize;
    let handler = ConcreteBlock::new(move |event: id| -> id {
        unsafe {
            let event_window: id = msg_send![event, window];
            if event_window as usize != native_window {
                return event;
            }
            let phase: NSEventPhase = msg_send![event, phase];
            let name = if phase.contains(NSEventPhase::NSEventPhaseBegan) {
                "began"
            } else if phase.contains(NSEventPhase::NSEventPhaseCancelled) {
                "cancelled"
            } else if phase.contains(NSEventPhase::NSEventPhaseEnded) {
                "ended"
            } else {
                return event;
            };
            let _ = window.emit("trackpad-phase", name);
        }
        event
    })
    .copy();

    unsafe {
        let monitor: id = msg_send![class!(NSEvent),
            addLocalMonitorForEventsMatchingMask: NSEventMask::NSScrollWheelMask.bits()
            handler: &*handler];
        if monitor.is_null() {
            return Err(std::io::Error::other("Could not observe trackpad gestures").into());
        }
        let retained: id = msg_send![monitor, retain];
        TRACKPAD_MONITOR.store(retained as usize, std::sync::atomic::Ordering::Release);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn cleanup() {
    use cocoa::base::id;
    use objc::{class, msg_send, sel, sel_impl};

    // RunEvent::Exit runs on the same main thread that installed the monitor.
    let monitor = TRACKPAD_MONITOR.swap(0, std::sync::atomic::Ordering::AcqRel) as id;
    if !monitor.is_null() {
        unsafe {
            let _: () = msg_send![class!(NSEvent), removeMonitor: monitor];
            let _: () = msg_send![monitor, release];
        }
    }
}

#[cfg(target_os = "windows")]
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;

    let window = app.get_webview_window("main").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "main window not found")
    })?;
    // Tauri setup runs on the window's owning thread, as required by SetWindowSubclass.
    if unsafe { SetWindowSubclass(window.hwnd()?.0, Some(menu_focus_filter), 0, 0) } == 0 {
        return Err(std::io::Error::other("Could not disable native menu keyboard focus").into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn menu_focus_filter(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    subclass_id: usize,
    _reference_data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass},
        WindowsAndMessaging::{SC_KEYMENU, WM_NCDESTROY, WM_SYSCOMMAND},
    };

    // Bare Alt/F10 enters menu mode with no mnemonic. Preserve Alt+Space and other system shortcuts.
    if message == WM_SYSCOMMAND && wparam & 0xfff0 == SC_KEYMENU as usize && lparam == 0 {
        return 0;
    }
    if message == WM_NCDESTROY {
        unsafe { RemoveWindowSubclass(hwnd, Some(menu_focus_filter), subclass_id) };
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn native_function_modifier_pressed() -> bool {
    use cocoa::appkit::NSEventModifierFlags;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let flags: NSEventModifierFlags = msg_send![class!(NSEvent), modifierFlags];
        flags.contains(NSEventModifierFlags::NSFunctionKeyMask)
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn native_function_modifier_pressed() -> bool {
    false
}
