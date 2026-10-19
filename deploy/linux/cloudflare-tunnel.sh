#!/usr/bin/env bash
# cloudflare-tunnel.sh — кабинет владельца через Cloudflare Tunnel (если Tailscale не подходит).
#
# Туннель — исходящее соединение мини-ПК к Cloudflare: проброс портов на роутере и «белый» IP не нужны.
# ВНИМАНИЕ: в отличие от Tailscale, с туннелем кабинет ОТКРЫТ В ИНТЕРНЕТ — любой, кто знает адрес,
# увидит страницу входа (дальше — только по паролю владельца). Данные по-прежнему хранятся
# на этом мини-ПК в Казахстане: через Cloudflare идёт только трафик (зашифрованный TLS).
#
#   sudo bills tunnel quick           — временный адрес https://….trycloudflare.com (для демонстрации)
#   sudo bills tunnel token <TOKEN>   — постоянный туннель на своём домене (создаётся в панели Cloudflare)
#   sudo bills tunnel status          — что запущено и какой адрес
#   sudo bills tunnel stop            — остановить туннели
#
# Повторный запуск безопасен.

set -Eeuo pipefail
SCRIPT_NAME="cloudflare-tunnel.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

export DEBIAN_FRONTEND=noninteractive
QUICK_SERVICE="bills-tunnel-quick"
QUICK_UNIT="/etc/systemd/system/${QUICK_SERVICE}.service"
TOKEN_SERVICE="cloudflared"

usage() {
  cat <<USAGE
Использование: sudo bills tunnel <режим> [параметры]
  quick [--port <порт>]   быстрый туннель без аккаунта: адрес https://<случайные-слова>.trycloudflare.com
                          Адрес МЕНЯЕТСЯ при каждом перезапуске мини-ПК или службы. Только для
                          демонстрации, Cloudflare не даёт гарантий работы. Служба: $QUICK_SERVICE
  token <TOKEN>           постоянный туннель на вашем домене (домен должен быть подключён к Cloudflare):
                          1) https://one.dash.cloudflare.com → Networks → Tunnels → Create a tunnel → Cloudflared;
                          2) скопируйте токен из команды «cloudflared service install <TOKEN>»;
                          3) там же, во вкладке Public Hostname: поддомен (например cabinet.вашдомен.kz) →
                             Service: HTTP, URL: localhost:$(cloud_port)
                          4) на этом мини-ПК: sudo bills tunnel token <TOKEN>
  status                  что запущено и какой адрес у быстрого туннеля
  stop                    остановить и выключить оба вида туннеля (cloudflared остаётся установленным)

Помните: через туннель кабинет открыт в интернет (вход по паролю). Данные хранятся на этом мини-ПК,
через Cloudflare проходит только зашифрованный трафик. Самый закрытый вариант — Tailscale: sudo bills tailscale
USAGE
}

MODE="${1:-}"
[ -n "$MODE" ] || { usage; exit 1; }
shift
case "$MODE" in -h|--help|help) usage; exit 0 ;; esac

TOKEN=""
PORT_OPT=""
case "$MODE" in
  quick)
    while [ $# -gt 0 ]; do
      case "$1" in
        --port) [ $# -ge 2 ] || die "--port требует значение"; PORT_OPT="$2"; shift 2 ;;
        --port=*) PORT_OPT="${1#--port=}"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "неизвестный параметр: $1 (см. --help)" ;;
      esac
    done
    ;;
  token)
    [ $# -ge 1 ] || die "укажите токен: sudo bills tunnel token <TOKEN> (см. --help)"
    TOKEN="$1"; shift
    [ $# -eq 0 ] || die "лишние параметры: $* (см. --help)"
    ;;
  status|stop) [ $# -eq 0 ] || die "лишние параметры: $*" ;;
  *) die "неизвестный режим: $MODE (quick, token, status, stop — см. --help)" ;;
esac

require_root "$MODE"
require_cmd curl systemctl
load_env

target_port() {
  if [ -n "$PORT_OPT" ]; then
    case "$PORT_OPT" in *[!0-9]*) die "--port должен быть числом" ;; esac
    printf '%s' "$PORT_OPT"
    return 0
  fi
  cloud_enabled || die "облако на этом мини-ПК не включено (нет $CLOUD_ENV_FILE). Сначала: sudo bash $BIN_DIR/install.sh --with-cloud"
  cloud_port
}

