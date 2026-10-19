#!/usr/bin/env bash
# lib.sh — общие функции для скриптов развёртывания TS HUB (Linux).
# Подключается так: source "$(dirname "$0")/lib.sh"
# Сам по себе не запускается.

# ---------- Пути и константы (можно переопределить переменными окружения) ----------
BILLS_USER="${BILLS_USER:-bills}"
BILLS_HOME="${BILLS_HOME:-/opt/bills}"
BIN_DIR="${BIN_DIR:-$BILLS_HOME/bin}"
REPO_DIR="${REPO_DIR:-$BILLS_HOME/repo}"
RELEASES_DIR="${RELEASES_DIR:-$BILLS_HOME/releases}"
CURRENT_LINK="${CURRENT_LINK:-$BILLS_HOME/current}"
PREVIOUS_LINK="${PREVIOUS_LINK:-$BILLS_HOME/previous}"
STATE_DIR="${STATE_DIR:-/var/lib/bills}"
ENV_DIR="${ENV_DIR:-/etc/bills}"
ENV_FILE="${ENV_FILE:-$ENV_DIR/hub.env}"
UPDATES_LOG="${UPDATES_LOG:-$STATE_DIR/updates.log}"
HUB_SERVICE="${HUB_SERVICE:-bills-hub}"
BACKUP_TIMER="${BACKUP_TIMER:-bills-backup.timer}"
BILLS_REPO="${BILLS_REPO:-https://github.com/ansa-music/billS.git}"
DEFAULT_PORT=4310
KEEP_RELEASES="${KEEP_RELEASES:-3}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

# Облако TS на этом же мини-ПК (бесплатный режим). Наличие cloud.env = «облако включено».
CLOUD_ENV_FILE="${CLOUD_ENV_FILE:-$ENV_DIR/cloud.env}"
CLOUD_SERVICE="${CLOUD_SERVICE:-bills-cloud}"
DEFAULT_CLOUD_PORT=4320

# ---------- Вывод ----------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_INFO=$'\033[1;34m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_OFF=''
fi

log()  { printf '%s[TS]%s %s\n' "$C_INFO" "$C_OFF" "$*"; }
ok()   { printf '%s[TS]%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%s[TS] ВНИМАНИЕ:%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '%s[TS] ОШИБКА:%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit "${2:-1}"; }

# Обработчик ошибок для set -E: печатает, где именно упал скрипт.
on_error() {
  local exit_code=$? line="${1:-?}" cmd="${2:-?}"
  printf '%s[TS] ОШИБКА:%s %s прерван (строка %s, код %s): %s\n' \
    "$C_ERR" "$C_OFF" "${SCRIPT_NAME:-скрипт}" "$line" "$exit_code" "$cmd" >&2
  exit "$exit_code"
}
# Использование в скрипте: trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

# ---------- Проверки ----------
require_root() {
  [ "$(id -u)" -eq 0 ] || die "запустите от root: sudo $0 $*"
}

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "не найдена команда '$c'"
  done
}

