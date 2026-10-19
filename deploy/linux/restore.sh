#!/usr/bin/env bash
# restore.sh — восстановление базы TS HUB (или базы облака) из резервной копии.
# Запуск от root:
#   sudo bills restore                         — показать последние бэкапы HUB
#   sudo bills restore <файл.db|файл.db.gz>    — восстановить HUB (спросит подтверждение)
#   sudo bills restore <файл> --yes            — без вопросов
#   sudo bills restore --cloud                 — показать последние бэкапы облака (cloud-*.db.gz)
#   sudo bills restore --cloud <файл> [--yes]  — восстановить базу облака
#
# Что делает: останавливает bills-hub (или bills-cloud), при .gz распаковывает во временный файл,
# вызывает `node apps/hub/src/cli.ts restore <файл> --yes` (или apps/cloud/src/cli.ts) от bills
# (CLI проверяет целостность, старую базу сохраняет рядом с пометкой before-restore),
# запускает сервис и ждёт /api/health.

set -Eeuo pipefail
SCRIPT_NAME="restore.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

usage() {
  cat <<USAGE
Использование: $0 [--cloud] [<файл.db|файл.db.gz>] [--yes]
  без аргументов  — список последних бэкапов в $(backup_dir)
  --cloud         — восстанавливать базу облака (bills-cloud), а не HUB
  --yes           — не спрашивать подтверждение
USAGE
}

require_root "$@"
load_env

SRC=""
ASSUME_YES=0
MODE="hub"
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --cloud) MODE="cloud" ;;
    -h|--help) usage; exit 0 ;;
    -*) die "неизвестный параметр: $arg" ;;
    *) [ -z "$SRC" ] || die "укажите только один файл"; SRC="$arg" ;;
  esac
done

BACKUPS="$(backup_dir)"

# ---------- Что восстанавливаем: HUB или облако ----------
if [ "$MODE" = "cloud" ]; then
  cloud_enabled || die "облако на этом мини-ПК не включено ($CLOUD_ENV_FILE нет) — восстанавливать нечего"
  PREFIX="cloud"
  SERVICE="$CLOUD_SERVICE"
  WHAT="облака"
  CLI_REL="apps/cloud/src/cli.ts"
  DB_PATH="$(env_value "$CLOUD_ENV_FILE" CLOUD_DB_PATH "$STATE_DIR/cloud.db")"
  LIST_HINT="sudo bills restore --cloud"
else
  PREFIX="hub"
  SERVICE="$HUB_SERVICE"
  WHAT="HUB"
  CLI_REL="apps/hub/src/cli.ts"
  DB_PATH="${HUB_DB_PATH:-$STATE_DIR/hub.db}"
  LIST_HINT="sudo bills restore"
fi

run_cli() {
  if [ "$MODE" = "cloud" ]; then cloud_cli "$@"; else hub_cli "$@"; fi
}
wait_health() {
  if [ "$MODE" = "cloud" ]; then
    cloud_health_wait && HEALTH_BODY="$CLOUD_HEALTH_BODY"
  else
    health_wait
  fi
}

# ---------- Без файла — показать список ----------
if [ -z "$SRC" ]; then
  log "Последние бэкапы $WHAT в $BACKUPS:"
  if [ -d "$BACKUPS" ] && ls "$BACKUPS"/"$PREFIX"-*.db* >/dev/null 2>&1; then
    ls -lt --time-style='+%Y-%m-%d %H:%M' "$BACKUPS"/"$PREFIX"-*.db* | head -n 15 \
      | awk '{printf "  %s %s  %8s  %s\n", $6, $7, $5, $8}'
  else
    echo "  (бэкапов нет)"
  fi
  echo
  echo "Восстановить: $LIST_HINT $BACKUPS/<файл>"
  exit 0
fi

# Файл можно указать именем внутри папки бэкапов.
if [ ! -f "$SRC" ] && [ -f "$BACKUPS/$SRC" ]; then
  SRC="$BACKUPS/$SRC"
fi
[ -f "$SRC" ] || die "файл не найден: $SRC"
SRC="$(readlink -f -- "$SRC")"
case "$(basename "$SRC")" in
  "$PREFIX"-*) ;;
  hub-*|cloud-*) die "файл $(basename "$SRC") — это бэкап другой базы (не $WHAT). Для облака: --cloud, для HUB — без --cloud" ;;
esac

RELEASE_DIR="$(release_path "$CURRENT_LINK")"
[ -n "$RELEASE_DIR" ] && [ -f "$RELEASE_DIR/$CLI_REL" ] \
  || die "не найден текущий релиз ($CURRENT_LINK) или в нём нет $CLI_REL — сначала установите TS"

games="?"
if [ "$MODE" = "hub" ] && hub_is_active; then
  games="$(active_games_count)"
fi

# ---------- Предупреждение и подтверждение ----------
echo
warn "Восстановление базы $WHAT из бэкапа ЗАМЕНИТ текущую базу $DB_PATH."
if [ "$MODE" = "cloud" ]; then
  echo "  Всё, что попало в облако ПОСЛЕ создания этого бэкапа (события клубов, новые клубы, ключи HUB,"
  echo "  пароли и пользователи кабинета), пропадёт из облака. Данные на HUB самих клубов не трогаются."
  echo "  Клубы, добавленные после бэкапа, придётся добавить и подключить заново (bills cloud add-club)."
else
  echo "  Все игры, смены и события, записанные ПОСЛЕ создания этого бэкапа, будут потеряны."
fi
echo "  Текущая база будет сохранена рядом с пометкой before-restore-<штамп> (можно вернуть)."
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
if systemctl is-active --quiet "$SERVICE"; then
  log "Останавливаю $SERVICE ..."
  systemctl stop "$SERVICE"
fi

restore_rc=0
log "Восстановление через CLI ..."
run_cli "$RELEASE_DIR" restore "$RESTORE_FILE" --yes || restore_rc=$?

# Права на файлы базы (на случай, если что-то создалось от root).
chown -R "$BILLS_USER:$BILLS_USER" "$STATE_DIR" 2>/dev/null || true

log "Запускаю $SERVICE ..."
systemctl start "$SERVICE"

if [ "$restore_rc" -ne 0 ]; then
  log_update "restore $PREFIX: из $SRC — ОШИБКА CLI (код $restore_rc)"
  die "CLI restore завершился с кодом $restore_rc — база НЕ заменена (см. вывод выше). $SERVICE запущен заново."
fi

if wait_health; then
  ok "База $WHAT восстановлена из $SRC. Сервис работает: $(health_summary)"
  log "Прежняя база сохранена рядом с $DB_PATH (пометка before-restore) в $(dirname "$DB_PATH")"
  log_update "restore $PREFIX: из $SRC — OK"
else
  log_update "restore $PREFIX: из $SRC — $SERVICE не ответил на /api/health"
  die "база восстановлена, но $SERVICE не отвечает на /api/health за ${HEALTH_TIMEOUT} с — смотрите: journalctl -u $SERVICE -n 100"
fi