warn_internet() {
  echo
  warn "С туннелем кабинет владельца ДОСТУПЕН ИЗ ИНТЕРНЕТА: кто знает адрес, увидит страницу входа."
  echo "  Защита — пароль владельца: сделайте его длинным (sudo bills cloud reset-password --email <почта>)."
  echo "  Данные остаются на этом мини-ПК в Казахстане; через Cloudflare идёт только трафик (TLS)."
  echo "  HUB (порт $(hub_port)) через туннель НЕ публикуется."
  echo
}

# ---------- Установка cloudflared ----------
cloudflared_bin() { command -v cloudflared 2>/dev/null || true; }

install_cloudflared() {
  if [ -n "$(cloudflared_bin)" ]; then
    log "cloudflared уже установлен ($(cloudflared --version 2>/dev/null | head -n 1)) — пропускаю установку."
    return 0
  fi
  log "Ставлю cloudflared из официального репозитория pkg.cloudflare.com ..."
  install -d -m 0755 /usr/share/keyrings
  local key_ok=0 key
  for key in cloudflare-public-v2.gpg cloudflare-main.gpg; do
    if curl -fsSL "https://pkg.cloudflare.com/$key" -o /usr/share/keyrings/cloudflare-main.gpg.tmp; then
      mv -f /usr/share/keyrings/cloudflare-main.gpg.tmp /usr/share/keyrings/cloudflare-main.gpg
      key_ok=1
      break
    fi
  done
  rm -f /usr/share/keyrings/cloudflare-main.gpg.tmp
  if [ "$key_ok" -eq 1 ]; then
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
      >/etc/apt/sources.list.d/cloudflared.list
    if apt-get update -qq </dev/null && apt-get install -y -qq cloudflared </dev/null; then
      ok "cloudflared установлен из apt-репозитория."
      return 0
    fi
    warn "установка из apt-репозитория не удалась — пробую .deb с GitHub (cloudflare/cloudflared)"
    rm -f /etc/apt/sources.list.d/cloudflared.list
  fi
  local arch deb
  case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
    amd64|x86_64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    armhf|armv7l) arch="armhf" ;;
    *) die "неподдерживаемая архитектура для cloudflared: $(uname -m)" ;;
  esac
  deb="$(mktemp /tmp/cloudflared.XXXXXX.deb)"
  log "Скачиваю https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb ..."
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb" -o "$deb" \
    || { rm -f "$deb"; die "не удалось скачать cloudflared — есть ли интернет?"; }
  dpkg -i "$deb" >/dev/null || { rm -f "$deb"; die "dpkg -i cloudflared не удался"; }
  rm -f "$deb"
  [ -n "$(cloudflared_bin)" ] || die "после установки команда cloudflared не найдена"
  ok "cloudflared установлен (.deb с GitHub)."
}

# Адрес быстрого туннеля из журнала службы (пусто, если ещё нет). quick_url [с какого времени]
quick_url() {
  local since="${1:-}" args=(-u "$QUICK_SERVICE" -o cat --no-pager)
  [ -z "$since" ] || args+=(--since "$since")
  journalctl "${args[@]}" 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1 || true
}

# ---------- Режимы ----------
case "$MODE" in
  quick)
    port="$(target_port)"
    install_cloudflared
    bin="$(cloudflared_bin)"
    log "Создаю службу $QUICK_SERVICE (cloudflared → http://127.0.0.1:${port})"
    cat >"$QUICK_UNIT" <<UNIT
