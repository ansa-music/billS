#!/usr/bin/env bash
# update.sh — обновление billS HUB до нужного коммита с автоматическим откатом.
# Запуск от root:
#   sudo bills update                       — до origin/main
#   sudo bills update --ref v0.2.0          — до тега/ветки/коммита
#   sudo bills update --force               — обновить, даже если на столах идут игры
#   sudo bills update --rollback            — вернуться на предыдущий релиз
#
# Схема: /opt/bills/repo (git) → /opt/bills/releases/<дата>-<sha> (npm ci + сборка web)
#        → симлинк /opt/bills/current (атомарно) → systemctl restart bills-hub → /api/health.
# При неуспехе health симлинк возвращается на предыдущий релиз (ОТКАТ).
# Журнал обновлений: /var/lib/bills/updates.log

set -Eeuo pipefail
SCRIPT_NAME="update.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

usage() {
  cat <<USAGE
Использование: $0 [--ref <tag|branch|sha>] [--force] [--rollback]
  --ref <x>    целевой коммит: ветка, тег или sha (по умолчанию main = origin/main)
  --force      не останавливаться, если на столах идут игры / не удался бэкап
  --rollback   поменять местами current и previous и перезапустить HUB
USAGE
}

require_root "$@"
require_cmd git node npm curl systemctl
load_env

REF="main"
FORCE=0
ROLLBACK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || die "--ref требует значение"; REF="$2"; shift 2 ;;
    --ref=*) REF="${1#--ref=}"; shift ;;
    --force) FORCE=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
  esac
done

# Не даём запустить два обновления одновременно.
LOCK_FILE="/run/lock/bills-update.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || die "обновление уже выполняется (блокировка $LOCK_FILE)"

PORT="$(hub_port)"

# ---------- Общие шаги ----------
# Перезапуск HUB и ожидание health. Возвращает 0/1.
restart_and_check() {
  log "Перезапуск $HUB_SERVICE ..."
  systemctl restart "$HUB_SERVICE"
  if health_wait "$HEALTH_TIMEOUT"; then
    ok "HUB отвечает на http://127.0.0.1:${PORT}/api/health: $(health_summary)"
    return 0
  fi
  warn "HUB не ответил ok на /api/health за ${HEALTH_TIMEOUT} с"
  return 1
}

