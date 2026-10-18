#!/usr/bin/env bash
# restore.sh — восстановление базы billS HUB из резервной копии.
# Запуск от root:
#   sudo bills restore                         — показать последние бэкапы
#   sudo bills restore <файл.db|файл.db.gz>    — восстановить (спросит подтверждение)
#   sudo bills restore <файл> --yes            — без вопросов
#
# Что делает: останавливает bills-hub, при .gz распаковывает во временный файл,
# вызывает `node apps/hub/src/cli.ts restore <файл> --yes` от bills (CLI проверяет
# целостность, старую базу переименовывает в hub.db.before-restore-<штамп>),
# запускает HUB и ждёт /api/health.

set -Eeuo pipefail
SCRIPT_NAME="restore.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

usage() {
  cat <<USAGE
Использование: $0 [<файл.db|файл.db.gz>] [--yes]
  без аргументов  — список последних бэкапов в $(backup_dir)
  --yes           — не спрашивать подтверждение
USAGE
}

require_root "$@"
load_env

SRC=""
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "неизвестный параметр: $arg" ;;
    *) [ -z "$SRC" ] || die "укажите только один файл"; SRC="$arg" ;;
  esac
done

BACKUPS="$(backup_dir)"

# ---------- Без файла — показать список ----------
if [ -z "$SRC" ]; then
  log "Последние бэкапы в $BACKUPS:"
  if [ -d "$BACKUPS" ] && ls "$BACKUPS"/hub-*.db* >/dev/null 2>&1; then
    ls -lt --time-style='+%Y-%m-%d %H:%M' "$BACKUPS"/hub-*.db* | head -n 15 \
      | awk '{printf "  %s %s  %8s  %s\n", $6, $7, $5, $8}'
  else
    echo "  (бэкапов нет)"
  fi
  echo
  echo "Восстановить: sudo bills restore $BACKUPS/<файл>"
  exit 0
fi

# Файл можно указать именем внутри папки бэкапов.
if [ ! -f "$SRC" ] && [ -f "$BACKUPS/$SRC" ]; then
  SRC="$BACKUPS/$SRC"
fi
[ -f "$SRC" ] || die "файл не найден: $SRC"
SRC="$(readlink -f -- "$SRC")"

RELEASE_DIR="$(release_path "$CURRENT_LINK")"
[ -n "$RELEASE_DIR" ] && [ -f "$RELEASE_DIR/apps/hub/src/cli.ts" ] \
  || die "не найден текущий релиз ($CURRENT_LINK) — сначала установите HUB"

DB_PATH="${HUB_DB_PATH:-$STATE_DIR/hub.db}"
games="?"
if hub_is_active; then
  games="$(active_games_count)"
fi

# ---------- Предупреждение и подтверждение ----------
echo
warn "Восстановление базы из бэкапа ЗАМЕНИТ текущую базу $DB_PATH."
echo "  Все игры, смены и события, записанные ПОСЛЕ создания этого бэкапа, будут потеряны."
echo "  Текущая база будет сохранена рядом как hub.db.before-restore-<штамп> (можно вернуть)."
echo "  Файл бэкапа: $SRC ($(du -h "$SRC" | cut -f1), $(date -r "$SRC" '+%Y-%m-%d %H:%M'))"
if [ "$games" != "0" ] && [ "$games" != "?" ]; then
  echo "  СЕЙЧАС ИДУТ ИГРЫ: активных столов — $games. HUB будет остановлен."
fi
echo
if [ "$ASSUME_YES" -ne 1 ]; then
  if [ ! -t 0 ]; then
    die "нет терминала для подтверждения — запустите с --yes"
  fi
  read -r -p "Продолжить? Введите «да» или «yes»: " answer
  case "$answer" in
    да|ДА|Да|yes|YES|Yes) ;;
    *) log "Отменено."; exit 0 ;;
  esac
fi

# ---------- Подготовка файла ----------
TMP_FILE=""
cleanup() {
  if [ -n "$TMP_FILE" ]; then rm -f -- "$TMP_FILE"; fi
}
trap cleanup EXIT

RESTORE_FILE="$SRC"
case "$SRC" in
  *.gz)
    TMP_FILE="$(mktemp "$STATE_DIR/restore-XXXXXX.db")"
    log "Распаковка $SRC → $TMP_FILE"
    gzip -dc -- "$SRC" >"$TMP_FILE"
    RESTORE_FILE="$TMP_FILE"
    ;;
esac
# CLI запускается от bills — файл должен ему читаться; если нет — копируем в /var/lib/bills.
if ! as_bills test -r "$RESTORE_FILE"; then
  tmp2="$(mktemp "$STATE_DIR/restore-XXXXXX.db")"
  cp -f -- "$RESTORE_FILE" "$tmp2"
  if [ -n "$TMP_FILE" ]; then rm -f -- "$TMP_FILE"; fi
  TMP_FILE="$tmp2"
  RESTORE_FILE="$TMP_FILE"
fi
if [ -n "$TMP_FILE" ]; then
  chown "$BILLS_USER:$BILLS_USER" -- "$TMP_FILE"
  chmod 640 -- "$TMP_FILE"
fi

# ---------- Остановка, восстановление, запуск ----------
if hub_is_active; then
  log "Останавливаю $HUB_SERVICE ..."
  systemctl stop "$HUB_SERVICE"
fi

restore_rc=0
log "Восстановление через CLI ..."
hub_cli "$RELEASE_DIR" restore "$RESTORE_FILE" --yes || restore_rc=$?

# Права на файлы базы (на случай, если что-то создалось от root).
chown -R "$BILLS_USER:$BILLS_USER" "$STATE_DIR" 2>/dev/null || true

log "Запускаю $HUB_SERVICE ..."
systemctl start "$HUB_SERVICE"

if [ "$restore_rc" -ne 0 ]; then
  log_update "restore: из $SRC — ОШИБКА CLI (код $restore_rc)"
  die "CLI restore завершился с кодом $restore_rc — база НЕ заменена (см. вывод выше). HUB запущен заново."
fi

if health_wait; then
  ok "База восстановлена из $SRC. HUB работает: $(health_summary)"
  log "Прежняя база сохранена как ${DB_PATH}.before-restore-<штамп> в $(dirname "$DB_PATH")"
  log_update "restore: из $SRC — OK"
else
  log_update "restore: из $SRC — HUB не ответил на /api/health"
  die "база восстановлена, но HUB не отвечает на /api/health за ${HEALTH_TIMEOUT} с — смотрите: journalctl -u $HUB_SERVICE -n 100"
fi
