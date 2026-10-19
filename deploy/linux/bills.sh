#!/usr/bin/env bash
# bills.sh — удобная обёртка для оператора: /usr/local/bin/bills <команда>
#   bills status            состояние сервиса и таймера бэкапов
#   bills logs [-n 200]     логи HUB (по умолчанию «хвост» в реальном времени)
#   bills restart           перезапустить HUB
#   bills update [...]      обновить (см. update.sh --help)
#   bills backup            сделать бэкап сейчас
#   bills restore [файл]    восстановить из бэкапа / показать список
#   bills check [файл]      проверить целостность базы (или файла)
#   bills version           версия HUB (CLI version)
#   bills health            ответ /api/health
#   bills ca init|show      HTTPS: сертификат клуба для планшетов (см. README)

set -Eeuo pipefail
SCRIPT_NAME="bills"
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

usage() {
  cat <<USAGE
Использование: bills <команда> [аргументы]
  status            состояние bills-hub и таймера бэкапов
  logs [-n N]       логи HUB (journalctl -u bills-hub -f)
  restart           перезапустить HUB
  update [...]      обновить до origin/main (--ref, --force, --rollback)
  backup            сделать бэкап базы сейчас
  restore [файл]    восстановить базу из бэкапа (без файла — список)
  check [файл]      PRAGMA integrity_check базы (или указанного файла)
  version           версия HUB
  health            ответ /api/health
  ca init [...]     HTTPS в сети клуба: корневой сертификат + сертификат HUB, порты 443/80, hub.local
  ca show           показать сертификаты
USAGE
}

cmd="${1:-}"
[ -n "$cmd" ] || { usage; exit 1; }
shift

# Почти всё требует root — поднимаемся через sudo один раз.
if [ "$(id -u)" -ne 0 ]; then
  case "$cmd" in
    -h|--help|help) usage; exit 0 ;;
  esac
  exec sudo -- "$0" "$cmd" "$@"
fi

load_env
PORT="$(hub_port)"
current_dir="$(release_path "$CURRENT_LINK")"

