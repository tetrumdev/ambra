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
