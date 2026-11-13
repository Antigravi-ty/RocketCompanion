pub mod app_icon;
pub mod app_menu;
pub mod build_info;
pub mod config_store;
pub mod tray_manager;
pub mod window_manager;

use app_icon::{apply_app_and_window_icons, ensure_macos_dock_icon};
use app_menu::setup_app_menu;
use config_store::load_launch_state;
use tauri::{Manager, WindowEvent};
use tray_manager::setup_system_tray;
use window_manager::{
    apply_window_titles, launch_main_window_with_config, open_configurator_window,
    tauri_get_display_diagnostics, tauri_get_launch_state, tauri_launch_game,
    tauri_open_configurator, tauri_open_vault_folder, tauri_open_workspace_folder,
    tauri_reset_launch_config, tauri_save_launch_config, tauri_set_display_window_mode,
    update_macos_activation_policy,
};

fn should_start_tray_only_from_env() -> bool {
    if std::env::var("RC_TRAY_ONLY")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        return true;
    }
    std::env::args().any(|arg| arg == "--tray-only" || arg == "--silent-tray")
}

fn should_force_configurator_from_args() -> bool {
    std::env::args().any(|arg| arg == "--configurator" || arg == "--configure")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_macos_fps::init())
        .invoke_handler(tauri::generate_handler![
            tauri_get_launch_state,
            tauri_save_launch_config,
            tauri_launch_game,
            tauri_reset_launch_config,
            tauri_open_configurator,
            tauri_set_display_window_mode,
            tauri_open_workspace_folder,
            tauri_open_vault_folder,
            tauri_get_display_diagnostics,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Prevent window destruction and process exit; close to tray
                api.prevent_close();
                let _ = window.hide();
                let label = window.label();
                let app_handle = window.app_handle();
                update_macos_activation_policy(app_handle, Some(label));
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = app.handle();
            setup_app_menu(handle)?;
            apply_app_and_window_icons(handle);
            apply_window_titles(handle);
            setup_system_tray(handle)?;

            let state = load_launch_state(handle);
            let tray_only = should_start_tray_only_from_env() || state.config.tray_only_mode;
            let force_cfg = should_force_configurator_from_args();

            if tray_only && !force_cfg {
                log::info!(
                    "[RocketCompanion] Started in silent tray-only mode. Use the Crossbar tray icon to Launch or open Configurator."
                );
            } else if !force_cfg
                && state.has_valid_default
                && !state.config.launch_configurator_every_time
            {
                let _ = launch_main_window_with_config(handle, &state.config);
            } else {
                if let Some(cfg_win) = handle.get_webview_window("configurator") {
                    let _ = cfg_win.center();
                }
                let _ = open_configurator_window(handle);
            }

            update_macos_activation_policy(handle, None);

            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                let main_win = app_handle.get_webview_window("main");
                let cfg_win = app_handle.get_webview_window("configurator");
                let main_visible = main_win.as_ref().and_then(|w| w.is_visible().ok()).unwrap_or(false);
                let cfg_visible = cfg_win.as_ref().and_then(|w| w.is_visible().ok()).unwrap_or(false);

                if main_visible {
                    #[cfg(target_os = "macos")]
                    let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Regular);
                    ensure_macos_dock_icon();
                    if let Some(main) = main_win {
                        let _ = main.unminimize();
                        let _ = main.set_focus();
                    }
                } else if cfg_visible {
                    #[cfg(target_os = "macos")]
                    let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Regular);
                    ensure_macos_dock_icon();
                    if let Some(cfg) = cfg_win {
                        let _ = cfg.unminimize();
                        let _ = cfg.set_focus();
                    }
                } else if !has_visible_windows {
                    let state = load_launch_state(app_handle);
                    if state.has_valid_default && !state.config.launch_configurator_every_time {
                        let _ = launch_main_window_with_config(app_handle, &state.config);
                    } else {
                        let _ = open_configurator_window(app_handle);
                    }
                }
            }
            _ => {}
        }
    });
}
