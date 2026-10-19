//! TS for the cash-desk PC and the hall mini-PC: the club interface (apps/web, served by the
//! HUB) in a native window, plus what a browser cannot do — silent receipt printing, a kiosk,
//! autostart, HUB discovery, installing the HUB on this PC and self-updates.
//!
//! The window starts on the local page `ui/index.html` (setup and device settings) and then
//! navigates to the HUB origin. Ctrl+Shift+S on any page comes back to the settings.

mod hub;
mod print;
mod settings;

use settings::Settings;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_updater::UpdaterExt;

const MAIN: &str = "main";

/// Injected into every page, the HUB pages included.
const INIT_SCRIPT: &str = r#"
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') {
    e.preventDefault();
    window.__TAURI__?.core?.invoke('open_settings');
  }
}, true);
"#;

struct AppState {
  settings: Mutex<Settings>,
  /// Origin the window may navigate to besides the local pages.
  hub_origin: Arc<Mutex<Option<String>>>,
  /// A manager key was entered since the settings were opened (kiosk only).
  unlocked: AtomicBool,
}

impl AppState {
  fn settings(&self) -> Settings {
    self.settings.lock().unwrap().clone()
  }

  /// In kiosk mode changes need a manager key; outside it anyone at the PC may change settings.
  fn ensure_unlocked(&self) -> Result<(), String> {
    if self.settings().kiosk && !self.unlocked.load(Ordering::SeqCst) {
      Err("Нужен ключ управляющего".into())
    } else {
      Ok(())
    }
  }
}

fn local_url(fragment: &str) -> String {
  let base = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
  format!("{base}#{fragment}")
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
  app.get_webview_window(MAIN).ok_or_else(|| "Нет окна".into())
}

fn navigate(window: &WebviewWindow, to: &str) -> Result<(), String> {
  let url = to.parse().map_err(|_| format!("Неверный адрес: {to}"))?;
  window.navigate(url).map_err(|e| e.to_string())
}

fn apply_kiosk(window: &WebviewWindow, kiosk: bool) {
  let _ = window.set_decorations(!kiosk);
  let _ = window.set_fullscreen(kiosk);
  let _ = window.set_minimizable(!kiosk);
  keep_awake(kiosk);
}

/// Keeps the screen on in kiosk mode. The UI thread lives as long as the app, so the state holds.
fn keep_awake(on: bool) {
  #[cfg(windows)]
  unsafe {
    use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
    let flags = if on { ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
    SetThreadExecutionState(flags);
  }
  #[cfg(not(windows))]
  let _ = on;
}

// ── Commands of the local page ──────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceState {
  settings: Settings,
  version: String,
  platform: &'static str,
  locked: bool,
}

#[tauri::command]
fn get_state(app: AppHandle, state: State<'_, AppState>) -> DeviceState {
  let settings = state.settings();
  let locked = settings.kiosk && !state.unlocked.load(Ordering::SeqCst);
  DeviceState {
    settings,
    version: app.package_info().version.to_string(),
    platform: std::env::consts::OS,
    locked,
  }
}

#[tauri::command]
async fn discover() -> Vec<String> {
  hub::discover().await
}

/// Checks the address, remembers it and opens the HUB. `address` None — the saved one.
#[tauri::command]
async fn connect(app: AppHandle, state: State<'_, AppState>, address: Option<String>) -> Result<String, String> {
  let saved = state.settings().hub_url;
  let origin = match address.as_deref().or(saved.as_deref()) {
    Some(a) => hub::normalize(a)?,
    None => return Err("HUB ещё не выбран".into()),
  };
  if saved.is_some() && saved.as_deref() != Some(origin.as_str()) {
    state.ensure_unlocked()?;
  }
  if !hub::probe(&origin, Duration::from_secs(4)).await {
    return Err(format!("HUB не отвечает: {origin}"));
  }
  {
    let mut s = state.settings.lock().unwrap();
    if s.hub_url.as_deref() != Some(origin.as_str()) {
      s.hub_url = Some(origin.clone());
      settings::save(&app, &s)?;
    }
  }
  *state.hub_origin.lock().unwrap() = Some(origin.clone());
  state.unlocked.store(false, Ordering::SeqCst);
  navigate(&main_window(&app)?, &format!("{origin}/"))?;
  Ok(origin)
}

