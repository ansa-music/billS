#!/usr/bin/env bash
# backup.sh — резервная копия базы TS HUB (и базы облака, если оно включено на этом мини-ПК).
# Запускается таймером bills-backup.timer от пользователя bills (окружение из EnvironmentFile),
# либо вручную: sudo bills backup   или   sudo /opt/bills/bin/backup.sh
#
# Что делает:
#   1. node apps/hub/src/cli.ts backup <BACKUP_DIR>  — консистентная копия (VACUUM INTO) + integrity_check
#   2. gzip копии
#   3. ротация: удаляет hub-*.db.gz старше BACKUP_KEEP_DAYS дней
#   4. если задан BACKUP_RCLONE_REMOTE и установлен rclone — выгружает копию и чистит старые в облаке
#   5. если задан BACKUP_SECOND_DIR и диск примонтирован — копирует туда и чистит старые
#   6. если облако включено (есть /etc/bills/cloud.env) — то же самое для базы облака:
#      node apps/cloud/src/cli.ts backup <BACKUP_DIR> с переменными из cloud.env → cloud-*.db.gz,
#      та же ротация, rclone и второй диск. Ошибка облака не отменяет копию HUB, но даёт «failed».
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

# ---------- Общие шаги для одной копии (HUB или облако) ----------
# finish_copy <файл.db> <префикс hub|cloud>
#   gzip → локальная ротация <префикс>-*.db.gz → rclone → второй диск.
# Печатает предупреждения и увеличивает errors; код 1 — только если копию не удалось сжать.
# (Функция вызывается в if, где set -e не действует, — поэтому проверки явные.)
finish_copy() {
  local db_copy="$1" prefix="$2" gz_file removed
  gzip -f -- "$db_copy" || { warn "gzip $db_copy не удался"; return 1; }
  gz_file="${db_copy}.gz"
  [ -f "$gz_file" ] || { warn "после gzip не найден файл $gz_file"; return 1; }
  ok "Сжато: $gz_file ($(du -h "$gz_file" | cut -f1))"
  LAST_GZ="$gz_file"

  # Локальная ротация
  removed="$(find "$DEST_DIR" -maxdepth 1 -type f -name "${prefix}-*.db.gz" -mtime +"$KEEP_DAYS" -print -delete | wc -l)"
  [ "$removed" -gt 0 ] && log "Удалено старых локальных копий ${prefix}-*: $removed"
  # Несжатые .db, оставшиеся от прерванных запусков, старше суток — тоже убираем.
  find "$DEST_DIR" -maxdepth 1 -type f -name "${prefix}-*.db" -mtime +1 -delete 2>/dev/null || true

  # rclone (облачное хранилище)
  if [ -n "$RCLONE_REMOTE" ]; then
    if command -v rclone >/dev/null 2>&1; then
      log "Выгрузка в $RCLONE_REMOTE ..."
      if rclone copy --quiet -- "$gz_file" "$RCLONE_REMOTE"; then
        ok "Выгружено в облако: $RCLONE_REMOTE/$(basename "$gz_file")"
        if ! rclone delete --quiet --min-age "${KEEP_DAYS}d" --include "${prefix}-*.db.gz" -- "$RCLONE_REMOTE"; then
          warn "не удалось почистить старые копии ${prefix}-* в $RCLONE_REMOTE"
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

  # Второй диск / USB
  if [ -n "$SECOND_DIR" ]; then
    # Защита от записи на корневой диск, когда USB не воткнут: папка должна быть на другой ФС, чем BACKUP_DIR.
    if [ -d "$SECOND_DIR" ] && [ -w "$SECOND_DIR" ] \
       && [ "$(findmnt -n -o TARGET -T "$SECOND_DIR" 2>/dev/null)" != "$(findmnt -n -o TARGET -T "$DEST_DIR" 2>/dev/null)" ]; then
      if cp -f -- "$gz_file" "$SECOND_DIR/"; then
        ok "Копия на втором диске: $SECOND_DIR/$(basename "$gz_file")"
        find "$SECOND_DIR" -maxdepth 1 -type f -name "${prefix}-*.db.gz" -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
      else
        warn "не удалось скопировать на второй диск $SECOND_DIR"
        errors=$((errors + 1))
      fi
    else
      warn "второй диск $SECOND_DIR не примонтирован или недоступен для записи — копия ${prefix}-* на него пропущена"
    fi
  fi
  return 0
}

# Последняя непустая строка вывода CLI — путь созданного файла.
last_line() { printf '%s\n' "$1" | awk 'NF {line=$0} END {print line}'; }

# ---------- 1. HUB: копия через CLI ----------
cd "$RELEASE_DIR"
cli_out="$(node apps/hub/src/cli.ts backup "$DEST_DIR")" \
  || die "CLI backup завершился с ошибкой (см. вывод выше)"
db_copy="$(last_line "$cli_out")"
[ -n "$db_copy" ] && [ -f "$db_copy" ] || die "CLI не вернул путь к файлу копии (вывод: $cli_out)"
log "Копия создана: $db_copy ($(du -h "$db_copy" | cut -f1))"

# ---------- 2–5. gzip, ротация, rclone, второй диск ----------
LAST_GZ=""
finish_copy "$db_copy" hub || die "не удалось сжать копию базы HUB"

# ---------- 6. Облако (если включено на этом мини-ПК) ----------
if cloud_enabled; then
  log "Облако включено ($CLOUD_ENV_FILE) — бэкап базы облака → $DEST_DIR"
  if [ ! -f "$RELEASE_DIR/apps/cloud/src/cli.ts" ]; then
    warn "в текущем релизе нет apps/cloud/src/cli.ts — бэкап облака пропущен (обновите: sudo bills update)"
    errors=$((errors + 1))
  # Переменные облака читаем в подоболочке, чтобы они не смешались с hub.env этого скрипта.
  elif cloud_out="$(
         set -a
         # shellcheck disable=SC1090
         . "$CLOUD_ENV_FILE"
         set +a
         cd "$RELEASE_DIR" && node apps/cloud/src/cli.ts backup "$DEST_DIR"
       )"; then
    cloud_copy="$(last_line "$cloud_out")"
    if [ -n "$cloud_copy" ] && [ -f "$cloud_copy" ]; then
      log "Копия облака создана: $cloud_copy ($(du -h "$cloud_copy" | cut -f1))"
      if ! finish_copy "$cloud_copy" cloud; then
        warn "не удалось сжать копию базы облака"
        errors=$((errors + 1))
      fi
    else
      warn "cloud CLI не вернул путь к файлу копии (вывод: $cloud_out)"
      errors=$((errors + 1))
    fi
  else
    warn "cloud CLI backup завершился с ошибкой (см. вывод выше) — копия HUB при этом сделана"
    errors=$((errors + 1))
  fi
fi

# ---------- Итог ----------
total="$(find "$DEST_DIR" -maxdepth 1 -type f -name 'hub-*.db.gz' | wc -l)"
if cloud_enabled; then
  total_cloud="$(find "$DEST_DIR" -maxdepth 1 -type f -name 'cloud-*.db.gz' | wc -l)"
  log "Готово. Локальных копий: HUB — $total, облако — $total_cloud. Начато: $started, завершено: $(date '+%Y-%m-%d %H:%M:%S')"
else
  log "Готово. Локальных копий: $total. Начато: $started, завершено: $(date '+%Y-%m-%d %H:%M:%S')"
fi
if [ "$errors" -gt 0 ]; then
  die "бэкап создан локально, но были ошибки ($errors) — см. предупреждения выше"
fi
