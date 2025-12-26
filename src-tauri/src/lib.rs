// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs, path::PathBuf};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Emitter,
    Manager,
    State,
};

#[derive(Default)]
struct PythonRuntimeState {
    inner: Arc<Mutex<PythonRuntimeInner>>,
}

#[derive(Default)]
struct PythonRuntimeInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

#[derive(serde::Deserialize)]
struct ChatGeneratePayload {
    model: String,
    prompt: String,
    max_new_tokens: Option<u32>,
    temperature: Option<f32>,
}

#[derive(serde::Serialize)]
struct ChatGenerateStarted {
    generation_id: String,
}

#[derive(serde::Deserialize)]
struct ModelDownloadPayload {
    repo_id: String,
    revision: Option<String>,
    token: Option<String>,
}

#[derive(serde::Serialize)]
struct ModelDownloadStarted {
    download_id: String,
    local_dir: String,
}

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

fn resolve_runner_script_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // In dev, use the repo path; in bundled apps, use resource_dir.
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("py/cerebro_runner.py");
    if dev_path.exists() {
        return Ok(dev_path);
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;
    Ok(resource_dir.join("py/cerebro_runner.py"))
}

fn generate_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("gen-{now}-{}", rand_suffix())
}

fn rand_suffix() -> String {
    // Keep it dependency-free.
    let n = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos()) as u64;
    format!("{:x}", n)
}

fn ensure_python_runtime(app: &tauri::AppHandle, state: &PythonRuntimeState) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Python runtime mutex poisoned".to_string())?;

    if inner.child.is_some() && inner.stdin.is_some() {
        return Ok(());
    }

    let script_path = resolve_runner_script_path(app)?;
    if !script_path.exists() {
        return Err(format!(
            "Python runner not found at {}",
            script_path.display()
        ));
    }

    let mut child = Command::new("python3")
        .arg("-u")
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start python3 runner: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open runner stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open runner stdout".to_string())?;

    // Spawn a blocking reader thread that emits events.
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            
            eprintln!("Runner output: {}", line);

            let parsed: Result<serde_json::Value, _> = serde_json::from_str(&line);
            let Ok(v) = parsed else {
                let _ = app_handle.emit(
                    "cerebro:chat_error",
                    serde_json::json!({
                      "generation_id": null,
                      "message": "Invalid runner JSON"
                    }),
                );
                continue;
            };

            let msg_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
            match msg_type {
                "chat_token" => {
                    let _ = app_handle.emit("cerebro:chat_token", v);
                }
                "done" => {
                    let _ = app_handle.emit("cerebro:chat_done", v);
                }
                "error" => {
                    let _ = app_handle.emit("cerebro:chat_error", v);
                }
                "download_started" => {
                    let _ = app_handle.emit("cerebro:model_download_started", v);
                }
                "download_progress" => {
                    let _ = app_handle.emit("cerebro:model_download_progress", v);
                }
                "download_done" => {
                    let _ = app_handle.emit("cerebro:model_download_done", v);
                }
                "download_error" => {
                    let _ = app_handle.emit("cerebro:model_download_error", v);
                }
                _ => {
                    // ready/shutdown/unknown: ignore for now
                }
            }
        }
    });

    inner.child = Some(child);
    inner.stdin = Some(stdin);
    Ok(())
}

fn sanitize_dir_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.';
        out.push(if ok { ch } else { '_' });
    }
    if out.is_empty() {
        "model".to_string()
    } else {
        out
    }
}

fn compute_model_local_dir(app: &tauri::AppHandle, repo_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app_data_dir: {e}"))?;

    let models_dir = base.join("models");
    fs::create_dir_all(&models_dir)
        .map_err(|e| format!("Failed to create models dir: {e}"))?;

    Ok(models_dir.join(sanitize_dir_component(repo_id)))
}

#[tauri::command]
fn python_runtime_start(app: tauri::AppHandle, state: State<PythonRuntimeState>) -> Result<(), String> {
    ensure_python_runtime(&app, &state)
}

#[tauri::command]
fn python_runtime_stop(state: State<PythonRuntimeState>) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Python runtime mutex poisoned".to_string())?;

    if let Some(mut stdin) = inner.stdin.take() {
        let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n");
        let _ = stdin.flush();
    }

    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
