//! Moving the window from the page's title bar strips.
//!
//! On macOS 27 a drag the app asks for (`performWindowDragWithEvent`, Tauri's `start_dragging`)
//! does not work from a trackpad: the window server turns the request down, or accepts it and
//! then follows neither the pointer nor its release, which leaves keyboard input suppressed, in
//! every app, until another window is clicked. Drags the window server starts itself, in the
//! title bar zone of the window, do work.
//!
//! So there the web view reports that a press may move the window, which puts the whole title
//! bar zone in the region the window server drags, and controls are laid over every part of the
//! zone the page does not offer for dragging, which takes those parts out again. The page says
//! which parts it offers (`set_window_drag_regions`). Earlier systems keep `start_dragging`.

#[cfg(target_os = "macos")]
mod macos {
    use cocoa::{
        base::{id, nil},
        foundation::{NSPoint, NSRect, NSSize, NSUInteger},
    };
    use objc::{
        class,
        declare::ClassDecl,
        msg_send,
        runtime::{class_addMethod, Class, Imp, Object, Sel, BOOL, YES},
        sel, sel_impl,
    };
    use std::sync::{Mutex, OnceLock};

    const VIEW_MIN_Y_MARGIN: NSUInteger = 8;
    const VIEW_MAX_Y_MARGIN: NSUInteger = 32;
    const WINDOW_ABOVE: isize = 1;

    /// A part of the page that moves the window, in the page's pixels from its top left.
    #[derive(Clone, Copy, serde::Deserialize)]
    pub struct Region {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    /// The views that keep the window server from dragging the parts of the zone under them.
    static BLOCKERS: Mutex<Vec<usize>> = Mutex::new(Vec::new());

    #[repr(C)]
    struct OperatingSystemVersion {
        major: isize,
        minor: isize,
        patch: isize,
    }

    /// Whether the window server, not the app, must start the drag.
    pub fn server_starts_drags() -> bool {
        static ANSWER: OnceLock<bool> = OnceLock::new();
        *ANSWER.get_or_init(|| unsafe {
            let process: id = msg_send![class!(NSProcessInfo), processInfo];
            let version: OperatingSystemVersion = msg_send![process, operatingSystemVersion];
            version.major >= 27
        })
    }

    extern "C" fn press_can_move_window(_: &Object, _: Sel) -> BOOL {
        YES
    }

    extern "C" fn pass_presses_through(_: &Object, _: Sel, _: NSPoint) -> id {
        nil
    }

    /// A control counts as an obstacle in the title bar zone; a plain view does not. It takes
    /// no presses itself, so the page under it still gets them.
    fn blocker_class() -> *const Class {
        static CLASS: OnceLock<usize> = OnceLock::new();
        *CLASS.get_or_init(|| {
            let name = "AmbraWindowDragBlocker";
            let class = match ClassDecl::new(name, class!(NSControl)) {
                Some(mut declaration) => {
                    unsafe {
                        declaration.add_method(
                            sel!(hitTest:),
                            pass_presses_through as extern "C" fn(&Object, Sel, NSPoint) -> id,
                        );
                    }
                    declaration.register() as *const Class
                }
                None => Class::get(name).map_or(std::ptr::null(), |class| class as *const Class),
            };
            class as usize
        }) as *const Class
    }

    unsafe fn web_view(window: id) -> id {
        let content: id = unsafe { msg_send![window, contentView] };
        let subviews: id = unsafe { msg_send![content, subviews] };
        let count: NSUInteger = unsafe { msg_send![subviews, count] };
        for index in 0..count {
            let view: id = unsafe { msg_send![subviews, objectAtIndex: index] };
            let is_web_view: BOOL = unsafe { msg_send![view, isKindOfClass: class!(WKWebView)] };
            if is_web_view == YES {
                return view;
            }
        }
        nil
    }

    /// The parts of a `width` by `height` zone that no region covers. Rows are cut wherever a
    /// region starts or ends, so each row is covered the same way over its whole height.
    fn uncovered(regions: &[Region], width: f64, height: f64) -> Vec<Region> {
        let mut edges = vec![0.0, height];
        for region in regions {
            edges.push(region.y.clamp(0.0, height));
            edges.push((region.y + region.height).clamp(0.0, height));
        }
        edges.sort_by(f64::total_cmp);
        edges.dedup();
        let mut gaps = Vec::new();
        for row in edges.windows(2) {
            let (top, bottom) = (row[0], row[1]);
            let mut covering: Vec<(f64, f64)> = regions
                .iter()
                .filter(|region| region.y <= top && region.y + region.height >= bottom)
                .map(|region| (region.x.max(0.0), (region.x + region.width).min(width)))
                .collect();
            covering.sort_by(|a, b| a.0.total_cmp(&b.0));
            covering.push((width, width));
            let mut x = 0.0;
            for (start, end) in covering {
                if start > x {
                    gaps.push(Region { x, y: top, width: start - x, height: bottom - top });
                }
                x = x.max(end);
            }
        }
        gaps
    }

