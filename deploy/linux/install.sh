#!/usr/bin/env bash
# install.sh — установка TS HUB одной командой на чистую Ubuntu Server LTS (22.04/24.04).
#
#   curl -fsSL https://raw.githubusercontent.com/ansa-music/billS/main/deploy/linux/install.sh | sudo bash
#   или из клона репозитория:
#   sudo bash deploy/linux/install.sh [--ref <tag|branch>] [--host 0.0.0.0] [--port 4310] [--node-from nodesource|tarball]
#
# Повторный запуск безопасен (идемпотентен): существующий /etc/bills/hub.env и база не трогаются,
# релиз пересоздаётся только если изменился целевой коммит.
#
# Что ставится (подробнее — README.md рядом):
#   /opt/bills/repo                 зеркало git-репозитория
#   /opt/bills/releases/<дата>-<sha> релизы (npm ci + собранный web)
#   /opt/bills/current, previous    симлинки на текущий и предыдущий релиз
#   /opt/bills/bin                  эти скрипты;  /usr/local/bin/bills — обёртка-команда
#   /var/lib/bills                  база hub.db и backups/
#   /etc/bills/hub.env              настройки
#   systemd: bills-hub.service, bills-backup.service + bills-backup.timer (03:30)

set -Eeuo pipefail
SCRIPT_NAME="install.sh"

# Минимальные log/die до подключения lib.sh (нужны на этапе самозагрузки через curl | bash).
log() { printf '[TS] %s\n' "$*"; }
die() { printf '[TS] ОШИБКА: %s\n' "$*" >&2; exit 1; }
trap 'rc=$?; printf "[TS] ОШИБКА: установка прервана (строка %s, код %s): %s\n" "$LINENO" "$rc" "$BASH_COMMAND" >&2; exit $rc' ERR

export DEBIAN_FRONTEND=noninteractive

# ---------- Аргументы ----------
REF="main"
HOST="0.0.0.0"
PORT="4310"
HOST_SET=0
PORT_SET=0
NODE_FROM="auto"
REPO_URL="${BILLS_REPO:-https://github.com/ansa-music/billS.git}"
ORIG_ARGS=("$@")

usage() {
  cat <<USAGE
Использование: sudo bash install.sh [параметры]
  --ref <tag|branch|sha>   какую версию ставить (по умолчанию main)
  --host <адрес>           HUB_HOST для нового hub.env (по умолчанию 0.0.0.0 — доступ из LAN)
  --port <порт>            HUB_PORT для нового hub.env (по умолчанию 4310)
  --node-from <режим>      nodesource (deb-репозиторий), tarball (архив с nodejs.org в /usr/local)
                           или auto (по умолчанию: nodesource, при сбое — tarball)
  --repo <url>             адрес git-репозитория (или переменная BILLS_REPO)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)  [ $# -ge 2 ] || die "--ref требует значение";  REF="$2"; shift 2 ;;
    --ref=*) REF="${1#--ref=}"; shift ;;
    --host) [ $# -ge 2 ] || die "--host требует значение"; HOST="$2"; HOST_SET=1; shift 2 ;;
    --host=*) HOST="${1#--host=}"; HOST_SET=1; shift ;;
    --port) [ $# -ge 2 ] || die "--port требует значение"; PORT="$2"; PORT_SET=1; shift 2 ;;
    --port=*) PORT="${1#--port=}"; PORT_SET=1; shift ;;
    --node-from) [ $# -ge 2 ] || die "--node-from требует значение"; NODE_FROM="$2"; shift 2 ;;
    --node-from=*) NODE_FROM="${1#--node-from=}"; shift ;;
    --repo) [ $# -ge 2 ] || die "--repo требует значение"; REPO_URL="$2"; shift 2 ;;
    --repo=*) REPO_URL="${1#--repo=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
  esac
done
case "$NODE_FROM" in auto|nodesource|tarball) ;; *) die "--node-from: допустимо auto, nodesource или tarball" ;; esac
case "$PORT" in ''|*[!0-9]*) die "--port должен быть числом" ;; esac

[ "$(id -u)" -eq 0 ] || die "запустите от root: sudo bash install.sh ${ORIG_ARGS[*]:-}"

