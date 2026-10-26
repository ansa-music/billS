//! TS for the cash-desk PC and the hall mini-PC: the club interface (apps/web, served by the
//! HUB) in a native window, plus what a browser cannot do — silent receipt printing, a kiosk,
//! autostart, HUB discovery, running the built-in HUB on this PC (local_hub.rs) and self-updates.
//!
//! `ts-desktop --hub-only` runs only the built-in HUB, without a window; `--open-firewall` asks
//! Windows to let the club network reach it. Both serve the CI smoke test and support.
//!
//! The window starts on the local page `ui/index.html` (setup and device settings) and then
//! navigates to the HUB origin. Ctrl+Shift+S on any page comes back to the settings.

mod hub;
mod install;
mod local_hub;
mod print;
mod settings;

use settings::Settings;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
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
  /// The built-in HUB while this app runs it.
  local_hub: Mutex<Option<local_hub::Supervisor>>,
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
  /// This build carries the built-in HUB (hub-bundle).
  embedded_hub: bool,
  /// The built-in HUB is running under this app now.
  local_hub_running: bool,
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
    embedded_hub: bundle(&app).is_some(),
    local_hub_running: state.local_hub.lock().unwrap().is_some(),
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

/// Installs the HUB on this PC from deploy/ (bundled with the app) as administrator, waits until it
/// answers and returns its local origin for `connect`.
#[tauri::command]
async fn install_hub(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
  state.ensure_unlocked()?;
  let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
  tauri::async_runtime::spawn_blocking(move || install::run(&resources)).await.map_err(|e| e.to_string())??;
  // The installers wait for /api/health themselves; this covers a slow first start of the service.
  let origin = hub::local_origin();
  for _ in 0..30 {
    if hub::probe(&origin, Duration::from_secs(2)).await {
      return Ok(origin);
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
  }
  Err("HUB установлен, но пока не отвечает. Подождите минуту и нажмите «Найти HUB ещё раз».".into())
}

// ── The built-in HUB (local_hub.rs) ────────────────────────────────────────

fn bundle(app: &AppHandle) -> Option<local_hub::Bundle> {
  local_hub::find(app.path().resource_dir().ok().as_deref())
}

const NO_BUNDLE: &str = "В этой версии TS нет встроенного HUB. Скачайте установщик TS заново на странице «Скачать \
                         приложение» или установите HUB как службу: Настройки → Обслуживание.";

/// Starts the built-in HUB under this app unless it already runs (here or as a service).
fn ensure_local_hub(app: &AppHandle) -> Result<(), String> {
  let state = app.state::<AppState>();
  let mut slot = state.local_hub.lock().unwrap();
  if slot.is_some() || local_hub::answers(Duration::from_secs(2)) {
    return Ok(());
  }
  let bundle = bundle(app).ok_or(NO_BUNDLE)?;
  *slot = Some(local_hub::Supervisor::start(bundle, local_hub::data_dir()?)?);
  Ok(())
}

fn stop_local_hub_now(app: &AppHandle) {
  let supervisor = app.state::<AppState>().local_hub.lock().unwrap().take();
  if let Some(mut s) = supervisor {
    s.stop();
  }
}

/// «This is the club's main computer»: opens the firewall for the club network (one UAC prompt on
/// Windows, skipped when declined), starts the built-in HUB, remembers the choice and turns on
/// autostart so the HUB is back after a reboot. Returns the local origin for `connect`.
#[tauri::command]
async fn start_local_hub(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
  state.ensure_unlocked()?;
  let origin = hub::local_origin();
  // A HUB already answers on this PC (installed as a service, started earlier): use it as is.
  if hub::probe(&origin, Duration::from_secs(2)).await {
    return Ok(origin);
  }
  let bundle = bundle(&app).ok_or(NO_BUNDLE)?;
  if !state.settings().firewall_done {
    let b = bundle.clone();
    match tauri::async_runtime::spawn_blocking(move || local_hub::open_firewall(&b)).await.map_err(|e| e.to_string())? {
      Ok(true) => {
        let mut s = state.settings.lock().unwrap();
        s.firewall_done = true;
        settings::save(&app, &s)?;
      }
      Ok(false) => eprintln!("[TS] брандмауэр: разрешение не дано — HUB доступен только с этого компьютера"),
      Err(e) => eprintln!("[TS] брандмауэр: {e}"),
    }
  }
  let handle = app.clone();
  tauri::async_runtime::spawn_blocking(move || ensure_local_hub(&handle)).await.map_err(|e| e.to_string())??;
  {
    let mut s = state.settings.lock().unwrap();
    s.hub_here = true;
    if !s.autostart {
      match app.autolaunch().enable() {
        Ok(()) => s.autostart = true,
        Err(e) => eprintln!("[TS] автозапуск: {e}"),
      }
    }
    settings::save(&app, &s)?;
  }
  // The first start creates the database: usually 1–3 s.
  for _ in 0..60 {
    if hub::probe(&origin, Duration::from_secs(2)).await {
      return Ok(origin);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
  }
  let log = local_hub::data_dir().map(|d| d.join("logs").join("hub.log").display().to_string()).unwrap_or_default();
  Err(format!("HUB запущен, но пока не отвечает. Подождите минуту и нажмите «Попробовать ещё раз». Журнал: {log}"))
}

/// Stops the built-in HUB and forgets «this PC is the HUB».
#[tauri::command]
async fn stop_local_hub(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
  state.ensure_unlocked()?;
  {
    let mut s = state.settings.lock().unwrap();
    s.hub_here = false;
    settings::save(&app, &s)?;
  }
  let handle = app.clone();
  tauri::async_runtime::spawn_blocking(move || stop_local_hub_now(&handle)).await.map_err(|e| e.to_string())
}

/// Settings button: ask Windows again to let tablets reach the built-in HUB.
#[tauri::command]
async fn open_firewall(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
  state.ensure_unlocked()?;
  let bundle = bundle(&app).ok_or(NO_BUNDLE)?;
  let opened = tauri::async_runtime::spawn_blocking(move || local_hub::open_firewall(&bundle)).await.map_err(|e| e.to_string())??;
  if !opened {
    return Err("Доступ не открыт: Windows не получила разрешение. Нажмите ещё раз и ответьте «Да».".into());
  }
  let mut s = state.settings.lock().unwrap();
  s.firewall_done = true;
  settings::save(&app, &s)
}

/// Updater errors in words for the owner; the technical text goes to stderr.
fn update_error(e: tauri_plugin_updater::Error) -> String {
  use tauri_plugin_updater::Error as E;
  eprintln!("[TS] обновление: {e}");
  match e {
    E::ReleaseNotFound | E::TargetNotFound(_) | E::TargetsNotFound(_) => {
      "Новых версий для автообновления пока нет. Новую версию можно скачать вручную на странице «Скачать приложение».".into()
    }
    E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => {
      "Обновление не прошло проверку подписи и не установлено. Скачайте новую версию вручную на странице «Скачать приложение».".into()
    }
    E::AuthenticationFailed => "Обновление отменено: нужен пароль администратора этого компьютера.".into(),
    E::Reqwest(_) | E::Network(_) | E::Http(_) => {
      "Нет связи с сервером обновлений. Проверьте интернет и попробуйте позже.".into()
    }
    other => format!("Не удалось обновить TS: {other}"),
  }
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
  let update = app.updater().map_err(update_error)?.check().await.map_err(update_error)?;
  Ok(update.map(|u| u.version))
}

#[tauri::command]
async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
  state.ensure_unlocked()?;
  let update = app.updater().map_err(update_error)?.check().await.map_err(update_error)?;
  let Some(update) = update else {
    return Err("Установлена последняя версия".into());
  };
  update.download_and_install(|_, _| {}, || {}).await.map_err(update_error)?;
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

/// Modes without a window, for the CI smoke test and support.
fn run_cli(args: &[String]) -> Option<i32> {
  if args.iter().any(|a| a == "--hub-only") {
    return Some(local_hub::run_hub_only());
  }
  if args.iter().any(|a| a == "--open-firewall") {
    return Some(match local_hub::find(None).map(|b| local_hub::open_firewall(&b)) {
      Some(Ok(true)) => 0,
      Some(Ok(false)) => 1,
      Some(Err(e)) => {
        eprintln!("[TS] {e}");
        4
      }
      None => 2,
    });
  }
  None
}

pub fn run() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  if let Some(code) = run_cli(&args) {
    std::process::exit(code);
  }
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
      let hub_here = settings.hub_here;
      let hub_origin = Arc::new(Mutex::new(None::<String>));
      app.manage(AppState {
        settings: Mutex::new(settings),
        hub_origin: hub_origin.clone(),
        unlocked: AtomicBool::new(false),
        local_hub: Mutex::new(None),
      });
      // This PC is the club's HUB: start it before the window asks for it (the page retries meanwhile).
      if hub_here {
        let handle = handle.clone();
        std::thread::spawn(move || {
          if let Err(e) = ensure_local_hub(&handle) {
            eprintln!("[TS] встроенный HUB: {e}");
          }
        });
      }

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
      start_local_hub,
      stop_local_hub,
      open_firewall,
      check_update,
      install_update,
      open_settings,
      print_receipt,
    ])
    .build(tauri::generate_context!())
    .expect("error while running TS")
    .run(|app, event| {
      // The HUB stops with the app (on Windows the job object also covers a crash or the updater).
      if let RunEvent::Exit = event {
        stop_local_hub_now(app);
      }
    });
}
