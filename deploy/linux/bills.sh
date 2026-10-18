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
    echo "Адрес для планшетов: http://$(primary_ip):${PORT}"
    if health_wait 3; then
      echo "Health: $(health_summary)"
    else
      echo "Health: HUB не отвечает на http://127.0.0.1:${PORT}/api/health"
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
  health)
    body="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health")" \
      || die "HUB не отвечает на http://127.0.0.1:${PORT}/api/health (systemctl status $HUB_SERVICE)"
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
