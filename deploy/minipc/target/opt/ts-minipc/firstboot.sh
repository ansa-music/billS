#!/usr/bin/env bash
# firstboot.sh — первая установка HUB на мини-ПК (служба ts-firstboot.service).
#
#   1. Один раз задаёт случайный пароль администратора ts (его покажет экран мини-ПК до конца
#      настройки; копия — /var/lib/ts-minipc/admin-password, читает только root).
#   2. Ждёт интернет (на экране: «Подключите кабель интернета») и правильное время.
#   3. Запускает install.sh той версии TS, из которой собран образ (--ref из build-info),
#      с именем hub.local для сети клуба. Ход — в /run/ts-minipc/state и detail для ts-console.
#   4. Успех — /var/lib/ts-minipc/installed (служба больше не запускается). Ошибка — код 1,
#      systemd повторит через минуту (install.sh можно запускать повторно).

set -uo pipefail

TS_DIR=/opt/ts-minipc
STATE_DIR=/var/lib/ts-minipc
RUN_DIR=/run/ts-minipc
LOG_FILE=/var/log/ts-firstboot.log
PASSWORD_FILE="$STATE_DIR/admin-password"
ADMIN_USER=ts

TS_REF=main
TS_REPO=""
TS_BUILT_EPOCH=0
# shellcheck source=/dev/null
[ -r "$TS_DIR/build-info" ] && . "$TS_DIR/build-info"

mkdir -p "$STATE_DIR" "$RUN_DIR"
chmod 700 "$STATE_DIR"
chmod 755 "$RUN_DIR"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE" >&2; }

# Атомарная запись маленького файла состояния (его читает ts-console).
put() { printf '%s\n' "$2" >"$RUN_DIR/$1.new" && mv -f "$RUN_DIR/$1.new" "$RUN_DIR/$1"; }
set_state() { # set_state <nonet|nointernet|clock|installing|failed|ready> [подробность]
  put detail "${2:-}"
  put state "$1"
}

# ---------- 1. Пароль администратора ----------
gen_password() {
  # 12 символов без похожих (0/o, 1/l/i) — около 59 бит. Группы по 4 для диктовки по телефону.
  local alphabet='abcdefghjkmnpqrstuvwxyz23456789' out='' b
  while [ "${#out}" -lt 12 ]; do
    b=$(od -An -N1 -tu1 /dev/urandom | tr -d ' ')
    [ "$b" -lt 248 ] || continue # 248 = 8 * 31: без перекоса
    out="$out${alphabet:$((b % 31)):1}"
  done
  printf '%s-%s-%s' "${out:0:4}" "${out:4:4}" "${out:8:4}"
}

ensure_admin_password() {
  [ -s "$PASSWORD_FILE" ] && return 0
  id -u "$ADMIN_USER" >/dev/null 2>&1 || { log "пользователя $ADMIN_USER нет — пароль не задаю"; return 0; }
  local pw
  pw=$(gen_password)
  if printf '%s:%s\n' "$ADMIN_USER" "$pw" | chpasswd; then
    (umask 077 && printf '%s\n' "$pw" >"$PASSWORD_FILE")
    log "пароль администратора $ADMIN_USER задан (показывается на экране до конца настройки)"
  else
    log "не удалось задать пароль $ADMIN_USER"
  fi
}

# ---------- 2. Сеть и время ----------
have_route() { ip -4 route show default 2>/dev/null | grep -q . || ip -6 route show default 2>/dev/null | grep -q .; }
have_internet() { curl -sS -o /dev/null --max-time 15 https://github.com/ 2>/dev/null; }

# Если сеть поднята, а адреса нет (кабель включили позже) — пинаем networkd.
kick_network() {
  if systemctl is-active --quiet systemd-networkd; then
    networkctl reconfigure --all >/dev/null 2>&1 || networkctl reload >/dev/null 2>&1 || true
  fi
}

wait_for_internet() {
  local n=0
  until have_route && have_internet; do
    if ! have_route; then
      set_state nonet "Кабель не подключён или роутер не выдал адрес"
    else
      set_state nointernet "Сеть есть, а интернета нет — проверьте роутер"
    fi
    n=$((n + 1))
    if [ $((n % 12)) -eq 0 ]; then
      log "жду интернет ($((n * 5)) с)"
      kick_network
    fi
    sleep 5
  done
  log "интернет есть"
}

wait_for_clock() {
  # TLS к GitHub не пройдёт, если часы мини-ПК сильно отстают (села батарейка BIOS).
  local now i
  now=$(date +%s)
  [ "$now" -ge $((TS_BUILT_EPOCH - 86400)) ] && return 0
  set_state clock "Настраиваю часы мини-ПК"
  log "часы отстают ($(date -Is)) — жду синхронизацию времени"
  timedatectl set-ntp true >/dev/null 2>&1 || true
  systemctl restart systemd-timesyncd >/dev/null 2>&1 || true
  for ((i = 0; i < 60; i++)); do
    [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && break
    sleep 2
  done
  log "время: $(date -Is)"
}

# apt-daily/apt-daily-upgrade на первой загрузке держат блокировку dpkg: install.sh упал бы на apt-get.
# Ждём до 15 минут (дальше apt сам подождёт ещё до 10 минут: DPkg::Lock::Timeout от late.sh).
wait_for_apt() {
  local i
  for ((i = 0; i < 180; i++)); do
    systemctl is-active --quiet apt-daily.service apt-daily-upgrade.service 2>/dev/null || return 0
    [ "$i" -eq 0 ] && { set_state installing "Жду, пока система обновит списки пакетов"; log "apt-daily работает — жду"; }
    sleep 5
  done
  log "apt-daily не закончился за 15 минут — продолжаю"
}

# ---------- 3. Установка ----------
run_install() {
  local args=(--ref "$TS_REF" --mdns-name hub) line reason="" rc
  [ -n "$TS_REPO" ] && args+=(--repo "$TS_REPO")
  set_state installing "Начинаю установку TS (${TS_VERSION:-?})"
  log "запускаю install.sh ${args[*]}"
  bash "$TS_DIR/linux/install.sh" "${args[@]}" </dev/null 2>&1 | while IFS= read -r line; do
    printf '%s\n' "$line" >>"$LOG_FILE"
    printf '%s\n' "$line"
    case "$line" in
      *"ОШИБКА"*) put detail "${line#\[TS\] }"; put last-error "${line#\[TS\] }" ;;
      "[TS]"*) put detail "${line#\[TS\] }" ;;
    esac
  done
  rc=${PIPESTATUS[0]}
  if [ "$rc" -eq 0 ]; then
    : >"$STATE_DIR/installed"
    rm -f "$RUN_DIR/last-error"
    set_state ready ""
    log "TS HUB установлен"
    return 0
  fi
  [ -r "$RUN_DIR/last-error" ] && reason=$(cat "$RUN_DIR/last-error")
  set_state failed "${reason:-install.sh завершился с кодом $rc}"
  log "установка не удалась (код $rc): ${reason:-см. $LOG_FILE} — повтор через минуту"
  return 1
}

log "первая загрузка TS: версия ${TS_VERSION:-?}, ref $TS_REF"
ensure_admin_password
wait_for_internet
wait_for_clock
wait_for_apt
run_install
