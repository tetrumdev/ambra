//! Keeps the display on while AMBRA is being watched: fullscreen, in the player, playing music.
//! The system's own setting decides again as soon as any of that stops.
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct DisplayWake(Mutex<Option<Assertion>>);

#[tauri::command]
pub fn set_display_wake(wake: State<'_, DisplayWake>, awake: bool) -> Result<(), String> {
    let mut held = wake
        .0
        .lock()
        .map_err(|_| "The display wake state is unavailable".to_owned())?;
    if awake != held.is_some() {
        // Dropping the assertion releases it.
        *held = awake.then(Assertion::acquire).transpose()?;
    }
    Ok(())
}

/// A held request, like OBS's, that the display stay on.
#[cfg(target_os = "windows")]
pub struct Assertion(windows_sys::Win32::Foundation::HANDLE);

// The request handle belongs to the process, not to the thread that created it.
#[cfg(target_os = "windows")]
unsafe impl Send for Assertion {}

#[cfg(target_os = "windows")]
impl Assertion {
    fn acquire() -> Result<Self, String> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::{
                Power::{PowerCreateRequest, PowerRequestDisplayRequired, PowerSetRequest},
                SystemServices::POWER_REQUEST_CONTEXT_VERSION,
                Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0},
            },
        };
        // Shown by `powercfg /requests`.
        let mut reason: Vec<u16> = "AMBRA is playing music fullscreen"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let context = REASON_CONTEXT {
            Version: POWER_REQUEST_CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: reason.as_mut_ptr(),
            },
        };
        unsafe {
            let request = PowerCreateRequest(&context);
            if request.is_null() || request == INVALID_HANDLE_VALUE {
                return Err("Could not ask Windows to keep the display on".to_owned());
            }
            if PowerSetRequest(request, PowerRequestDisplayRequired) == 0 {
                CloseHandle(request);
                return Err("Could not ask Windows to keep the display on".to_owned());
            }
            Ok(Self(request))
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for Assertion {
    fn drop(&mut self) {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Power::{PowerClearRequest, PowerRequestDisplayRequired},
        };
        unsafe {
            PowerClearRequest(self.0, PowerRequestDisplayRequired);
            CloseHandle(self.0);
        }
    }
}

/// An NSProcessInfo activity that turns off idle display sleep.
#[cfg(target_os = "macos")]
pub struct Assertion(cocoa::base::id);

// The activity token is an immutable object that may be ended from any thread.
#[cfg(target_os = "macos")]
unsafe impl Send for Assertion {}

#[cfg(target_os = "macos")]
impl Assertion {
    fn acquire() -> Result<Self, String> {
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSString;
        use objc::{class, msg_send, sel, sel_impl};
        const IDLE_DISPLAY_SLEEP_DISABLED: u64 = 1 << 40;
        const IDLE_SYSTEM_SLEEP_DISABLED: u64 = 1 << 20;
        unsafe {
            let process: id = msg_send![class!(NSProcessInfo), processInfo];
            let reason = NSString::alloc(nil).init_str("AMBRA is playing music fullscreen");
            let options = IDLE_DISPLAY_SLEEP_DISABLED | IDLE_SYSTEM_SLEEP_DISABLED;
            let token: id = msg_send![process, beginActivityWithOptions: options reason: reason];
            let _: () = msg_send![reason, release];
            if token == nil {
                return Err("Could not ask macOS to keep the display on".to_owned());
            }
            let _: id = msg_send![token, retain];
            Ok(Self(token))
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for Assertion {
    fn drop(&mut self) {
        use cocoa::base::id;
        use objc::{class, msg_send, sel, sel_impl};
        unsafe {
            let process: id = msg_send![class!(NSProcessInfo), processInfo];
            let _: () = msg_send![process, endActivity: self.0];
            let _: () = msg_send![self.0, release];
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub struct Assertion;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl Assertion {
    fn acquire() -> Result<Self, String> {
        Ok(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::Assertion;

    #[test]
    fn the_display_request_can_be_held_and_released_repeatedly() {
        for _ in 0..3 {
            let held = Assertion::acquire().unwrap();
            drop(held);
        }
    }
}