# ---------- Окружение HUB ----------
# Загружает /etc/bills/hub.env в текущее окружение (если файл есть и читается).
load_env() {
  if [ -r "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
}

# Порт HUB: из окружения (после load_env) или по умолчанию.
hub_port() { printf '%s' "${HUB_PORT:-$DEFAULT_PORT}"; }

# Папка бэкапов: из окружения или по умолчанию.
backup_dir() { printf '%s' "${BACKUP_DIR:-$STATE_DIR/backups}"; }

# ---------- Запуск от имени пользователя bills ----------
# as_bills <команда...>  — выполняет команду от bills (через sudo, если мы root).
as_bills() {
  if [ "$(id -un)" = "$BILLS_USER" ]; then
    HOME="$BILLS_HOME" "$@"
  elif [ "$(id -u)" -eq 0 ]; then
    sudo -u "$BILLS_USER" -H -- "$@"
  else
    die "эту команду нужно запускать от root или от пользователя $BILLS_USER"
  fi
}

# as_bills_in <папка> <команда...> — то же, но с переходом в папку.
as_bills_in() {
  local dir="$1"; shift
  as_bills bash -c 'cd "$1" || exit 1; shift; exec "$@"' _ "$dir" "$@"
}

# hub_cli <папка релиза> <аргументы CLI...>
# Запускает `node apps/hub/src/cli.ts ...` от bills с переменными из hub.env.
hub_cli() {
  local dir="$1"; shift
  as_bills bash -c '
    set -a
    [ -r "$1" ] && . "$1"
    set +a
    cd "$2" || exit 1
    shift 2
    exec node apps/hub/src/cli.ts "$@"
  ' _ "$ENV_FILE" "$dir" "$@"
}

# ---------- Релизы ----------
# Реальный путь релиза по симлинку (пусто, если симлинка нет).
release_path() {
  local link="$1"
  [ -L "$link" ] && readlink -f -- "$link" || true
}

# Коммит (sha) релиза по папке.
release_sha() {
  local dir="$1"
  [ -n "$dir" ] && [ -d "$dir/.git" ] || { printf 'unknown'; return 0; }
  as_bills git -C "$dir" rev-parse HEAD 2>/dev/null || printf 'unknown'
}

short_sha() { printf '%s' "${1:0:7}"; }

# Атомарно переключить симлинк на новую цель: ln на временное имя + mv -T.
switch_link() {
  local link="$1" target="$2" tmp
  tmp="${link}.tmp.$$"
  ln -sfn -- "$target" "$tmp"
  mv -T -- "$tmp" "$link"
}

# ---------- Состояние HUB ----------
hub_is_active() { systemctl is-active --quiet "$HUB_SERVICE"; }

# Количество столов с активной игрой по /api/state. Печатает число или "?" при ошибке.
active_games_count() {
  local port json
  port="$(hub_port)"
  json="$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/api/state" 2>/dev/null)" || { printf '?'; return 0; }
  printf '%s' "$json" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const s = JSON.parse(raw);
        const tables = Array.isArray(s.tables) ? s.tables : [];
        console.log(tables.filter((t) => t && t.session).length);
      } catch { console.log("?"); }
    });
  ' 2>/dev/null || printf '?'
}

# Ждать, пока /api/health ответит ok:true. health_wait [таймаут_сек]. Код 0/1.
health_wait() {
  local timeout="${1:-$HEALTH_TIMEOUT}" port body i
  port="$(hub_port)"
  for ((i = 0; i < timeout; i++)); do
    if body="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/api/health" 2>/dev/null)" \
       && printf '%s' "$body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
      HEALTH_BODY="$body"
      return 0
    fi
    sleep 1
  done
  HEALTH_BODY=""
  return 1
}

# Краткое описание из ответа health (версия, git sha), если они там есть.
health_summary() {
  local body="${1:-${HEALTH_BODY:-}}"
  [ -n "$body" ] || { printf 'нет ответа'; return 0; }
  printf '%s' "$body" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const h = JSON.parse(raw);
        const parts = [];
        if (h.version) parts.push("версия " + h.version);
        if (h.gitSha) parts.push("git " + String(h.gitSha).slice(0, 7));
        if (h.schemaVersion !== undefined) parts.push("схема БД " + h.schemaVersion);
        console.log(parts.length ? parts.join(", ") : "ok");
      } catch { console.log("ok"); }
    });
  ' 2>/dev/null || printf 'ok'
}

# ---------- Файлы KEY=value ----------
# env_value <файл> <КЛЮЧ> [по умолчанию] — значение ключа из env-файла БЕЗ загрузки файла в окружение
# (чтобы настройки облака не перемешивались с hub.env). Берётся последняя незакомментированная строка.
env_value() {
  local file="$1" key="$2" def="${3:-}" v=""
  if [ -r "$file" ]; then
    v="$(K="$key" awk '
      BEGIN { k = ENVIRON["K"] }
      /^[[:space:]]*#/ { next }
      {
        line = $0; sub(/^[[:space:]]+/, "", line)
        if (index(line, k "=") == 1) { val = substr(line, length(k) + 2) }
      }
      END { sub(/\r$/, "", val); print val }
    ' "$file")"
  fi
  printf '%s' "${v:-$def}"
}

