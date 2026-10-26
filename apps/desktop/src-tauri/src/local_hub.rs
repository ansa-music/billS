//! The HUB built into TS for PC: «this is the club's main computer» runs it right here as a child
//! process — no administrator rights, no internet, no git or npm on the club PC.
//!
//! The installers carry `hub-bundle/` (scripts/bundle-hub.mjs): the official Node.js binary and
//! the HUB bundled into one file, plus its SQL migrations and the hall screen. The app starts
//!   <bundle>/node --env-file-if-exists=<data>/hub.env <bundle>/src/main.mjs
//! with HUB_DB_PATH=<data>/hub.db, HUB_HOST=0.0.0.0, HUB_PORT=4310, HUB_WEB_DIST=<bundle>/web.
//! <data> is %LOCALAPPDATA%\TS\hub on Windows (the NSIS uninstaller never removes it) and
//! ~/.local/share/TS/hub on Linux; the HUB log goes to <data>/logs/hub.log.
//!
//! A supervisor thread restarts the HUB when it exits: after the first-boot wizard saves the
//! cloud connection (exit code 75) and after a crash. On Windows the HUB lives in a job object that
//! is killed with the app, so an update can replace node.exe and no orphan keeps port 4310.
//! `--hub-only` runs the same supervisor without a window (the CI smoke test uses it).

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const BUNDLE_DIR: &str = "hub-bundle";
pub const PORT: u16 = crate::hub::DEFAULT_PORT;
/// Exit code of the HUB after the first-boot wizard saved the connection (apps/hub/src/setup.ts).
const SETUP_RESTART_EXIT_CODE: i32 = 75;
const LOG_MAX_BYTES: u64 = 20 * 1024 * 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The HUB files shipped with the app.
#[derive(Clone, Debug)]
pub struct Bundle {
  pub dir: PathBuf,
  pub node: PathBuf,
  pub main: PathBuf,
  pub web: PathBuf,
  pub git_sha: Option<String>,
}

impl Bundle {
  pub fn at(dir: &Path) -> Option<Bundle> {
    let dir = crate::install::plain_path(dir);
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let main = dir.join("src").join("main.mjs");
    if !node.is_file() || !main.is_file() {
      return None;
    }
    let git_sha = fs::read(dir.join("package.json"))
      .ok()
      .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
      .and_then(|v| v.get("gitSha")?.as_str().map(String::from));
    Some(Bundle { web: dir.join("web"), node, main, git_sha, dir })
  }
}

/// Folders the bundle may be in: TS_HUB_BUNDLE, the app resources, next to the program (Windows),
/// /usr/lib/TS for /usr/bin/ts-desktop (.deb), apps/desktop/hub-bundle in debug builds.
fn candidates(resource_dir: Option<&Path>) -> Vec<PathBuf> {
  let mut dirs = Vec::new();
  if let Some(dir) = std::env::var_os("TS_HUB_BUNDLE") {
    dirs.push(PathBuf::from(dir));
  }
  if let Some(dir) = resource_dir {
    dirs.push(dir.join(BUNDLE_DIR));
  }
  if let Some(exe_dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
    dirs.push(exe_dir.join(BUNDLE_DIR));
    dirs.push(exe_dir.join("..").join("lib").join("TS").join(BUNDLE_DIR));
  }
  if cfg!(debug_assertions) {
    dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(BUNDLE_DIR));
  }
  dirs
}

pub fn find(resource_dir: Option<&Path>) -> Option<Bundle> {
  candidates(resource_dir).iter().find_map(|dir| Bundle::at(dir))
}

/// Where the HUB keeps its database, setup.json, keys and logs.
pub fn data_dir() -> Result<PathBuf, String> {
  #[cfg(windows)]
  {
    let base = std::env::var_os("LOCALAPPDATA").ok_or("Нет папки LOCALAPPDATA")?;
    Ok(PathBuf::from(base).join("TS").join("hub"))
  }
  #[cfg(not(windows))]
  {
    let base = std::env::var_os("XDG_DATA_HOME")
      .map(PathBuf::from)
      .filter(|p| p.is_absolute())
      .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share")))
      .ok_or("Нет домашней папки")?;
    Ok(base.join("TS").join("hub"))
  }
}

