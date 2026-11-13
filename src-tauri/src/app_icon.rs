use tauri::image::Image;
use tauri::AppHandle;

#[cfg(target_os = "macos")]
const APP_ICON_PNG_BYTES: &[u8] = include_bytes!("../icons/128x128@2x.png");

pub fn app_window_icon() -> Image<'static> {
    tauri::include_image!("icons/128x128@2x.png")
}

/// Ensures the macOS NSApplication Dock / Cmd+Tab / About icon uses the Crossbar #1 icon.
/// This prevents macOS from falling back to the generic Unix executable icon when running
/// unbundled (`tauri dev`) or when transitioning between `ActivationPolicy::Accessory` and `Regular`.
#[cfg(target_os = "macos")]
pub fn ensure_macos_dock_icon() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ffi::c_void;

    unsafe {
        let data: *mut AnyObject = msg_send![
            class!(NSData),
            dataWithBytes: APP_ICON_PNG_BYTES.as_ptr() as *const c_void,
            length: APP_ICON_PNG_BYTES.len()
        ];
        if data.is_null() {
            return;
        }

        let ns_image_alloc: *mut AnyObject = msg_send![class!(NSImage), alloc];
        let ns_image: *mut AnyObject = msg_send![ns_image_alloc, initWithData: data];
        if ns_image.is_null() {
            return;
        }

        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if !ns_app.is_null() {
            let _: () = msg_send![ns_app, setApplicationIconImage: ns_image];
        }

        let _: () = msg_send![ns_image, release];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_macos_dock_icon() {}

/// Applies the Crossbar #1 icon to the application Dock (macOS) and both desktop windows (Windows/Linux).
pub fn apply_app_and_window_icons(app: &AppHandle) {
    ensure_macos_dock_icon();

    #[cfg(not(target_os = "macos"))]
    {
        use tauri::Manager;
        let icon = app_window_icon();
        for label in ["main", "configurator"] {
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.set_icon(icon.clone());
            }
        }
    }

    #[cfg(target_os = "macos")]
    let _ = app;
}
