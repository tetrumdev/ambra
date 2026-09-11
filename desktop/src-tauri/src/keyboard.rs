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