case "$cmd" in
  status)
    systemctl status "$HUB_SERVICE" --no-pager --lines=5 || true
    echo
    systemctl list-timers "$BACKUP_TIMER" --no-pager --all || true
    echo
    if [ -n "$current_dir" ]; then
      echo "Текущий релиз:   $(basename "$current_dir") ($(short_sha "$(release_sha "$current_dir")"))"
      prev="$(release_path "$PREVIOUS_LINK")"
      [ -n "$prev" ] && echo "Предыдущий релиз: $(basename "$prev")"
    fi
    if [ -n "${HUB_TLS_CERT:-}" ]; then
      echo "Адрес для планшетов: https://$(primary_ip):${PORT} (или https://hub.local), сертификат: http://$(primary_ip):${HUB_HTTP_PORT:-80}/ca"
    else
      echo "Адрес для планшетов: http://$(primary_ip):${PORT}  (HTTPS: bills ca init)"
    fi
    if health_wait 3; then
      echo "Health: $(health_summary)"
    else
      echo "Health: HUB не отвечает на $(hub_url)/api/health"
    fi
    ;;
  logs)
    if [ $# -eq 0 ]; then
      exec journalctl -u "$HUB_SERVICE" -f -n 100
    fi
    exec journalctl -u "$HUB_SERVICE" "$@"
    ;;
  restart)
    systemctl restart "$HUB_SERVICE"
    if health_wait; then ok "HUB перезапущен: $(health_summary)"; else die "HUB не ответил на /api/health — journalctl -u $HUB_SERVICE -n 100"; fi
    ;;
  update)   exec bash "$SCRIPT_DIR/update.sh" "$@" ;;
  backup)   exec bash "$SCRIPT_DIR/backup.sh" "$@" ;;
  restore)  exec bash "$SCRIPT_DIR/restore.sh" "$@" ;;
  check|version)
    [ -n "$current_dir" ] || die "нет установленного релиза ($CURRENT_LINK)"
    exec_rc=0
    hub_cli "$current_dir" "$cmd" "$@" || exec_rc=$?
    exit "$exec_rc"
    ;;
  ca)
    [ -n "$current_dir" ] || die "нет установленного релиза ($CURRENT_LINK)"
    sub="${1:-}"; shift || true
    tls_dir="$STATE_DIR/tls"
    case "$sub" in
      show)
        hub_cli "$current_dir" ca show "--dir=$tls_dir" "$@"
        ;;
      init)
        https_port=443; http_port=80; cli_args=()
        while [ $# -gt 0 ]; do
          case "$1" in
            --https-port) https_port="$2"; shift 2 ;;
            --http-port)  http_port="$2"; shift 2 ;;
            --ip|--name|--label) cli_args+=("$1=$2"); shift 2 ;;
            *) cli_args+=("$1"); shift ;;
          esac
        done
        # Имя в сети клуба: hub.local (HUB объявляет его сам по mDNS).
        set_env_var HUB_MDNS_NAME "${HUB_MDNS_NAME:-hub}"
        load_env
        lines="$(hub_cli "$current_dir" ca init "--dir=$tls_dir" "${cli_args[@]}")" || die "ca init не удался"
        while IFS= read -r line; do
          case "$line" in HUB_TLS_*=*) set_env_var "${line%%=*}" "${line#*=}" ;; esac
        done <<< "$lines"
        set_env_var HUB_PORT "$https_port"
        set_env_var HUB_HTTP_PORT "$http_port"
        if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
          ufw allow "$https_port/tcp" comment 'TS HUB HTTPS (только LAN)' >/dev/null
          ufw allow "$http_port/tcp" comment 'TS HUB: сертификат и переход на HTTPS' >/dev/null
          ufw allow 5353/udp comment 'TS HUB: имя hub.local (mDNS)' >/dev/null
        fi
        # Службы, поставленные до HTTPS, не умеют занимать порты ниже 1024 — добавляем это право одним файлом.
        dropin="/etc/systemd/system/${HUB_SERVICE}.service.d"
        mkdir -p "$dropin"
        printf '[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n' > "$dropin/https-ports.conf"
        systemctl daemon-reload
        load_env
        PORT="$(hub_port)"
        systemctl restart "$HUB_SERVICE"
        if health_wait; then ok "HUB работает по HTTPS: $(health_summary)"; else die "HUB не ответил на $(hub_url)/api/health — journalctl -u $HUB_SERVICE -n 100"; fi
        ip="$(primary_ip)"
        echo "  Приложение:            https://hub.local$( [ "$https_port" = 443 ] || printf ':%s' "$https_port")/  или  https://${ip}$( [ "$https_port" = 443 ] || printf ':%s' "$https_port")/"
        echo "  Сертификат для планшетов (QR-код — на странице «Оборудование»):"
        echo "                         http://${ip}$( [ "$http_port" = 80 ] || printf ':%s' "$http_port")/ca"
        echo "  Сменился IP сервера — выполните bills ca init ещё раз: корневой сертификат останется прежним."
        ;;
      *) die "bills ca init [--https-port 443] [--http-port 80] [--ip a,b] [--force] | bills ca show" ;;
    esac
    ;;
  health)
    body="$(hub_curl -fsS --max-time 5 "$(hub_url)/api/health")" \
      || die "HUB не отвечает на $(hub_url)/api/health (systemctl status $HUB_SERVICE)"
    printf '%s' "$body" | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        let h;
        try { h = JSON.parse(raw); } catch { console.log(raw); return; }
        const gb = (b) => (b === null || b === undefined ? "?" : (b / 1e9).toFixed(1) + " ГБ");
        const hours = Math.floor((h.uptimeSeconds ?? 0) / 3600), mins = Math.floor(((h.uptimeSeconds ?? 0) % 3600) / 60);
        const backup = h.lastBackupAt ? new Date(h.lastBackupAt).toLocaleString("ru-RU") : "ЕЩЁ НЕ БЫЛО";
        const ageH = h.lastBackupAt ? (Date.now() - h.lastBackupAt) / 36e5 : Infinity;
        const c = h.counters ?? {};
        console.log(`HUB ${h.ok ? "работает" : "НЕ В ПОРЯДКЕ"}: версия ${h.version ?? "?"}${h.gitSha ? " (git " + String(h.gitSha).slice(0, 7) + ")" : ""}, аптайм ${hours} ч ${mins} мин`);
        console.log(`Последний бэкап: ${backup}${ageH > 36 ? "  <-- СТАРШЕ 36 ЧАСОВ, проверьте таймер" : ""}`);
        console.log(`Свободно на диске: ${gb(h.freeDiskBytes)}${h.freeDiskBytes !== null && h.freeDiskBytes < 2e9 ? "  <-- МАЛО МЕСТА" : ""}, база ${((h.dbSizeBytes ?? 0) / 1e6).toFixed(1)} МБ`);
        console.log(`Игр идёт: ${c.sessionsActive ?? "?"}, ждут оплаты: ${c.sessionsUnpaid ?? "?"}, тревог открыто: ${c.alertsOpen ?? "?"}, команд лампам в очереди: ${c.lampCommandsPending ?? "?"}`);
        console.log("");
        console.log(JSON.stringify(h, null, 2));
      });
    '
    ;;
  -h|--help|help) usage ;;
  *) die "неизвестная команда: $cmd (bills --help)" ;;
esac
