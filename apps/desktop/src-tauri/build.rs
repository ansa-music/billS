fn main() {
  // App commands get permissions (allow-<command>) so capabilities can split them between the
  // local settings page and the HUB pages.
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
    "get_state",
    "discover",
    "connect",
    "unlock",
    "save_settings",
    "list_printers",
    "quit",
    "install_hub",
    "start_local_hub",
    "stop_local_hub",
    "open_firewall",
    "check_update",
    "install_update",
    "open_settings",
    "print_receipt",
  ])))
  .expect("tauri build");
}