    /// Lays the blockers out again. Runs on the main thread.
    pub unsafe fn apply(window: id, viewport_width: f64, regions: &[Region]) {
        let web_view = unsafe { web_view(window) };
        let Ok(mut blockers) = BLOCKERS.lock() else { return };
        for blocker in blockers.drain(..) {
            let _: () = unsafe { msg_send![blocker as id, removeFromSuperview] };
        }
        if web_view == nil {
            return;
        }
        let parent: id = unsafe { msg_send![web_view, superview] };
        let page: NSRect = unsafe { msg_send![web_view, frame] };
        let frame: NSRect = unsafe { msg_send![window, frame] };
        let below_title_bar: NSRect = unsafe { msg_send![window, contentLayoutRect] };
        // No title bar, as in full screen, leaves no zone and nothing to block.
        let zone = frame.size.height - below_title_bar.size.height;
        let flipped: BOOL = unsafe { msg_send![parent, isFlipped] };
        let flipped = flipped == YES;
        let scale = if viewport_width > 0.0 { page.size.width / viewport_width } else { 1.0 };
        let regions: Vec<Region> = regions
            .iter()
            .map(|region| Region {
                x: region.x * scale,
                y: region.y * scale,
                width: region.width * scale,
                height: region.height * scale,
            })
            .collect();
        for gap in uncovered(&regions, page.size.width, zone.max(0.0)) {
            let y = if flipped {
                page.origin.y + gap.y
            } else {
                page.origin.y + page.size.height - gap.y - gap.height
            };
            let rect = NSRect::new(
                NSPoint::new(page.origin.x + gap.x, y),
                NSSize::new(gap.width, gap.height),
            );
            let blocker: id = unsafe { msg_send![blocker_class(), alloc] };
            let blocker: id = unsafe { msg_send![blocker, initWithFrame: rect] };
            // Stay at the top while the window is resized, until the page reports again.
            let pinned_to_top = if flipped { VIEW_MAX_Y_MARGIN } else { VIEW_MIN_Y_MARGIN };
            let _: () = unsafe { msg_send![blocker, setAutoresizingMask: pinned_to_top] };
            let _: () = unsafe {
                msg_send![parent, addSubview: blocker positioned: WINDOW_ABOVE relativeTo: web_view]
            };
            let _: () = unsafe { msg_send![blocker, release] };
            blockers.push(blocker as usize);
        }
        unsafe { refresh(web_view) };
    }

    /// Has AppKit work the dragged region out again. It does so only when a view joins or
    /// leaves the window: not when one moves, and not when the web view starts to report
    /// differently. Runs on the main thread.
    unsafe fn refresh(web_view: id) {
        let parent: id = unsafe { msg_send![web_view, superview] };
        let page: NSRect = unsafe { msg_send![web_view, frame] };
        let nudge: id = unsafe { msg_send![class!(NSView), alloc] };
        let nudge: id = unsafe { msg_send![nudge, initWithFrame: page] };
        let _: () = unsafe { msg_send![parent, addSubview: nudge] };
        let _: () = unsafe { msg_send![nudge, removeFromSuperview] };
        let _: () = unsafe { msg_send![nudge, release] };
    }

    pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
        use tauri::Manager;

        if !server_starts_drags() {
            return Ok(());
        }
        let window = app.get_webview_window("main").ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "main window not found")
        })?;
        let native_window = window.ns_window()? as id;
        unsafe {
            let web_view = web_view(native_window);
            if web_view == nil {
                return Err(std::io::Error::other("Could not find the web view").into());
            }
            // The web view's class answers no; nothing in it or below it overrides that.
            let class: *const Class = msg_send![web_view, class];
            let answer: extern "C" fn(&Object, Sel) -> BOOL = press_can_move_window;
            let encoding = if cfg!(target_arch = "aarch64") { c"B@:" } else { c"c@:" };
            class_addMethod(
                class as *mut Class,
                sel!(mouseDownCanMoveWindow),
                std::mem::transmute::<extern "C" fn(&Object, Sel) -> BOOL, Imp>(answer),
                encoding.as_ptr(),
            );
            // Until the page reports, the whole zone moves the window, as a title bar does.
            let whole_zone = Region { x: 0.0, y: 0.0, width: f64::MAX, height: f64::MAX };
            apply(native_window, 0.0, &[whole_zone]);
        }
        // A region worked out before the window is on screen does not always take effect, and
        // the page reports again only when its strips change.
        let target = window.clone();
        window.on_window_event(move |event| {
            if !matches!(event, tauri::WindowEvent::Focused(true) | tauri::WindowEvent::Resized(_)) {
                return;
            }
            let window = target.clone();
            let _ = target.run_on_main_thread(move || {
                if let Ok(native_window) = window.ns_window() {
                    unsafe {
                        let web_view = web_view(native_window as id);
                        if web_view != nil {
                            refresh(web_view);
                        }
                    }
                }
            });
        });
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use macos::setup;

#[cfg(target_os = "macos")]
pub use macos::Region;

#[cfg(not(target_os = "macos"))]
#[derive(serde::Deserialize)]
pub struct Region {}

/// Takes the parts of the page that move the window. Answers whether the window server starts
/// the drags, which is whether the page needs to keep reporting them.
#[tauri::command]
pub fn set_window_drag_regions(
    window: tauri::WebviewWindow,
    viewport_width: f64,
    regions: Vec<Region>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if !macos::server_starts_drags() {
            return Ok(false);
        }
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                if let Ok(native_window) = target.ns_window() {
                    unsafe {
                        macos::apply(native_window as cocoa::base::id, viewport_width, &regions)
                    };
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, viewport_width, regions);
        Ok(false)
    }
}

/// Starts a drag from a press on a drag region, where the app is the one to start it.
#[tauri::command]
pub fn start_window_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if macos::server_starts_drags() {
        return Ok(());
    }
    window.start_dragging().map_err(|error| error.to_string())
}
