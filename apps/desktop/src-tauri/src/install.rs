//! Installing the club HUB on this PC from the scripts bundled with the app (resources
//! deploy/windows and deploy/linux) — the variant for a club without a separate mini-PC.
//!
//! Windows: install.ps1 runs elevated (UAC prompt) in its own console window, so the owner sees the
//! progress; the window stays open on failure. Both PowerShell levels get their script through
//! -EncodedCommand, so paths with spaces ("C:\Program Files\TS") need no quoting.
//! Linux: install.sh through pkexec (the polkit password dialog).

use std::path::{Path, PathBuf};

/// Runs the installer and waits for it. Err — a message for the owner.
#[cfg(windows)]
pub fn run(resources: &Path) -> Result<(), String> {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;

  let script = plain_path(&resources.join("deploy").join("windows").join("install.ps1"));
  if !script.is_file() {
    return Err(format!("Нет установщика HUB: {}. Переустановите TS.", script.display()));
  }
  let status = std::process::Command::new("powershell.exe")
    .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"])
    .arg(encode_command(&elevate_script(&script)))
    .creation_flags(CREATE_NO_WINDOW)
    .status()
    .map_err(|e| format!("Не удалось запустить PowerShell: {e}"))?;
  match status.code() {
    Some(0) => Ok(()),
    Some(ERROR_CANCELLED) => Err(
      "Установка отменена: Windows не получила разрешение. Нажмите ещё раз и ответьте «Да» на вопрос \
       «Разрешить этому приложению вносить изменения?»."
        .into(),
    ),
    _ => Err(
      "Установка HUB не завершилась. Причина написана в окне установки; журнал — C:\\bills\\logs\\install.log".into(),
    ),
  }
}

#[cfg(target_os = "linux")]
pub fn run(resources: &Path) -> Result<(), String> {
  let script = resources.join("deploy").join("linux").join("install.sh");
  if !script.is_file() {
    return Err(format!("Нет установщика HUB: {}. Переустановите TS.", script.display()));
  }
  let output = std::process::Command::new("pkexec")
    .arg("bash")
    .arg(&script)
    .output()
    .map_err(|e| format!("Не удалось запустить pkexec: {e}"))?;
  if output.status.success() {
    return Ok(());
  }
  let log = String::from_utf8_lossy(&output.stderr);
  // pkexec: 126 — the password dialog was closed, 127 — not authorized.
  let dismissed = output.status.code() == Some(126)
    || (output.status.code() == Some(127) && (log.contains("Not authorized") || log.contains("dismissed")));
  if dismissed {
    return Err("Установка отменена: нужен пароль администратора этого компьютера.".into());
  }
  let tail: Vec<&str> = log.lines().filter(|l| !l.trim().is_empty()).rev().take(5).collect();
  Err(format!(
    "Установка HUB не завершилась: {}",
    tail.into_iter().rev().collect::<Vec<_>>().join(" / ")
  ))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn run(_: &Path) -> Result<(), String> {
  Err("Установить HUB из приложения можно только на Windows и Linux".into())
}

/// Exit code of the elevation step when the UAC prompt was declined (ERROR_CANCELLED).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const ERROR_CANCELLED: i32 = 1223;

/// PowerShell string literal.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn ps_quote(s: &str) -> String {
  format!("'{}'", s.replace('\'', "''"))
}

/// The elevated part: install.ps1 in a child PowerShell (its `exit` codes and `#Requires` errors come
/// back as an exit code); on failure the window waits for Enter so the reason stays on screen.
#[cfg_attr(not(windows), allow(dead_code))]
fn installer_script(script: &Path) -> String {
  format!(
    "$Host.UI.RawUI.WindowTitle = 'Установка TS HUB'\n\
     $code = 1\n\
     try {{ & powershell.exe -NoProfile -ExecutionPolicy Bypass -File {path}; $code = $LASTEXITCODE }} \
     catch {{ Write-Host $_ -ForegroundColor Red }}\n\
     if ($code -ne 0) {{ Write-Host ''; Read-Host 'Установка HUB не завершилась (причина выше). Нажмите Enter, чтобы закрыть окно' | Out-Null }}\n\
     exit $code",
    path = ps_quote(&script.to_string_lossy())
  )
}