fn chat_generate(
    app: tauri::AppHandle,
    state: State<PythonRuntimeState>,
    payload: ChatGeneratePayload,
) -> Result<ChatGenerateStarted, String> {
    ensure_python_runtime(&app, &state)?;

    // Always load from the previously downloaded local directory.
    // The UI passes the model as a Hugging Face repo id; we map it to our
    // app_data_dir/models/<sanitized_repo_id> location.
    let model_local_dir = compute_model_local_dir(&app, &payload.model)?;
    let model_local_dir_str = model_local_dir.to_string_lossy().to_string();

    let has_any_files = fs::read_dir(&model_local_dir)
        .ok()
        .and_then(|mut it| it.next())
        .is_some();
    if !has_any_files {
        return Err(format!(
            "Model is not available locally. Download it first. Expected dir: {}",
            model_local_dir_str
        ));
    }

    let generation_id = generate_id();
    let msg = serde_json::json!({
        "type": "generate",
        "generation_id": generation_id,
        "model": model_local_dir_str,
        "prompt": payload.prompt,
        "max_new_tokens": payload.max_new_tokens.unwrap_or(256),
        "temperature": payload.temperature.unwrap_or(0.2),
    });

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Python runtime mutex poisoned".to_string())?;
    let Some(stdin) = inner.stdin.as_mut() else {
        return Err("Python runtime is not running".to_string());
    };

    let line = serde_json::to_string(&msg).map_err(|e| format!("Serialize error: {e}"))?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Failed to write to python runner: {e}"))?;

    Ok(ChatGenerateStarted { generation_id })
}

#[tauri::command]
fn chat_cancel(state: State<PythonRuntimeState>, generation_id: String) -> Result<(), String> {

    print!("Requesting cancel for generation_id={generation_id}\n");

    let msg = serde_json::json!({
        "type": "cancel",
        "generation_id": generation_id,
    });

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Python runtime mutex poisoned".to_string())?;
    let Some(stdin) = inner.stdin.as_mut() else {
        return Ok(());
    };

    let line = serde_json::to_string(&msg).map_err(|e| format!("Serialize error: {e}"))?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Failed to write cancel to python runner: {e}"))?;
    Ok(())
}

#[tauri::command]
fn model_download_start(
    app: tauri::AppHandle,
    state: State<PythonRuntimeState>,
    payload: ModelDownloadPayload,
) -> Result<ModelDownloadStarted, String> {
    ensure_python_runtime(&app, &state)?;

    let download_id = generate_id();
    let local_dir = compute_model_local_dir(&app, &payload.repo_id)?;
    let local_dir_str = local_dir.to_string_lossy().to_string();

    let msg = serde_json::json!({
        "type": "download",
        "download_id": download_id,
        "repo_id": payload.repo_id,
        "revision": payload.revision,
        "local_dir": local_dir_str,
        "token": payload.token,
    });

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Python runtime mutex poisoned".to_string())?;
    let Some(stdin) = inner.stdin.as_mut() else {
        return Err("Python runtime is not running".to_string());
    };

    let line = serde_json::to_string(&msg).map_err(|e| format!("Serialize error: {e}"))?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Failed to write download to python runner: {e}"))?;

    Ok(ModelDownloadStarted {
        download_id,
        local_dir: local_dir_str,
    })
}

#[tauri::command]
fn model_download_cancel(
    state: State<PythonRuntimeState>,
    download_id: String,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "download_cancel",
        "download_id": download_id,
    });

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Python runtime mutex poisoned".to_string())?;
    let Some(stdin) = inner.stdin.as_mut() else {
        return Ok(());
    };

    let line = serde_json::to_string(&msg).map_err(|e| format!("Serialize error: {e}"))?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Failed to write download_cancel to python runner: {e}"))?;
    Ok(())
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
        .manage(PythonRuntimeState::default())
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

            let tray_image = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))?;

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
        .invoke_handler(tauri::generate_handler![
            greet,
            http_request,
            python_runtime_start,
            python_runtime_stop,
            chat_generate,
            chat_cancel,
            model_download_start,
            model_download_cancel
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }

            // Comportamento de "dropdown": clicou fora/perdeu foco, esconde.
            //Comentar para debugging
            if let tauri::WindowEvent::Focused(false) = event {
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