# ---------- Базовые пакеты (нужны и для самозагрузки) ----------
apt_install() {
  # apt_install <пакеты...> — ставит только недостающие.
  local missing=() p
  for p in "$@"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p")
  done
  [ ${#missing[@]} -gt 0 ] || return 0
  log "Устанавливаю пакеты: ${missing[*]}"
  apt-get update -qq </dev/null
  apt-get install -y -qq --no-install-recommends "${missing[@]}" </dev/null
}

# ---------- Самозагрузка: запуск через curl | bash без соседних файлов ----------
SELF="${BASH_SOURCE[0]:-}"
SRC_DIR=""
if [ -n "$SELF" ] && [ -f "$SELF" ]; then
  SRC_DIR="$(cd "$(dirname "$SELF")" && pwd)"
fi
if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/lib.sh" ] || [ ! -d "$SRC_DIR/systemd" ]; then
  [ -z "${BILLS_BOOTSTRAPPED:-}" ] || die "в $SRC_DIR нет lib.sh/systemd — репозиторий неполный?"
  log "Соседних файлов (lib.sh, systemd/) нет — скачиваю репозиторий во временную папку ..."
  apt_install git ca-certificates curl
  BOOT_DIR="$(mktemp -d /tmp/bills-install.XXXXXX)"
  git clone --quiet "$REPO_URL" "$BOOT_DIR/repo"
  if ! git -C "$BOOT_DIR/repo" checkout --quiet --detach "origin/$REF" 2>/dev/null; then
    git -C "$BOOT_DIR/repo" checkout --quiet --detach "$REF" \
      || die "в репозитории нет ветки/тега/коммита '$REF'"
  fi
  [ -f "$BOOT_DIR/repo/deploy/linux/install.sh" ] || die "в версии '$REF' нет deploy/linux/install.sh"
  export BILLS_BOOTSTRAPPED=1 BILLS_REPO="$REPO_URL" BILLS_BOOT_DIR="$BOOT_DIR"
  exec bash "$BOOT_DIR/repo/deploy/linux/install.sh" "${ORIG_ARGS[@]}" </dev/null
fi

# shellcheck source=lib.sh
source "$SRC_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
BILLS_REPO="$REPO_URL"

# ---------- Node 24 ----------
node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

install_node_nodesource() {
  log "Ставлю Node 24 из NodeSource (deb.nodesource.com) ..."
  local setup
  setup="$(mktemp /tmp/nodesource-setup.XXXXXX)"
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$setup" || { rm -f "$setup"; return 1; }
  bash "$setup" </dev/null >/dev/null || { rm -f "$setup"; return 1; }
  rm -f "$setup"
  apt-get install -y -qq nodejs </dev/null || return 1
}

install_node_tarball() {
  log "Ставлю Node 24 из официального архива nodejs.org в /usr/local ..."
  local arch base shasums fname tmpd
  case "$(uname -m)" in
    x86_64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l) arch="armv7l" ;;
    *) die "неподдерживаемая архитектура для архива Node: $(uname -m)" ;;
  esac
  apt_install xz-utils
  base="https://nodejs.org/dist/latest-v24.x"
  tmpd="$(mktemp -d /tmp/node-tarball.XXXXXX)"
  shasums="$tmpd/SHASUMS256.txt"
  curl -fsSL "$base/SHASUMS256.txt" -o "$shasums" || die "не удалось скачать $base/SHASUMS256.txt"
  fname="$(grep -oE "node-v24\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz" "$shasums" | head -n 1)"
  [ -n "$fname" ] || die "в $base нет архива для linux-$arch"
  log "Скачиваю $fname ..."
  curl -fsSL "$base/$fname" -o "$tmpd/$fname" || die "не удалось скачать $base/$fname"
  (cd "$tmpd" && grep " ${fname}\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "контрольная сумма $fname не совпала"
  tar -xJf "$tmpd/$fname" -C /usr/local --strip-components=1 --no-same-owner \
    --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'
  rm -rf "$tmpd"
  hash -r
}

# systemd-юнит запускает /usr/bin/node — если Node стоит в другом месте, делаем симлинк.
link_node_to_usr_bin() {
  local b src
  for b in node npm npx; do
    if [ ! -e "/usr/bin/$b" ]; then
      src="$(command -v "$b" 2>/dev/null || true)"
      if [ -n "$src" ] && [ "$src" != "/usr/bin/$b" ]; then
        ln -s "$src" "/usr/bin/$b"
        log "Симлинк /usr/bin/$b → $src"
      fi
    fi
  done
}

ensure_node() {
  local major
  if major="$(node_major)" && [ -n "$major" ] && [ "$major" -ge 24 ]; then
    log "Node $(node -v) уже установлен — пропускаю."
  else
    [ -z "$major" ] || log "Найден Node v$major — нужен 24+, обновляю."
    case "$NODE_FROM" in
      nodesource) install_node_nodesource || die "установка Node из NodeSource не удалась (попробуйте --node-from tarball)" ;;
      tarball)    install_node_tarball ;;
      auto)
        if ! install_node_nodesource; then
          warn "NodeSource недоступен — переключаюсь на архив с nodejs.org"
          install_node_tarball
        fi
        ;;
    esac
    hash -r
    major="$(node_major || true)"
    [ -n "$major" ] && [ "$major" -ge 24 ] || die "после установки Node не найден или версия ниже 24 (node -v: $(node -v 2>&1 || true))"
    ok "Установлен Node $(node -v), npm $(npm -v)"
  fi
  link_node_to_usr_bin
  [ -x /usr/bin/node ] || die "/usr/bin/node не найден — systemd-юнит ожидает его там"
}