# Удаляет старые релизы, оставляя KEEP_RELEASES (current, previous и самые свежие из остальных).
rotate_releases() {
  local cur prev keep=0 d
  cur="$(release_path "$CURRENT_LINK")"
  prev="$(release_path "$PREVIOUS_LINK")"
  [ -d "$RELEASES_DIR" ] || return 0
  # Имена начинаются с даты, поэтому сортировка по имени = по времени (новые первыми).
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    case "$d" in "$RELEASES_DIR"/*) ;; *) continue ;; esac
    if [ "$d" = "$cur" ] || [ "$d" = "$prev" ]; then
      continue
    fi
    keep=$((keep + 1))
    # current + previous + (KEEP_RELEASES - 2) самых свежих из остальных
    if [ "$keep" -gt $((KEEP_RELEASES - 2)) ]; then
      log "Удаляю старый релиз $(basename "$d")"
      rm -rf -- "$d"
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d | sort -r)
}

# ---------- Откат ----------
if [ "$ROLLBACK" -eq 1 ]; then
  cur="$(release_path "$CURRENT_LINK")"
  prev="$(release_path "$PREVIOUS_LINK")"
  [ -n "$prev" ] && [ -d "$prev" ] || die "нет предыдущего релиза ($PREVIOUS_LINK) — откатываться не на что"
  [ -n "$cur" ] || die "нет текущего релиза ($CURRENT_LINK)"
  log "ОТКАТ: $(basename "$cur") → $(basename "$prev")"
  switch_link "$CURRENT_LINK" "$prev"
  switch_link "$PREVIOUS_LINK" "$cur"
  if restart_and_check; then
    ok "ОТКАТ выполнен: текущий релиз $(basename "$prev")"
    log_update "rollback: $(basename "$cur") → $(basename "$prev") — OK"
    exit 0
  fi
  log_update "rollback: $(basename "$cur") → $(basename "$prev") — HUB не ответил на health"
  die "ОТКАТ не помог — HUB не отвечает. Смотрите: journalctl -u $HUB_SERVICE -n 100"
fi

# ---------- Определяем цель ----------
# Зеркало — bare-репозиторий (папки .git внутри нет), поэтому проверяем через git.
[ -d "$REPO_DIR" ] && as_bills git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1   || die "репозиторий $REPO_DIR не найден — сначала запустите install.sh"

log "Получаю изменения из origin ($(as_bills git -C "$REPO_DIR" remote get-url origin)) ..."
as_bills git -C "$REPO_DIR" fetch --quiet --tags --prune origin

# /opt/bills/repo — зеркало (git clone --mirror): refs/heads/* там всегда равны origin после fetch.
# Поэтому "origin/main" и "main" — одно и то же; префикс origin/ просто отбрасываем.
ref_name="${REF#origin/}"
target_sha=""
for candidate in "refs/heads/$ref_name" "refs/tags/$ref_name" "$ref_name"; do
  if target_sha="$(as_bills git -C "$REPO_DIR" rev-parse --verify --quiet "${candidate}^{commit}")" && [ -n "$target_sha" ]; then
    break
  fi
  target_sha=""
done
[ -n "$target_sha" ] || die "не удалось найти коммит для '$REF' (ветка, тег или sha)"
target_short="$(short_sha "$target_sha")"
target_subject="$(as_bills git -C "$REPO_DIR" log -1 --format='%s' "$target_sha")"

current_dir="$(release_path "$CURRENT_LINK")"
current_sha="$(release_sha "$current_dir")"
current_short="$(short_sha "$current_sha")"

log "Текущий релиз: ${current_dir:+$(basename "$current_dir") }(${current_short:-нет})"
log "Целевой коммит: $target_short — $target_subject"

if [ -n "$current_dir" ] && [ "$current_sha" = "$target_sha" ]; then
  ok "HUB уже на коммите $target_short — обновлять нечего."
  exit 0
fi

# ---------- Проверка: идут ли игры ----------
if hub_is_active; then
  games="$(active_games_count)"
  if [ "$games" = "?" ]; then
    warn "не удалось узнать состояние столов (/api/state не ответил)"
  elif [ "$games" != "0" ]; then
    if [ "$FORCE" -eq 1 ]; then
      warn "на столах идут игры (активных столов: $games), но указан --force — продолжаю"
    else
      echo
      warn "Сейчас идут игры: активных столов — $games."
      echo "  Обновление перезапустит HUB примерно на 10 секунд. Игры при этом сохраняются"
      echo "  и время считается дальше, но лучше обновлять, когда столы свободны."
      echo "  Чтобы обновить всё равно: sudo bills update --force"
      exit 1
    fi
  fi
fi

# ---------- Бэкап перед обновлением ----------
if [ -n "$current_dir" ] && [ -f "$current_dir/apps/hub/src/cli.ts" ]; then
  log "Бэкап базы перед обновлением ..."
  mkdir -p "$(backup_dir)"
  chown "$BILLS_USER:$BILLS_USER" "$(backup_dir)"
  if backup_file="$(hub_cli "$current_dir" backup "$(backup_dir)")"; then
    ok "Бэкап: $(printf '%s\n' "$backup_file" | awk 'NF {line=$0} END {print line}')"
  else
    if [ "$FORCE" -eq 1 ]; then
      warn "бэкап не удался, но указан --force — продолжаю без бэкапа"
    else
      die "не удалось сделать бэкап базы — обновление остановлено (чтобы обновить без бэкапа: --force)"
    fi
  fi
else
  log "Текущего релиза нет (первая установка) — бэкап пропущен."
fi

# ---------- Сборка нового релиза ----------
mkdir -p "$RELEASES_DIR"
chown "$BILLS_USER:$BILLS_USER" "$RELEASES_DIR"
release_name="$(timestamp)-$target_short"
release_dir="$RELEASES_DIR/$release_name"
[ ! -e "$release_dir" ] || die "папка релиза уже существует: $release_dir"

cleanup_failed_release() {
  # Удаляем только если на эту папку ещё не указывает current.
  if [ -d "$release_dir" ] && [ "$(release_path "$CURRENT_LINK")" != "$release_dir" ]; then
    rm -rf -- "$release_dir"
  fi
}

log "Создаю релиз $release_name ..."
if ! as_bills git clone --quiet --local --no-checkout "$REPO_DIR" "$release_dir" \
   || ! as_bills git -C "$release_dir" checkout --quiet --detach "$target_sha"; then
  cleanup_failed_release
  log_update "update: ${current_short:-нет} → $target_short — ОШИБКА git checkout"
  die "не удалось получить код релиза $target_short"
fi

log "npm ci (зависимости) ..."
if ! as_bills_in "$release_dir" npm ci --no-audit --no-fund --loglevel=error; then
  cleanup_failed_release
  log_update "update: ${current_short:-нет} → $target_short — ОШИБКА npm ci"
  die "npm ci завершился с ошибкой — релиз $release_name удалён, текущий релиз не тронут"
fi

log "Сборка web-интерфейса (npm run build -w @bills/web) ..."
if ! as_bills_in "$release_dir" npm run build -w @bills/web; then
  cleanup_failed_release
  log_update "update: ${current_short:-нет} → $target_short — ОШИБКА сборки web"
  die "сборка web не удалась — релиз $release_name удалён, текущий релиз не тронут"
fi

[ -f "$release_dir/apps/hub/src/main.ts" ] || { cleanup_failed_release; die "в релизе нет apps/hub/src/main.ts"; }
# Метка релиза (для людей и для HUB_GIT_SHA при желании).
printf 'sha=%s
built=%s
ref=%s
' "$target_sha" "$(date -Is)" "$REF" | as_bills tee "$release_dir/.release" >/dev/null

# ---------- Переключение ----------
log "Переключаю $CURRENT_LINK → $release_name"
if [ -n "$current_dir" ]; then
  switch_link "$PREVIOUS_LINK" "$current_dir"
fi
switch_link "$CURRENT_LINK" "$release_dir"

if restart_and_check; then
  ok "Обновление выполнено: ${current_short:-нет} → $target_short ($target_subject)"
  log_update "update: ${current_short:-нет} → $target_short ($release_name) — OK"
  rotate_releases
  exit 0
fi

# ---------- Health не прошёл — откат ----------
warn "Новый релиз не поднялся. Последние строки журнала:"
journalctl -u "$HUB_SERVICE" -n 30 --no-pager 2>/dev/null || true

if [ -z "$current_dir" ]; then
  log_update "update: нет → $target_short — HUB не ответил на health (откатываться некуда)"
  die "HUB не ответил на /api/health, а предыдущего релиза нет — смотрите: journalctl -u $HUB_SERVICE -n 100"
fi

log "ОТКАТ на $(basename "$current_dir") ..."
switch_link "$CURRENT_LINK" "$current_dir"
switch_link "$PREVIOUS_LINK" "$release_dir"
if restart_and_check; then
  log_update "update: ${current_short} → $target_short — ОТКАТ выполнен (health не прошёл)"
  die "ОТКАТ выполнен: HUB снова на релизе $(basename "$current_dir") ($current_short). Новый релиз $release_name оставлен для разбора. Смотрите: journalctl -u $HUB_SERVICE -n 100"
fi
log_update "update: ${current_short} → $target_short — ОТКАТ НЕ ПОМОГ"
die "ОТКАТ не помог — HUB не отвечает и на старом релизе. Смотрите: journalctl -u $HUB_SERVICE -n 100"