#[tauri::command]
async fn unlock(state: State<'_, AppState>, key: String) -> Result<(), String> {
  let origin = state.settings().hub_url.ok_or("HUB ещё не выбран")?;
  hub::verify_manager(&origin, &key).await?;
  state.unlocked.store(true, Ordering::SeqCst);
  Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePatch {
  kiosk: Option<bool>,
  printer: Option<String>,
  autostart: Option<bool>,
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, patch: DevicePatch) -> Result<Settings, String> {
  state.ensure_unlocked()?;
  let mut s = state.settings.lock().unwrap();
  if let Some(autostart) = patch.autostart {
    let launcher = app.autolaunch();
    let result = if autostart { launcher.enable() } else { launcher.disable() };
    result.map_err(|e| format!("Автозапуск: {e}"))?;
    s.autostart = autostart;
  }
  if let Some(printer) = patch.printer {
    s.printer = printer.trim().to_string();
  }
  if let Some(kiosk) = patch.kiosk {
    s.kiosk = kiosk;
    apply_kiosk(&main_window(&app)?, kiosk);
  }
  settings::save(&app, &s)?;
  Ok(s.clone())
}

#[tauri::command]
async fn list_printers() -> Vec<String> {
  tauri::async_runtime::spawn_blocking(|| {
    #[cfg(windows)]
    let output = {
      use std::os::windows::process::CommandExt;
      const CREATE_NO_WINDOW: u32 = 0x0800_0000;
      std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Printer | ForEach-Object Name"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    };
    #[cfg(not(windows))]
    let output = std::process::Command::new("lpstat").arg("-e").output();
    output
      .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
      .unwrap_or_default()
  })
  .await
  .unwrap_or_default()
}

#[tauri::command]
fn quit(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
  state.ensure_unlocked()?;
  app.exit(0);
  Ok(())
}

/// Runs the HUB installer from deploy/ (bundled with the app) as administrator and waits for it.
#[tauri::command]
async fn install_hub(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
  state.ensure_unlocked()?;
  let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
  tauri::async_runtime::spawn_blocking(move || {
    #[cfg(windows)]
    {
      let script = resources.join("deploy").join("windows").join("install.ps1");
      // UAC prompt; the installer shows its progress in its own console window.
      let elevate = format!(
        "$p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"{}\"'; exit $p.ExitCode",
        script.display()
      );
      let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &elevate])
        .status()
        .map_err(|e| e.to_string())?;
      if status.success() {
        Ok("HUB установлен как служба (задача «billS HUB»)".to_string())
      } else {
        Err("Установка HUB не завершилась — журнал: C:\\bills\\logs\\install.log".to_string())
      }
    }
    #[cfg(not(windows))]
    {
      let script = resources.join("deploy").join("linux").join("install.sh");
      let output = std::process::Command::new("pkexec")
        .arg("bash")
        .arg(&script)
        .output()
        .map_err(|e| format!("pkexec: {e}"))?;
      if output.status.success() {
        Ok("HUB установлен как служба (bills-hub.service)".to_string())
      } else {
        let log = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = log.lines().rev().take(5).collect();
        Err(format!("Установка HUB не завершилась: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" / ")))
      }
    }
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
  let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
  Ok(update.map(|u| u.version))
}

#[tauri::command]
async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
  state.ensure_unlocked()?;
  let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
  let Some(update) = update else {
    return Err("Обновлений нет".into());
  };
  update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
  app.restart();
}

// ── Commands the HUB pages may call (see capabilities/hub.json) ─────────────

#[tauri::command]
fn open_settings(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
  state.unlocked.store(false, Ordering::SeqCst);
  navigate(&main_window(&app)?, &local_url("settings"))
}

#[tauri::command]
async fn print_receipt(window: WebviewWindow, state: State<'_, AppState>, page: print::Page) -> Result<(), String> {
  let printer = state.settings().printer;
  print::print(&window, page, printer).await
}

// ── App ─────────────────────────────────────────────────────────────────────

fn is_local(url: &url::Url) -> bool {
  url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") || url.scheme() == "about"
}

pub fn run() {
  // reqwest is built with rustls but no crypto provider (feature of the updater); pick the same one.
  let _ = rustls::crypto::ring::default_provider().install_default();
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _, _| {
      if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.set_focus();
      }
    }))
    .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
    .plugin(tauri_plugin_updater::Builder::new().build())
    .setup(|app| {
      let handle = app.handle().clone();
      let settings = settings::load(&handle);
      let kiosk = settings.kiosk;
      let hub_origin = Arc::new(Mutex::new(None::<String>));
      app.manage(AppState { settings: Mutex::new(settings), hub_origin: hub_origin.clone(), unlocked: AtomicBool::new(false) });

      let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("TS")
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .initialization_script(INIT_SCRIPT)
        // Only the local pages and the chosen HUB: a stray link must not leave the kiosk.
        .on_navigation(move |url| {
          is_local(url) || hub_origin.lock().unwrap().as_deref() == Some(url.origin().ascii_serialization().as_str())
        })
        .build()?;
      apply_kiosk(&window, kiosk);
      Ok(())
    })
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        let state = window.state::<AppState>();
        if state.ensure_unlocked().is_err() {
          api.prevent_close();
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      get_state,
      discover,
      connect,
      unlock,
      save_settings,
      list_printers,
      quit,
      install_hub,
      check_update,
      install_update,
      open_settings,
      print_receipt,
    ])
    .run(tauri::generate_context!())
    .expect("error while running TS");
}
