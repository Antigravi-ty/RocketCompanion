use tauri::AppHandle;

#[cfg(target_os = "macos")]
pub fn setup_app_menu(app: &AppHandle) -> tauri::Result<()> {
    use crate::app_icon::app_window_icon;
    use crate::build_info::{
        app_version, full_commit_id, short_commit_id, APP_DISPLAY_NAME,
    };
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};

    let about_metadata = AboutMetadata {
        name: Some(APP_DISPLAY_NAME.to_string()),
        short_version: Some(format!("v{}", app_version())),
        version: Some(short_commit_id().to_string()),
        comments: Some(format!("Build Commit: {}", full_commit_id())),
        icon: Some(app_window_icon()),
        ..Default::default()
    };

    let app_submenu = Submenu::with_items(
        app,
        APP_DISPLAY_NAME,
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some("About Rocket Companion"),
                Some(about_metadata),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Hide Rocket Companion"))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit Rocket Companion"))?,
        ],
    )?;

    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_submenu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_submenu, &edit_submenu, &window_submenu])?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn setup_app_menu(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}