# TS: быстрый туннель Cloudflare к кабинету владельца (создано cloudflare-tunnel.sh).
# Адрес https://….trycloudflare.com меняется при каждом перезапуске — смотрите: sudo bills tunnel status
[Unit]
Description=TS: быстрый туннель Cloudflare (trycloudflare.com) к кабинету
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$BILLS_USER
Group=$BILLS_USER
ExecStart=$bin tunnel --no-autoupdate --url http://127.0.0.1:${port}
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
    chmod 644 "$QUICK_UNIT"
    systemctl daemon-reload
    since="$(date '+%Y-%m-%d %H:%M:%S')"
    systemctl enable --quiet "$QUICK_SERVICE"
    systemctl restart "$QUICK_SERVICE"
    log "Жду адрес от Cloudflare (до 60 с) ..."
    url=""
    for ((i = 0; i < 60; i++)); do
      url="$(quick_url "$since")"
      [ -z "$url" ] || break
      sleep 1
    done
    [ -n "$url" ] || { journalctl -u "$QUICK_SERVICE" -n 30 --no-pager || true; die "Cloudflare не выдал адрес за 60 с. Смотрите: journalctl -u $QUICK_SERVICE -n 100"; }
    echo
    ok "Кабинет владельца временно доступен по адресу: $url"
    warn "Этот адрес меняется при каждом перезапуске мини-ПК/службы. Только для демонстрации, без гарантий Cloudflare."
    echo "  Узнать текущий адрес: sudo bills tunnel status.  Остановить: sudo bills tunnel stop"
    echo "  Для постоянного адреса: свой домен + sudo bills tunnel token <TOKEN> (или Tailscale: sudo bills tailscale)"
    warn_internet
    ;;
  token)
    case "$TOKEN" in *[[:space:]]*|'') die "токен не должен содержать пробелов — скопируйте его целиком" ;; esac
    install_cloudflared
    if systemctl list-unit-files "${TOKEN_SERVICE}.service" >/dev/null 2>&1 \
       && [ -f "/etc/systemd/system/${TOKEN_SERVICE}.service" ]; then
      log "Служба $TOKEN_SERVICE уже есть — переустанавливаю с новым токеном ..."
      cloudflared service uninstall >/dev/null 2>&1 || true
    fi
    log "Устанавливаю постоянный туннель (cloudflared service install) ..."
    cloudflared service install "$TOKEN" || die "cloudflared service install не удался — проверьте токен"
    systemctl enable --quiet --now "$TOKEN_SERVICE" || true
    if systemctl is-active --quiet "$QUICK_SERVICE"; then
      log "Останавливаю быстрый туннель $QUICK_SERVICE — постоянный его заменяет"
      systemctl disable --now --quiet "$QUICK_SERVICE" || true
    fi
    sleep 3
    if systemctl is-active --quiet "$TOKEN_SERVICE"; then
      ok "Постоянный туннель запущен (служба $TOKEN_SERVICE)."
    else
      warn "служба $TOKEN_SERVICE не запустилась — смотрите: journalctl -u $TOKEN_SERVICE -n 50"
    fi
    echo
    echo "  Адрес кабинета задаётся в панели Cloudflare Zero Trust → Networks → Tunnels → ваш туннель →"
    echo "  Public Hostname: например cabinet.вашдомен.kz → Service HTTP → localhost:$(cloud_port)"
    echo "  Токен хранится в /etc/systemd/system/${TOKEN_SERVICE}.service (так устроен cloudflared) — не публикуйте его."
    warn_internet
    ;;
  status)
    for svc in "$QUICK_SERVICE" "$TOKEN_SERVICE"; do
      if systemctl list-unit-files "${svc}.service" 2>/dev/null | grep -q "^${svc}\.service"; then
        systemctl status "$svc" --no-pager --lines=3 || true
        echo
      else
        echo "Служба $svc не установлена."
      fi
    done
    if systemctl is-active --quiet "$QUICK_SERVICE"; then
      url="$(quick_url)"
      echo "Адрес быстрого туннеля: ${url:-ещё не получен (journalctl -u $QUICK_SERVICE)}"
    fi
    ;;
  stop)
    stopped=0
    for svc in "$QUICK_SERVICE" "$TOKEN_SERVICE"; do
      if systemctl is-enabled --quiet "$svc" 2>/dev/null || systemctl is-active --quiet "$svc"; then
        systemctl disable --now --quiet "$svc" || true
        ok "Остановлен и выключен: $svc"
        stopped=1
      fi
    done
    [ "$stopped" -eq 1 ] || log "Туннели не запущены — останавливать нечего."
    echo "  Кабинет больше не доступен через Cloudflare. cloudflared остаётся установленным."
    ;;
esac
