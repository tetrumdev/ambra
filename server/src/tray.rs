//! A native notification icon and message-only window. No browser, renderer or webview.
#[cfg(windows)]
mod windows {
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
    use windows_sys::Win32::{
        Foundation::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{Shell::*, WindowsAndMessaging::*},
    };

    static WINDOW: AtomicUsize = AtomicUsize::new(0);
    static QUITTING: AtomicBool = AtomicBool::new(false);
    static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
    const TRAY_MESSAGE: u32 = WM_APP + 1;
    const STOP: usize = 1;
    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }

    unsafe extern "system" fn window_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            // Explorer can restart while the server keeps playing; restore its tray icon.
            if message == TASKBAR_CREATED.load(Ordering::Acquire) && message != 0 {
                let data = GetWindowLongPtrW(window, GWLP_USERDATA) as *const NOTIFYICONDATAW;
                if !data.is_null() { Shell_NotifyIconW(NIM_ADD, data); }
                return 0;
            }
            match message {
                TRAY_MESSAGE if matches!(lparam as u32, WM_RBUTTONUP | WM_LBUTTONUP | WM_CONTEXTMENU) => {
                    let menu = CreatePopupMenu();
                    AppendMenuW(menu, MF_STRING | MF_DISABLED, 0, wide("Ambra Server — Running").as_ptr());
                    AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
                    AppendMenuW(menu, MF_STRING, STOP, wide("Stop server").as_ptr());
                    let mut point = POINT::default();
                    GetCursorPos(&mut point);
                    SetForegroundWindow(window);
                    TrackPopupMenu(menu, TPM_RIGHTBUTTON, point.x, point.y, 0, window, std::ptr::null());
                    DestroyMenu(menu);
                    PostMessageW(window, WM_NULL, 0, 0);
                    0
                }
                WM_COMMAND if wparam & 0xffff == STOP => { crate::server_process::stop(); 0 }
                WM_CLOSE => { DestroyWindow(window); 0 }
                WM_DESTROY => { PostQuitMessage(0); 0 }
                _ => DefWindowProcW(window, message, wparam, lparam),
            }
        }
    }

    pub fn run() -> Result<(), std::io::Error> {
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            TASKBAR_CREATED.store(RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()), Ordering::Release);
            let class = wide("AmbraServerTray");
            let window_class = WNDCLASSW { lpfnWndProc: Some(window_proc), hInstance: instance, lpszClassName: class.as_ptr(), ..std::mem::zeroed() };
            if RegisterClassW(&window_class) == 0 { return Err(std::io::Error::last_os_error()); }
            // An invisible native window receives tray events. It never creates a taskbar window.
            let window = CreateWindowExW(0, class.as_ptr(), wide("Ambra Server").as_ptr(), 0, 0, 0, 0, 0,
                std::ptr::null_mut(), std::ptr::null_mut(), instance, std::ptr::null());
            if window.is_null() { return Err(std::io::Error::last_os_error()); }
            WINDOW.store(window as usize, Ordering::Release);
            if QUITTING.load(Ordering::Acquire) { DestroyWindow(window); return Ok(()); }
            let ico = include_bytes!("../../desktop/src-tauri/icons/winIcon.ico");
            let offset = u32::from_le_bytes(ico[18..22].try_into().unwrap()) as usize;
            let length = u32::from_le_bytes(ico[14..18].try_into().unwrap()) as usize;
            let icon = CreateIconFromResourceEx(ico[offset..offset + length].as_ptr(), length as u32, 1, 0x0003_0000, 32, 32, LR_DEFAULTCOLOR);
            let mut data = NOTIFYICONDATAW { cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32, hWnd: window, uID: 1,
                uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP, uCallbackMessage: TRAY_MESSAGE, hIcon: icon, ..std::mem::zeroed() };
            let tip = wide("Ambra Server — Running");
            data.szTip[..tip.len()].copy_from_slice(&tip);
            SetWindowLongPtrW(window, GWLP_USERDATA, (&data as *const NOTIFYICONDATAW) as isize);
            if Shell_NotifyIconW(NIM_ADD, &data) == 0 { DestroyWindow(window); return Err(std::io::Error::last_os_error()); }
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            Shell_NotifyIconW(NIM_DELETE, &data);
            if !icon.is_null() { DestroyIcon(icon); }
            WINDOW.store(0, Ordering::Release);
            Ok(())
        }
    }

    pub fn quit() {
        QUITTING.store(true, Ordering::Release);
        let window = WINDOW.load(Ordering::Acquire);
        if window != 0 { unsafe { PostMessageW(window as HWND, WM_CLOSE, 0, 0); } }
    }
}

#[cfg(windows)]
pub use windows::{quit, run};
#[cfg(not(windows))]
pub fn run() -> Result<(), std::io::Error> { Ok(()) }
#[cfg(not(windows))]
pub fn quit() {}
