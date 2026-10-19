//! Finding the club HUB on the LAN and talking to its public endpoints.

use serde_json::Value;
use std::net::{IpAddr, UdpSocket};
use std::time::Duration;
use tokio::task::JoinSet;

pub const DEFAULT_PORT: u16 = 4310;
/// Roles whose key unlocks the kiosk (settings, exit).
const MANAGER_ROLES: [&str; 3] = ["owner", "manager", "superadmin"];

fn client(timeout: Duration) -> reqwest::Client {
  reqwest::Client::builder()
    .timeout(timeout)
    .no_proxy()
    .build()
    .expect("http client")
}

/// "192.168.1.10" → "http://192.168.1.10:4310"; keeps an explicit scheme and port, drops the path.
pub fn normalize(input: &str) -> Result<String, String> {
  let trimmed = input.trim().trim_end_matches('/');
  if trimmed.is_empty() {
    return Err("Укажите адрес HUB".into());
  }
  let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("http://{trimmed}") };
  let mut url = url::Url::parse(&with_scheme).map_err(|_| format!("Неверный адрес: {trimmed}"))?;
  if url.scheme() != "http" && url.scheme() != "https" {
    return Err("Адрес HUB начинается с http:// или https://".into());
  }
  if url.port().is_none() && !trimmed.contains("://") {
    let _ = url.set_port(Some(DEFAULT_PORT));
  }
  url.set_path("");
  url.set_query(None);
  url.set_fragment(None);
  Ok(url.origin().ascii_serialization())
}

/// True when `origin` answers /api/health like a TS HUB.
pub async fn probe(origin: &str, timeout: Duration) -> bool {
  let Ok(res) = client(timeout).get(format!("{origin}/api/health")).send().await else {
    return false;
  };
  if !res.status().is_success() {
    return false;
  }
  match res.json::<Value>().await {
    Ok(body) => body.get("now").is_some() && body.get("power").is_some(),
    Err(_) => false,
  }
}

/// This PC's LAN address (the one used for the default route). No packet is sent.
fn lan_ipv4() -> Option<[u8; 4]> {
  let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
  socket.connect("192.0.2.1:80").ok()?;
  match socket.local_addr().ok()?.ip() {
    IpAddr::V4(ip) if !ip.is_loopback() => Some(ip.octets()),
    _ => None,
  }
}

/// Finds HUBs: first by name (hub.local over mDNS, this PC), then by scanning the /24 of this PC.
pub async fn discover() -> Vec<String> {
  let named = [
    format!("http://hub.local:{DEFAULT_PORT}"),
    format!("http://127.0.0.1:{DEFAULT_PORT}"),
  ];
  let mut found = Vec::new();
  for origin in named {
    if probe(&origin, Duration::from_millis(1500)).await {
      found.push(origin);
    }
  }
  if !found.is_empty() {
    return found;
  }

  let Some([a, b, c, me]) = lan_ipv4() else {
    return found;
  };
  let mut scan = JoinSet::new();
  for d in 1..=254u8 {
    if d == me {
      continue;
    }
    let origin = format!("http://{a}.{b}.{c}.{d}:{DEFAULT_PORT}");
    scan.spawn(async move { probe(&origin, Duration::from_millis(1200)).await.then_some(origin) });
  }
  while let Some(result) = scan.join_next().await {
    if let Ok(Some(origin)) = result {
      found.push(origin);
    }
  }
  found.sort();
  found
}

/// Checks that `key` belongs to a manager or owner of this club. The session the check opens is
/// closed right away, so it does not show up among active sign-ins.
pub async fn verify_manager(origin: &str, key: &str) -> Result<(), String> {
  let http = client(Duration::from_secs(5));
  let res = http
    .post(format!("{origin}/api/auth/login"))
    .json(&serde_json::json!({ "key": key.trim(), "device": "TS для ПК: разблокировка" }))
    .send()
    .await
    .map_err(|_| "Нет связи с HUB".to_string())?;
  if !res.status().is_success() {
    return Err("Ключ не подошёл".into());
  }
  let body: Value = res.json().await.map_err(|e| e.to_string())?;
  if let Some(token) = body.get("token").and_then(Value::as_str) {
    let _ = http
      .post(format!("{origin}/api/auth/logout"))
      .bearer_auth(token)
      .json(&serde_json::json!({}))
      .send()
      .await;
  }
  let role = body.pointer("/staff/role").and_then(Value::as_str).unwrap_or("");
  if MANAGER_ROLES.contains(&role) {
    Ok(())
  } else {
    Err("Нужен ключ управляющего или владельца".into())
  }
}

#[cfg(test)]
mod tests {
  use super::normalize;

  #[test]
  fn normalizes_addresses() {
    assert_eq!(normalize("192.168.1.10").unwrap(), "http://192.168.1.10:4310");
    assert_eq!(normalize(" hub.local:5000/ ").unwrap(), "http://hub.local:5000");
    assert_eq!(normalize("http://hub.local/cash").unwrap(), "http://hub.local");
    assert_eq!(normalize("https://ts.club:8443/").unwrap(), "https://ts.club:8443");
    assert!(normalize("").is_err());
    assert!(normalize("ftp://x").is_err());
  }
}