/// HUB settings of the built-in HUB. hub.env in the data folder may add others (lamp controller,
/// UPS…); these win over it — Node's --env-file does not override variables that are set.
pub fn env_vars(bundle: &Bundle, data: &Path) -> Vec<(&'static str, OsString)> {
  let mut vars = vec![
    ("HUB_DB_PATH", data.join("hub.db").into_os_string()),
    ("HUB_HOST", "0.0.0.0".into()),
    ("HUB_PORT", PORT.to_string().into()),
    ("HUB_WEB_DIST", bundle.web.clone().into_os_string()),
  ];
  if let Some(sha) = &bundle.git_sha {
    vars.push(("HUB_GIT_SHA", sha.into()));
  }
  vars
}

/// The one command line of the built-in HUB (the app, --hub-only and the CI smoke test).
pub fn command(bundle: &Bundle, node: &Path, data: &Path) -> Command {
  let mut env_file = OsString::from("--env-file-if-exists=");
  env_file.push(data.join("hub.env"));
  let mut cmd = Command::new(node);
  cmd.arg(env_file).arg(&bundle.main).current_dir(data).env_remove("NODE_OPTIONS").stdin(Stdio::null());
  for (key, value) in env_vars(bundle, data) {
    cmd.env(key, value);
  }
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  cmd
}

/// True when a TS HUB answers on this PC (blocking; for the supervisor thread).
pub fn answers(timeout: Duration) -> bool {
  let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, PORT));
  let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else {
    return false;
  };
  let _ = stream.set_read_timeout(Some(timeout));
  let _ = stream.set_write_timeout(Some(timeout));
  if stream.write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
    return false;
  }
  let mut body = Vec::new();
  let _ = stream.take(256 * 1024).read_to_end(&mut body);
  looks_like_health(&String::from_utf8_lossy(&body))
}

fn looks_like_health(response: &str) -> bool {
  let status_ok = response.lines().next().is_some_and(|line| line.split_whitespace().nth(1) == Some("200"));
  status_ok && response.contains("\"now\"") && response.contains("\"power\"")
}

/// UTC time for the log lines of the supervisor.
fn stamp() -> String {
  let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
  let (days, rest) = (secs / 86_400, secs % 86_400);
  // Days since 1970-01-01 → civil date (H. Hinnant's algorithm).
  let z = days as i64 + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = doy - (153 * mp + 2) / 5 + 1;
  let month = if mp < 10 { mp + 3 } else { mp - 9 };
  let year = yoe + era * 400 + i64::from(month <= 2);
  format!("{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC", rest / 3600, rest % 3600 / 60, rest % 60)
}

struct Paths {
  log: PathBuf,
  log1: PathBuf,
}

impl Paths {
  fn new(data: &Path) -> Paths {
    let logs = data.join("logs");
    Paths { log: logs.join("hub.log"), log1: logs.join("hub.1.log") }
  }

  fn note(&self, message: &str) {
    eprintln!("[TS] {message}");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.log) {
      let _ = writeln!(f, "[{}] TS: {message}", stamp());
    }
  }

  /// One previous generation, like run-hub.cmd: hub.log over 20 MB becomes hub.1.log.
  fn rotate(&self) {
    if fs::metadata(&self.log).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
      let _ = fs::remove_file(&self.log1);
      let _ = fs::rename(&self.log, &self.log1);
    }
  }
}

/// Node from the bundle, or — when a package lost its executable bit — a copy in the data folder.
fn runnable_node(bundle: &Bundle, data: &Path) -> Result<PathBuf, String> {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(&bundle.node).map_err(|e| e.to_string())?.permissions().mode();
    if mode & 0o111 == 0 {
      let copy = data.join("runtime").join("node");
      fs::create_dir_all(copy.parent().unwrap()).map_err(|e| e.to_string())?;
      let fresh = fs::metadata(&copy).map(|m| m.len()).ok() == fs::metadata(&bundle.node).map(|m| m.len()).ok();
      if !fresh {
        fs::copy(&bundle.node, &copy).map_err(|e| format!("Не удалось подготовить Node.js: {e}"))?;
      }
      fs::set_permissions(&copy, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
      return Ok(copy);
    }
  }
  let _ = data;
  Ok(bundle.node.clone())
}

fn spawn(bundle: &Bundle, node: &Path, data: &Path, paths: &Paths) -> Result<Child, String> {
  paths.rotate();
  let log = OpenOptions::new()
    .create(true)
    .append(true)
    .open(&paths.log)
    .map_err(|e| format!("Не удалось открыть журнал HUB {}: {e}", paths.log.display()))?;
  let err = log.try_clone().map_err(|e| e.to_string())?;
  let mut cmd = command(bundle, node, data);
  cmd.stdout(log).stderr(err);
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    // The HUB gets SIGTERM when the thread that started it (the supervisor) ends, also on a crash.
    unsafe {
      cmd.pre_exec(|| {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
        Ok(())
      });
    }
  }
  let child = cmd.spawn().map_err(|e| format!("Не удалось запустить HUB ({}): {e}", node.display()))?;
  #[cfg(windows)]
  job::adopt(&child);
  paths.note(&format!("HUB запущен (PID {}), база {}", child.id(), data.join("hub.db").display()));
  Ok(child)
}