# ---------- Пользователь и папки ----------
ensure_user_and_dirs() {
  if ! id -u "$BILLS_USER" >/dev/null 2>&1; then
    log "Создаю системного пользователя $BILLS_USER (home $BILLS_HOME, без шелла)"
    useradd --system --user-group --home-dir "$BILLS_HOME" --no-create-home --shell /usr/sbin/nologin "$BILLS_USER"
  fi
  install -d -m 755 -o root -g root "$BILLS_HOME" "$BIN_DIR" "$BIN_DIR/systemd" "$ENV_DIR"
  install -d -m 755 -o "$BILLS_USER" -g "$BILLS_USER" "$RELEASES_DIR"
  install -d -m 700 -o "$BILLS_USER" -g "$BILLS_USER" "$BILLS_HOME/.npm" "$BILLS_HOME/.cache" "$BILLS_HOME/.config"
  install -d -m 750 -o "$BILLS_USER" -g "$BILLS_USER" "$STATE_DIR" "$STATE_DIR/backups"
}

# ---------- Скрипты в /opt/bills/bin ----------
install_scripts() {
  log "Копирую скрипты в $BIN_DIR"
  local f
  for f in "$SRC_DIR"/*.sh; do
    install -m 755 -o root -g root "$f" "$BIN_DIR/$(basename "$f")"
  done
  install -m 644 -o root -g root "$SRC_DIR/hub.env.example" "$BIN_DIR/hub.env.example"
  [ -f "$SRC_DIR/README.md" ] && install -m 644 -o root -g root "$SRC_DIR/README.md" "$BIN_DIR/README.md"
  for f in "$SRC_DIR"/systemd/*; do
    install -m 644 -o root -g root "$f" "$BIN_DIR/systemd/$(basename "$f")"
  done
  ln -sfn "$BIN_DIR/bills.sh" /usr/local/bin/bills
}

# ---------- /etc/bills/hub.env ----------
ensure_env_file() {
  if [ -f "$ENV_FILE" ]; then
    log "Файл настроек $ENV_FILE уже есть — не трогаю."
    if [ "$HOST_SET" -eq 1 ] || [ "$PORT_SET" -eq 1 ]; then
      warn "--host/--port применяются только при создании нового hub.env; отредактируйте $ENV_FILE вручную и выполните: sudo systemctl restart $HUB_SERVICE"
    fi
  else
    log "Создаю $ENV_FILE из шаблона (HUB_HOST=$HOST, HUB_PORT=$PORT)"
    sed -e "s|^HUB_HOST=.*|HUB_HOST=$HOST|" \
        -e "s|^HUB_PORT=.*|HUB_PORT=$PORT|" \
        -e "s|^HUB_DB_PATH=.*|HUB_DB_PATH=$STATE_DIR/hub.db|" \
        -e "s|^BACKUP_DIR=.*|BACKUP_DIR=$STATE_DIR/backups|" \
        "$SRC_DIR/hub.env.example" >"$ENV_FILE"
  fi
  chown root:"$BILLS_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  load_env
  PORT="$(hub_port)"
}

# ---------- Зеркало репозитория ----------
ensure_repo() {
  if [ -d "$REPO_DIR" ]; then
    chown -R "$BILLS_USER:$BILLS_USER" "$REPO_DIR"
  fi
  if [ -d "$REPO_DIR" ] && [ "$(as_bills git -C "$REPO_DIR" rev-parse --is-bare-repository 2>/dev/null || true)" != "true" ]; then
    warn "$REPO_DIR не является зеркалом (старый формат) — пересоздаю"
    rm -rf -- "$REPO_DIR"
  fi
  if [ ! -d "$REPO_DIR" ]; then
    log "Клонирую $BILLS_REPO → $REPO_DIR (зеркало)"
    as_bills git clone --quiet --mirror "$BILLS_REPO" "$REPO_DIR"
  else
    local url
    url="$(as_bills git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
    if [ "$url" != "$BILLS_REPO" ]; then
      log "Меняю адрес origin: $url → $BILLS_REPO"
      as_bills git -C "$REPO_DIR" remote set-url origin "$BILLS_REPO"
    fi
  fi
}

# ---------- systemd ----------
install_systemd() {
  log "Устанавливаю systemd-юниты"
  install -m 644 -o root -g root "$SRC_DIR/systemd/bills-hub.service"    /etc/systemd/system/bills-hub.service
  install -m 644 -o root -g root "$SRC_DIR/systemd/bills-backup.service" /etc/systemd/system/bills-backup.service
  install -m 644 -o root -g root "$SRC_DIR/systemd/bills-backup.timer"   /etc/systemd/system/bills-backup.timer
  systemctl daemon-reload
  systemctl enable --quiet bills-hub.service
  systemctl enable --quiet --now bills-backup.timer
}

# ---------- Фаервол ----------
configure_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    log "ufw активен — открываю порт $PORT/tcp"
    ufw allow "$PORT/tcp" comment 'TS HUB (только LAN)' >/dev/null
  fi
  warn "HUB НЕ должен быть доступен из интернета — только из локальной сети клуба. Не пробрасывайте порт $PORT на роутере."
}

# ---------- Итог ----------
print_summary() {
  local ip
  ip="$(primary_ip)"
  echo
  echo "=============================================================="
  ok "TS HUB установлен и работает: $(health_summary)"
  echo "=============================================================="
  echo "  Адрес для планшетов:   http://${ip}:${PORT}"
  echo "  Проверка здоровья:     http://${ip}:${PORT}/api/health   метрики: /metrics"
  echo "  Настройки:             $ENV_FILE"
  echo "  База данных:           ${HUB_DB_PATH:-$STATE_DIR/hub.db}"
  echo "  Бэкапы:                $(backup_dir)  (ежедневно в 03:30, хранить ${BACKUP_KEEP_DAYS:-30} дн.)"
  echo "  Текущий релиз:         $(release_path "$CURRENT_LINK")"
  echo "  Журнал обновлений:     $UPDATES_LOG"
  echo
  echo "  Команды:"
  echo "    bills status                 состояние"
  echo "    bills logs                   логи (journalctl -u $HUB_SERVICE -f)"
  echo "    bills update                 обновить до последней версии"
  echo "    bills update --rollback      откатить на предыдущий релиз"
  echo "    bills backup                 бэкап сейчас"
  echo "    bills restore                список бэкапов / восстановление"
  echo "    systemctl list-timers $BACKUP_TIMER"
  echo
}

main() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
      ubuntu|debian) log "ОС: ${PRETTY_NAME:-$ID}" ;;
      *) warn "скрипт рассчитан на Ubuntu Server LTS; у вас ${PRETTY_NAME:-неизвестная ОС} — продолжаю на свой страх и риск" ;;
    esac
  fi
  command -v systemctl >/dev/null 2>&1 || die "нужен systemd (systemctl не найден)"

  apt_install git curl ca-certificates gzip
  ensure_node
  ensure_user_and_dirs
  install_scripts
  ensure_env_file
  ensure_repo
  install_systemd

  log "Создаю/обновляю релиз ($REF) через update.sh ..."
  bash "$BIN_DIR/update.sh" --ref "$REF"

  # update.sh выходит сразу, если релиз уже актуален, — тогда просто убеждаемся, что сервис запущен.
  if ! hub_is_active; then
    log "Запускаю $HUB_SERVICE ..."
    systemctl start "$HUB_SERVICE"
  fi

  configure_firewall

  log "Жду ответа /api/health (до ${HEALTH_TIMEOUT} с) ..."
  if ! health_wait "$HEALTH_TIMEOUT"; then
    journalctl -u "$HUB_SERVICE" -n 30 --no-pager || true
    die "HUB не ответил на http://127.0.0.1:${PORT}/api/health. Смотрите: journalctl -u $HUB_SERVICE -n 100"
  fi
  print_summary

  # Временная копия репозитория из режима curl | bash больше не нужна.
  if [ -n "${BILLS_BOOT_DIR:-}" ]; then
    case "$BILLS_BOOT_DIR" in /tmp/bills-install.*) rm -rf -- "$BILLS_BOOT_DIR" ;; esac
  fi
}

main "${ORIG_ARGS[@]}"
