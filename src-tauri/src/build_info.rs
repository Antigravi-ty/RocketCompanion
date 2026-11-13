pub const APP_DISPLAY_NAME: &str = "Rocket Companion";
pub const MAIN_WINDOW_BASE_TITLE: &str = "Rocket Companion";
pub const CONFIGURATOR_WINDOW_BASE_TITLE: &str = "Rocket Companion — Launch Configurator";

pub fn short_commit_id() -> &'static str {
    match option_env!("RC_GIT_COMMIT_SHORT") {
        Some(id) if !id.is_empty() => id,
        _ => "dev",
    }
}

#[allow(dead_code)]
pub fn full_commit_id() -> &'static str {
    match option_env!("RC_GIT_COMMIT_FULL") {
        Some(id) if !id.is_empty() => id,
        _ => short_commit_id(),
    }
}

#[allow(dead_code)]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn format_window_title(base_title: &str) -> String {
    format!("{} ({})", base_title, short_commit_id())
}

pub fn format_tray_launch_label() -> String {
    format!("Launch ({})", short_commit_id())
}

pub fn format_tray_tooltip() -> String {
    format!("{} ({})", APP_DISPLAY_NAME, short_commit_id())
}