/// Stops the HUB: SIGTERM first on Linux (it closes the database cleanly), then kill.
fn terminate(child: &mut Child) {
  #[cfg(unix)]
  {
    unsafe {
      libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
      if let Ok(Some(_)) = child.try_wait() {
        return;
      }
      std::thread::sleep(Duration::from_millis(100));
    }
  }
  let _ = child.kill();
  let _ = child.wait();
}

/// Pause before the next start: short after the wizard's restart, growing after quick crashes.
fn restart_delay(code: Option<i32>, ran_for: Duration, previous: Duration) -> Duration {
  if code == Some(SETUP_RESTART_EXIT_CODE) {
    Duration::from_secs(1)
  } else if ran_for > Duration::from_secs(60) {
    Duration::from_secs(2)
  } else {
    (previous * 2).clamp(Duration::from_secs(2), Duration::from_secs(30))
  }
}

/// The built-in HUB with its restart loop. Dropping it stops the HUB.
pub struct Supervisor {
  stop: Arc<AtomicBool>,
  child: Arc<Mutex<Option<Child>>>,
  thread: Option<JoinHandle<()>>,
}

impl Supervisor {
  /// Starts the HUB now (errors such as a missing file come back right away) and keeps it running.
  /// Every start happens on the supervisor thread: on Linux the HUB is tied to that thread's life.
  pub fn start(bundle: Bundle, data: PathBuf) -> Result<Supervisor, String> {
    fs::create_dir_all(data.join("logs")).map_err(|e| format!("Не удалось создать папку HUB {}: {e}", data.display()))?;
    let node = runnable_node(&bundle, &data)?;
    let stop = Arc::new(AtomicBool::new(false));
    let child = Arc::new(Mutex::new(None));
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let thread = {
      let (stop, child) = (stop.clone(), child.clone());
      std::thread::Builder::new()
        .name("ts-hub".into())
        .spawn(move || {
          let paths = Paths::new(&data);
          match spawn(&bundle, &node, &data, &paths) {
            Ok(first) => {
              *child.lock().unwrap() = Some(first);
              let _ = started_tx.send(Ok(()));
              supervise(&bundle, &node, &data, &paths, &stop, &child);
            }
            Err(e) => {
              let _ = started_tx.send(Err(e));
            }
          }
        })
        .map_err(|e| e.to_string())?
    };
    match started_rx.recv() {
      Ok(Ok(())) => Ok(Supervisor { stop, child, thread: Some(thread) }),
      Ok(Err(e)) => {
        let _ = thread.join();
        Err(e)
      }
      Err(_) => Err("HUB не запустился".into()),
    }
  }

  pub fn stop(&mut self) {
    self.stop.store(true, Ordering::SeqCst);
    if let Some(mut child) = self.child.lock().unwrap().take() {
      terminate(&mut child);
    }
    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
  }

  /// Blocks until the supervisor ends (only `stop` ends it; used by --hub-only).
  pub fn wait(mut self) {
    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
  }
}

impl Drop for Supervisor {
  fn drop(&mut self) {
    self.stop();
  }
}

/// Sleeps in small steps; false when asked to stop meanwhile.
fn pause(stop: &AtomicBool, total: Duration) -> bool {
  let deadline = Instant::now() + total;
  while Instant::now() < deadline {
    if stop.load(Ordering::SeqCst) {
      return false;
    }
    std::thread::sleep(Duration::from_millis(200));
  }
  !stop.load(Ordering::SeqCst)
}

