#!/usr/bin/env bash
# backup.sh — резервная копия базы TS HUB.
# Запускается таймером bills-backup.timer от пользователя bills (окружение из EnvironmentFile),
# либо вручную: sudo bills backup   или   sudo /opt/bills/bin/backup.sh
#
# Что делает:
#   1. node apps/hub/src/cli.ts backup <BACKUP_DIR>  — консистентная копия (VACUUM INTO) + integrity_check
#   2. gzip копии
#   3. ротация: удаляет hub-*.db.gz старше BACKUP_KEEP_DAYS дней
#   4. если задан BACKUP_RCLONE_REMOTE и установлен rclone — выгружает копию и чистит старые в облаке
#   5. если задан BACKUP_SECOND_DIR и диск примонтирован — копирует туда и чистит старые
# Код выхода ненулевой при любой ошибке, чтобы systemd показал «failed».

set -Eeuo pipefail
SCRIPT_NAME="backup.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

# От root — перезапускаемся от bills (так и таймер, и ручной запуск работают одинаково).
if [ "$(id -u)" -eq 0 ]; then
  exec sudo -u "$BILLS_USER" -H -- bash "$SCRIPT_DIR/backup.sh" "$@"
fi
[ "$(id -un)" = "$BILLS_USER" ] || die "backup.sh должен запускаться от root или от пользователя $BILLS_USER"

# При ручном запуске переменных из systemd нет — читаем hub.env сами.
if [ -z "${HUB_DB_PATH:-}" ]; then
  load_env
fi

RELEASE_DIR="$(release_path "$CURRENT_LINK")"
[ -n "$RELEASE_DIR" ] && [ -f "$RELEASE_DIR/apps/hub/src/cli.ts" ] \
  || die "не найден текущий релиз ($CURRENT_LINK) или в нём нет apps/hub/src/cli.ts"

DEST_DIR="$(backup_dir)"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
case "$KEEP_DAYS" in
  ''|*[!0-9]*) die "BACKUP_KEEP_DAYS должно быть целым числом дней, сейчас: '$KEEP_DAYS'" ;;
esac
RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"
SECOND_DIR="${BACKUP_SECOND_DIR:-}"

mkdir -p "$DEST_DIR"
[ -w "$DEST_DIR" ] || die "нет прав на запись в папку бэкапов $DEST_DIR"

errors=0
started="$(date '+%Y-%m-%d %H:%M:%S')"
log "Бэкап базы HUB → $DEST_DIR (хранить $KEEP_DAYS дн.)"

# ---------- 1. Копия через CLI ----------
cd "$RELEASE_DIR"
cli_out="$(node apps/hub/src/cli.ts backup "$DEST_DIR")" \
  || die "CLI backup завершился с ошибкой (см. вывод выше)"
# CLI печатает путь созданного файла в stdout — берём последнюю непустую строку.
db_copy="$(printf '%s\n' "$cli_out" | awk 'NF {line=$0} END {print line}')"
[ -n "$db_copy" ] && [ -f "$db_copy" ] || die "CLI не вернул путь к файлу копии (вывод: $cli_out)"
log "Копия создана: $db_copy ($(du -h "$db_copy" | cut -f1))"

# ---------- 2. gzip ----------
gzip -f -- "$db_copy"
gz_file="${db_copy}.gz"
[ -f "$gz_file" ] || die "после gzip не найден файл $gz_file"
ok "Сжато: $gz_file ($(du -h "$gz_file" | cut -f1))"

# ---------- 3. Локальная ротация ----------
removed="$(find "$DEST_DIR" -maxdepth 1 -type f -name 'hub-*.db.gz' -mtime +"$KEEP_DAYS" -print -delete | wc -l)"
[ "$removed" -gt 0 ] && log "Удалено старых локальных копий: $removed"
# Несжатые .db, оставшиеся от прерванных запусков, старше суток — тоже убираем.
find "$DEST_DIR" -maxdepth 1 -type f -name 'hub-*.db' -mtime +1 -delete 2>/dev/null || true

# ---------- 4. rclone (облако) ----------
if [ -n "$RCLONE_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    log "Выгрузка в $RCLONE_REMOTE ..."
    if rclone copy --quiet -- "$gz_file" "$RCLONE_REMOTE"; then
      ok "Выгружено в облако: $RCLONE_REMOTE/$(basename "$gz_file")"
      if ! rclone delete --quiet --min-age "${KEEP_DAYS}d" --include 'hub-*.db.gz' -- "$RCLONE_REMOTE"; then
        warn "не удалось почистить старые копии в $RCLONE_REMOTE"
        errors=$((errors + 1))
      fi
    else
      warn "rclone copy в $RCLONE_REMOTE не удался (проверьте: sudo -u bills -H rclone lsd ${RCLONE_REMOTE%%:*}:)"
      errors=$((errors + 1))
    fi
  else
    warn "задан BACKUP_RCLONE_REMOTE, но rclone не установлен (sudo apt install rclone)"
    errors=$((errors + 1))
  fi
fi

# ---------- 5. Второй диск / USB ----------
if [ -n "$SECOND_DIR" ]; then
  # Защита от записи на корневой диск, когда USB не воткнут: папка должна быть на другой ФС, чем BACKUP_DIR.
  if [ -d "$SECOND_DIR" ] && [ -w "$SECOND_DIR" ] \
     && [ "$(findmnt -n -o TARGET -T "$SECOND_DIR" 2>/dev/null)" != "$(findmnt -n -o TARGET -T "$DEST_DIR" 2>/dev/null)" ]; then
    if cp -f -- "$gz_file" "$SECOND_DIR/"; then
      ok "Копия на втором диске: $SECOND_DIR/$(basename "$gz_file")"
      find "$SECOND_DIR" -maxdepth 1 -type f -name 'hub-*.db.gz' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
    else
      warn "не удалось скопировать на второй диск $SECOND_DIR"
      errors=$((errors + 1))
    fi
  else
    warn "второй диск $SECOND_DIR не примонтирован или недоступен для записи — копия на него пропущена"
  fi
fi

# ---------- Итог ----------
total="$(find "$DEST_DIR" -maxdepth 1 -type f -name 'hub-*.db.gz' | wc -l)"
log "Готово. Локальных копий: $total. Начато: $started, завершено: $(date '+%Y-%m-%d %H:%M:%S')"
if [ "$errors" -gt 0 ]; then
  die "бэкап создан локально, но были ошибки ($errors) — см. предупреждения выше"
fi