/// The non-elevated part: asks for administrator rights and waits for the installer window.
/// `$p.Handle` is read before waiting, otherwise PowerShell may lose the exit code.
#[cfg_attr(not(windows), allow(dead_code))]
fn elevate_script(script: &Path) -> String {
  format!(
    "try {{ $p = Start-Process -FilePath powershell.exe -Verb RunAs -PassThru \
     -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{}' }} catch {{ exit {ERROR_CANCELLED} }}\n\
     $null = $p.Handle\n\
     $p.WaitForExit()\n\
     exit $p.ExitCode",
    encode_command(&installer_script(script))
  )
}

/// Runs `script` as administrator without a window (one UAC prompt) and returns its exit code;
/// ERROR_CANCELLED when the prompt was declined.
#[cfg(windows)]
pub(crate) fn run_elevated_hidden(script: &str) -> Result<i32, String> {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  let outer = format!(
    "try {{ $p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -PassThru \
     -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{}' }} catch {{ exit {ERROR_CANCELLED} }}\n\
     $null = $p.Handle\n\
     $p.WaitForExit()\n\
     exit $p.ExitCode",
    encode_command(script)
  );
  let status = std::process::Command::new("powershell.exe")
    .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"])
    .arg(encode_command(&outer))
    .creation_flags(CREATE_NO_WINDOW)
    .status()
    .map_err(|e| format!("Не удалось запустить PowerShell: {e}"))?;
  Ok(status.code().unwrap_or(1))
}

/// Argument of `powershell -EncodedCommand`: base64 of the UTF-16LE script.
#[cfg_attr(not(windows), allow(dead_code))]
fn encode_command(script: &str) -> String {
  let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
  base64(&bytes)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn base64(bytes: &[u8]) -> String {
  const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
  for chunk in bytes.chunks(3) {
    let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | ((b as u32) << (16 - 8 * i)));
    for i in 0..4 {
      out.push(if i <= chunk.len() { ALPHABET[(n >> (18 - 6 * i)) as usize & 63] as char } else { '=' });
    }
  }
  out
}

/// "\\?\C:\Program Files\TS" → "C:\Program Files\TS": Windows PowerShell 5.1 does not take
/// extended-length paths everywhere.
pub(crate) fn plain_path(path: &Path) -> PathBuf {
  let s = path.to_string_lossy();
  if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
    PathBuf::from(format!(r"\\{rest}"))
  } else if let Some(rest) = s.strip_prefix(r"\\?\") {
    PathBuf::from(rest)
  } else {
    path.to_path_buf()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn base64_matches_rfc4648() {
    assert_eq!(base64(b""), "");
    assert_eq!(base64(b"f"), "Zg==");
    assert_eq!(base64(b"fo"), "Zm8=");
    assert_eq!(base64(b"foo"), "Zm9v");
    assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
  }

  #[test]
  fn encodes_powershell_commands_as_utf16le() {
    // [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('exit 0'))
    assert_eq!(encode_command("exit 0"), "ZQB4AGkAdAAgADAA");
    assert_eq!(encode_command("Я"), "LwQ=");
  }

  #[test]
  fn quotes_paths_for_powershell() {
    assert_eq!(ps_quote(r"C:\Program Files\TS\install.ps1"), r"'C:\Program Files\TS\install.ps1'");
    assert_eq!(ps_quote(r"C:\O'Brien\x.ps1"), r"'C:\O''Brien\x.ps1'");
  }

  #[test]
  fn strips_extended_length_prefixes() {
    assert_eq!(plain_path(Path::new(r"\\?\C:\Program Files\TS")), PathBuf::from(r"C:\Program Files\TS"));
    assert_eq!(plain_path(Path::new(r"\\?\UNC\srv\share\TS")), PathBuf::from(r"\\srv\share\TS"));
    assert_eq!(plain_path(Path::new(r"C:\TS")), PathBuf::from(r"C:\TS"));
  }

  #[test]
  fn scripts_carry_the_installer_path_and_cancel_code() {
    let path = Path::new(r"C:\Program Files\TS\deploy\windows\install.ps1");
    let inner = installer_script(path);
    assert!(inner.contains(r"-File 'C:\Program Files\TS\deploy\windows\install.ps1'"));
    let outer = elevate_script(path);
    assert!(outer.contains(&encode_command(&inner)));
    assert!(outer.contains("exit 1223"));
    assert!(!outer.contains('"'));
  }
}