# set_env_value <файл> <КЛЮЧ> <значение> — заменить строку КЛЮЧ=… (или закомментированную #КЛЮЧ=…),
# а если такой нет — дописать в конец. Владелец и права файла сохраняются (перезапись на месте).
set_env_value() {
  local file="$1" key="$2" value="$3" tmp mode=append
  if grep -Eq "^[[:space:]]*${key}[[:space:]]*=" "$file"; then
    mode=active
  elif grep -Eq "^[[:space:]]*#[[:space:]]*${key}[[:space:]]*=" "$file"; then
    mode=commented
  fi
  tmp="$(mktemp)"
  K="$key" V="$value" M="$mode" awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; m = ENVIRON["M"]; done = 0
            re = (m == "active") ? "^[[:space:]]*" k "[[:space:]]*=" : "^[[:space:]]*#[[:space:]]*" k "[[:space:]]*=" }
    m != "append" && $0 ~ re {
      if (!done) { print k "=" v; done = 1 }
      next
    }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f -- "$tmp"
}

# ---------- Облако TS на этом мини-ПК ----------
# Облако включено, если есть /etc/bills/cloud.env (его создаёт install.sh --with-cloud).
cloud_enabled() { [ -f "$CLOUD_ENV_FILE" ]; }

# Порт облака из cloud.env (или 4320).
cloud_port() {
  local p
  p="$(env_value "$CLOUD_ENV_FILE" CLOUD_PORT "$DEFAULT_CLOUD_PORT")"
  case "$p" in ''|*[!0-9]*) p="$DEFAULT_CLOUD_PORT" ;; esac
  printf '%s' "$p"
}

cloud_is_active() { systemctl is-active --quiet "$CLOUD_SERVICE"; }

# Ждать, пока облако ответит ok:true на /api/health. cloud_health_wait [таймаут_сек]. Код 0/1.
# Ответ кладётся в CLOUD_HEALTH_BODY.
cloud_health_wait() {
  local timeout="${1:-$HEALTH_TIMEOUT}" port body i
  port="$(cloud_port)"
  for ((i = 0; i < timeout; i++)); do
    if body="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/api/health" 2>/dev/null)" \
       && printf '%s' "$body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
      CLOUD_HEALTH_BODY="$body"
      return 0
    fi
    sleep 1
  done
  CLOUD_HEALTH_BODY=""
  return 1
}

# cloud_cli <папка релиза> <аргументы CLI...>
# Запускает `node apps/cloud/src/cli.ts ...` от bills с переменными ТОЛЬКО из cloud.env
# (sudo -u bills сбрасывает окружение, поэтому переменные hub.env туда не попадают).
cloud_cli() {
  local dir="$1"; shift
  [ -f "$dir/apps/cloud/src/cli.ts" ] || die "в релизе $dir нет apps/cloud/src/cli.ts — обновите TS: sudo bills update"
  as_bills bash -c '
    set -a
    [ -r "$1" ] && . "$1"
    set +a
    cd "$2" || exit 1
    shift 2
    exec node apps/cloud/src/cli.ts "$@"
  ' _ "$CLOUD_ENV_FILE" "$dir" "$@"
}

# Адрес Tailscale этого мини-ПК (100.x.y.z) или пусто.
tailscale_ip() {
  command -v tailscale >/dev/null 2>&1 || return 0
  tailscale ip -4 2>/dev/null | head -n 1 || true
}

# ---------- Разное ----------
# Первый IP-адрес машины в LAN (для подсказки операторам).
primary_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [ -n "$ip" ] || ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
  printf '%s' "${ip:-<ip-сервера>}"
}

# Запись в журнал обновлений: log_update "текст"
log_update() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  mkdir -p "$(dirname "$UPDATES_LOG")"
  printf '%s\n' "$line" >>"$UPDATES_LOG" 2>/dev/null || true
}

timestamp() { date '+%Y%m%d-%H%M%S'; }