fn supervise(bundle: &Bundle, node: &Path, data: &Path, paths: &Paths, stop: &AtomicBool, child: &Mutex<Option<Child>>) {
  let mut started = Instant::now();
  let mut delay = Duration::ZERO;
  loop {
    // Wait for the HUB to exit (or for `stop`, which takes the child itself).
    let code = loop {
      if stop.load(Ordering::SeqCst) {
        return;
      }
      let mut guard = child.lock().unwrap();
      let status = match guard.as_mut() {
        Some(c) => c.try_wait(),
        None => Ok(None),
      };
      match status {
        Ok(Some(status)) => {
          guard.take();
          break status.code();
        }
        Err(e) => {
          guard.take();
          paths.note(&format!("не удалось проверить HUB: {e}"));
          break None;
        }
        Ok(None) if guard.is_none() => break None,
        Ok(None) => {}
      }
      drop(guard);
      std::thread::sleep(Duration::from_millis(250));
    };
    if stop.load(Ordering::SeqCst) {
      return;
    }
    delay = restart_delay(code, started.elapsed(), delay);
    let reason = match code {
      Some(SETUP_RESTART_EXIT_CODE) => "мастер настройки сохранил подключение".to_string(),
      Some(c) => format!("код {c}"),
      None => "без кода".to_string(),
    };
    paths.note(&format!("HUB завершился ({reason}), перезапуск через {} с", delay.as_secs()));
    if !pause(stop, delay) {
      return;
    }
    // Another HUB took the port meanwhile (the service, a second copy of TS): leave it be.
    while answers(Duration::from_secs(2)) {
      if !pause(stop, Duration::from_secs(10)) {
        return;
      }
    }
    let mut guard = child.lock().unwrap();
    if stop.load(Ordering::SeqCst) {
      return;
    }
    match spawn(bundle, node, data, paths) {
      Ok(c) => {
        *guard = Some(c);
        started = Instant::now();
      }
      Err(e) => paths.note(&e),
    }
  }
}

/// `ts-desktop --hub-only`: the built-in HUB without a window, until the process is stopped.
/// Exit codes: 2 — no bundle, 3 — no data folder or the HUB did not start.
pub fn run_hub_only() -> i32 {
  let Some(bundle) = find(None) else {
    eprintln!("[TS] В этой сборке нет встроенного HUB ({BUNDLE_DIR})");
    return 2;
  };
  let data = match data_dir() {
    Ok(d) => d,
    Err(e) => {
      eprintln!("[TS] {e}");
      return 3;
    }
  };
  if answers(Duration::from_secs(2)) {
    eprintln!("[TS] HUB уже работает на этом компьютере (порт {PORT})");
  }
  match Supervisor::start(bundle, data) {
    Ok(supervisor) => {
      supervisor.wait();
      0
    }
    Err(e) => {
      eprintln!("[TS] {e}");
      3
    }
  }
}

// ── Windows: the HUB dies with the app ─────────────────────────────────────

#[cfg(windows)]
mod job {
  use std::os::windows::io::AsRawHandle;
  use std::sync::OnceLock;
  use windows::Win32::Foundation::HANDLE;
  use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  };

  struct Job(HANDLE);
  // The handle is only passed to AssignProcessToJobObject and never closed (it lives as long as the app).
  unsafe impl Send for Job {}
  unsafe impl Sync for Job {}

  static JOB: OnceLock<Option<Job>> = OnceLock::new();

  fn create() -> Option<Job> {
    unsafe {
      let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
      let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &info as *const _ as *const core::ffi::c_void,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
      )
      .ok()?;
      Some(Job(job))
    }
  }

  /// Puts the HUB into a job that Windows closes — killing the HUB — when the app exits in any way.
  pub fn adopt(child: &std::process::Child) {
    if let Some(Job(job)) = JOB.get_or_init(create) {
      unsafe {
        if let Err(e) = AssignProcessToJobObject(*job, HANDLE(child.as_raw_handle())) {
          eprintln!("[TS] HUB не привязан к приложению: {e}");
        }
      }
    }
  }
}

// ── Windows Firewall: tablets in the club network reach the HUB ─────────────

/// Name of the inbound rule for the built-in HUB (node.exe of the bundle).
pub const FIREWALL_RULE: &str = "TS HUB";

/// The elevated script: one allow rule for the bundle's node.exe, private and domain networks only.
#[cfg_attr(not(windows), allow(dead_code))]
fn firewall_script(node: &Path) -> String {
  use crate::install::ps_quote;
  format!(
    "$ErrorActionPreference = 'Stop'\n\
     Get-NetFirewallRule -DisplayName {name} -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n\
     New-NetFirewallRule -DisplayName {name} -Description {description} -Direction Inbound -Action Allow \
     -Program {program} -Profile Private,Domain | Out-Null\n\
     exit 0",
    name = ps_quote(FIREWALL_RULE),
    description = ps_quote("TS: планшеты и экраны в сети заведения подключаются к HUB на этом компьютере"),
    program = ps_quote(&node.to_string_lossy()),
  )
}

