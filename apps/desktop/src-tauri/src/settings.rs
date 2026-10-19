//! Device settings: one JSON file in the app config dir
//! (%APPDATA%\app.ts.desktop\settings.json, ~/.config/app.ts.desktop/settings.json).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
  /// HUB origin, e.g. "http://192.168.1.10:4310". None until the first setup.
  pub hub_url: Option<String>,
  /// Fullscreen, no frame, closing only with a manager key.
  pub kiosk: bool,
  /// Receipt printer name; empty — the system default printer.
  pub printer: String,
  /// Start TS when the user signs in to the PC.
  pub autostart: bool,
}

fn path(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
  path(app)
    .and_then(|p| std::fs::read(p).ok())
    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    .unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
  let p = path(app).ok_or("Нет папки настроек")?;
  if let Some(dir) = p.parent() {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
  std::fs::write(p, json).map_err(|e| e.to_string())
}
