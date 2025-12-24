// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::collections::HashMap;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[derive(serde::Deserialize)]
struct HttpRequestPayload {
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
}

#[derive(serde::Serialize)]
struct HttpResponsePayload {
    status: u16,
    status_text: String,
    body_text: String,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn http_request(request: HttpRequestPayload) -> Result<HttpResponsePayload, String> {
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "Invalid HTTP method".to_string())?;

    let client = reqwest::Client::new();
    let mut builder = client.request(method.clone(), request.url);

    if let Some(headers) = request.headers {
        for (k, v) in headers {
            if k.trim().is_empty() {
                continue;
            }
            builder = builder.header(k, v);
        }
    }

    // Avoid sending body on GET/HEAD.
    if method != reqwest::Method::GET && method != reqwest::Method::HEAD {
        if let Some(body) = request.body {
            if !body.is_empty() {
                builder = builder.body(body);
            }
        }
    }

    let res = builder
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = res.status();
    let status_text = status
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let body_text = res
        .text()
        .await
        .map_err(|e| format!("Failed reading response body: {e}"))?;

    Ok(HttpResponsePayload {
        status: status.as_u16(),
        status_text,
        body_text,
    })
}

fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let is_visible = window.is_visible().unwrap_or(false);
    if is_visible {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_dropdown_at(
    app: &tauri::AppHandle,
    rect: tauri::Rect,
    click_pos: tauri::PhysicalPosition<f64>,
) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let window_size = window.outer_size().ok();
    let monitor = window.current_monitor().ok().flatten();

    const EDGE_GAP_PX: f64 = 20.0;

    let (rect_x, rect_y) = match rect.position {
        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
        tauri::Position::Logical(p) => (p.x, p.y),
    };
    let (rect_w, rect_h) = match rect.size {
        tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
        tauri::Size::Logical(s) => (s.width, s.height),
    };

    // Default anchor point: below the tray icon.
    let mut x = rect_x;
    let mut y = rect_y + rect_h;

    let (show_above, scale_factor) = if let Some(monitor) = &monitor {
        let monitor_size = monitor.size();
        (
            click_pos.y > (monitor_size.height as f64 / 2.0),
            monitor.scale_factor(),
        )
    } else {
        (false, 1.0)
    };

    // Convert the desired pixel gap to the coordinate space we'll use.
    let gap = match rect.position {
        tauri::Position::Physical(_) => EDGE_GAP_PX,
        tauri::Position::Logical(_) => EDGE_GAP_PX / scale_factor,
    };

    if let (Some(window_size), Some(monitor)) = (window_size, monitor) {
        let monitor_size = monitor.size();
        let window_w = window_size.width as f64;
        let window_h = window_size.height as f64;

        // If click is in lower half of the screen, show above (Windows taskbar scenario).
        if show_above {
            y = rect_y - window_h;
        }

        // If click is in right half, align right edge of window with tray rect.
        if click_pos.x > (monitor_size.width as f64 / 2.0) {
            x = (rect_x + rect_w - (window_w / 2.0) - 10.0).max(0.0);
        }
    }

    // Apply a small gap so the popover isn't glued to the tray/menu bar.
    if show_above {
        y -= gap;
    } else {
        y += gap;
    }

    let _ = match rect.position {
        tauri::Position::Physical(_) => {
            window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: x.round() as i32,
                y: y.round() as i32,
            }))
        }
        tauri::Position::Logical(_) => {
            window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
        }
    };
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    let _ = window.set_theme(Some(tauri::Theme::Dark));
                    let _ = window_vibrancy::apply_vibrancy(
                        &window,
                        window_vibrancy::NSVisualEffectMaterial::HudWindow,
                        Some(window_vibrancy::NSVisualEffectState::Active),
                        Some(36.0),
                    );
                }
                let _ = window.set_skip_taskbar(true);
                let _ = window.hide();
            }

            let show_hide =
                MenuItem::with_id(app, "show_hide", "Show/Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_hide, &quit])?;

            let tray_image = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

            TrayIconBuilder::new()
                .menu(&menu)
                .icon(tray_image)
                // Queremos clique-esquerdo abrir o dropdown (não o menu).
                .show_menu_on_left_click(false)
                .on_menu_event(
                    |app, event: tauri::menu::MenuEvent| match event.id().as_ref() {
                        "show_hide" => toggle_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    },
                )
                .on_tray_icon_event(|tray: &TrayIcon, event: TrayIconEvent| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        position,
                        ..
                    } = event
                    {
                        println!("LK: Tray icon left click detected, showing dropdown.");

                        let Some(window) = tray.app_handle().get_webview_window("main") else {
                            return;
                        };

                        let is_visible = window.is_visible().unwrap_or(false);

                        if is_visible {
                            let _ = window.hide();
                            return;
                        }

                        show_dropdown_at(tray.app_handle(), rect, position);
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, http_request])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }

            // Comportamento de "dropdown": clicou fora/perdeu foco, esconde.
            //Comentar para debugging
            // if let tauri::WindowEvent::Focused(false) = event {
            //     let _ = window.hide();
            // }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