/// Asks Windows once (UAC) to let the club network reach the built-in HUB. Ok(false) — declined.
#[cfg(windows)]
pub fn open_firewall(bundle: &Bundle) -> Result<bool, String> {
  match crate::install::run_elevated_hidden(&firewall_script(&bundle.node))? {
    0 => Ok(true),
    crate::install::ERROR_CANCELLED => Ok(false),
    code => Err(format!("Не удалось открыть доступ в брандмауэре Windows (код {code})")),
  }
}

#[cfg(not(windows))]
pub fn open_firewall(_: &Bundle) -> Result<bool, String> {
  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn bundle() -> Bundle {
    let dir = PathBuf::from("/opt/TS/hub-bundle");
    Bundle {
      node: dir.join("node"),
      main: dir.join("src").join("main.mjs"),
      web: dir.join("web"),
      git_sha: Some("abc1234567".into()),
      dir,
    }
  }

  #[test]
  fn hub_env_points_at_the_data_folder_and_the_bundle() {
    let data = PathBuf::from("/home/club/.local/share/TS/hub");
    let vars: std::collections::HashMap<_, _> = env_vars(&bundle(), &data).into_iter().collect();
    assert_eq!(vars["HUB_DB_PATH"], data.join("hub.db").into_os_string());
    assert_eq!(vars["HUB_HOST"], OsString::from("0.0.0.0"));
    assert_eq!(vars["HUB_PORT"], OsString::from("4310"));
    assert_eq!(vars["HUB_WEB_DIST"], PathBuf::from("/opt/TS/hub-bundle/web").into_os_string());
    assert_eq!(vars["HUB_GIT_SHA"], OsString::from("abc1234567"));
  }

  #[test]
  fn command_runs_the_bundle_with_the_env_file_of_the_data_folder() {
    let data = PathBuf::from("/data/hub");
    let b = bundle();
    let cmd = command(&b, &b.node, &data);
    assert_eq!(cmd.get_program(), b.node.as_os_str());
    let args: Vec<_> = cmd.get_args().collect();
    assert_eq!(args[0], OsString::from(format!("--env-file-if-exists={}", data.join("hub.env").display())));
    assert_eq!(args[1], b.main.as_os_str());
    assert_eq!(cmd.get_current_dir(), Some(data.as_path()));
    assert!(cmd.get_envs().any(|(k, v)| k == "NODE_OPTIONS" && v.is_none()));
  }

  #[test]
  fn recognizes_a_hub_health_response() {
    let ok = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"now\":1,\"power\":{}}";
    assert!(looks_like_health(ok));
    assert!(!looks_like_health("HTTP/1.1 404 Not Found\r\n\r\n{\"now\":1,\"power\":{}}"));
    assert!(!looks_like_health("HTTP/1.1 200 OK\r\n\r\n<html>"));
    assert!(!looks_like_health(""));
  }

  #[test]
  fn restarts_fast_after_the_wizard_and_backs_off_after_crashes() {
    let s = Duration::from_secs;
    assert_eq!(restart_delay(Some(75), s(1), s(30)), s(1));
    assert_eq!(restart_delay(Some(1), s(5), Duration::ZERO), s(2));
    assert_eq!(restart_delay(Some(1), s(5), s(2)), s(4));
    assert_eq!(restart_delay(Some(1), s(5), s(20)), s(30));
    assert_eq!(restart_delay(None, s(600), s(30)), s(2));
  }

  #[test]
  fn finds_a_bundle_by_its_files() {
    let dir = std::env::temp_dir().join(format!("ts-bundle-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).unwrap();
    assert!(Bundle::at(&dir).is_none());
    fs::write(dir.join(if cfg!(windows) { "node.exe" } else { "node" }), b"").unwrap();
    fs::write(dir.join("src").join("main.mjs"), b"").unwrap();
    fs::write(dir.join("package.json"), br#"{"name":"@bills/hub","gitSha":"0123456789"}"#).unwrap();
    let b = Bundle::at(&dir).expect("bundle");
    assert_eq!(b.git_sha.as_deref(), Some("0123456789"));
    assert_eq!(b.web, dir.join("web"));
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn firewall_rule_names_the_bundled_node() {
    let script = firewall_script(Path::new(r"C:\Users\Аня\AppData\Local\TS\hub-bundle\node.exe"));
    assert!(script.contains(r"-Program 'C:\Users\Аня\AppData\Local\TS\hub-bundle\node.exe'"));
    assert!(script.contains("-Profile Private,Domain"));
    assert!(script.contains("-DisplayName 'TS HUB'"));
  }

  #[test]
  fn stamps_are_utc_dates() {
    let s = stamp();
    assert_eq!(s.len(), 23, "{s}");
    assert!(s.ends_with(" UTC"));
    assert!(s.starts_with("20"));
  }
}
