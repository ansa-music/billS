#!/usr/bin/env bash
# vm-test.sh — проверка образа «TS для мини-ПК» в QEMU, как на настоящем мини-ПК:
# флешка USB + пустой NVMe-диск, сеть по DHCP, никто ничего не нажимает.
#
#   deploy/minipc/test/vm-test.sh --iso dist/minipc-test/TS-minipc-<версия>-serial.iso \
#       --firmware bios|uefi|uefi-sb --out vm-out [--disk-size 20G] [--memory 4096] [--cpus 4]
#       [--port 14310] [--install-timeout 50] [--firstboot-timeout 50] [--no-reboot-check] [--no-extract]
#
# Образ собирается так: deploy/minipc/build-iso.sh --serial … (отличается от обычного только консолью
# и журналами, см. build-iso.sh). Нужно: qemu-system-x86, qemu-utils, ovmf (для UEFI), python3, curl;
# KVM (/dev/kvm) — по возможности, без него всё в 3 раза медленнее (TCG).
#
# Этапы (каждый с тайм-аутом, минуты указаны для KVM):
#   1. install   — загрузка с флешки, меню само выбирает «Установить TS», установщик Debian ставит
#                  систему без вопросов и перезагружается (QEMU с -no-reboot завершается).
#   2. firstboot — загрузка с диска; ts-firstboot ставит HUB; ждём, пока
#                  http://127.0.0.1:<port>/api/setup/status (проброс на 4310 гостя) ответит "open":true,
#                  затем /api/health ("ok":true) и страницу /setup.
#   3. reboot    — кнопка питания (ACPI), система должна выключиться сама; снова загрузка — HUB
#                  снова открывает мастер настройки.
# UEFI: флешка остаётся вставленной и после установки — так проверяется защита «забытой флешки»
# (меню флешки само загружает установленный TS). BIOS: меню isolinux этого не умеет (там флешку
# просят вынуть), поэтому после установки флешку «вынимаем».
#
# В --out: serial-*.log (COM-порт: меню, ядро, журнал systemd установленной системы),
# installer-syslog.log (журнал установщика с вопросами debconf), screens/*.png (экран раз в минуту),
# api-*.json, guest-logs/ (журналы с диска гостя после остановки: installer, ts-firstboot, journal).
# Код выхода 0 — все этапы прошли.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISO=""
FIRMWARE=bios
OUT=""
DISK_SIZE=20G
MEMORY=4096
CPUS=4
PORT=14310
SYSLOG_PORT=5514
INSTALL_TIMEOUT=""
FIRSTBOOT_TIMEOUT=""
REBOOT_CHECK=1
EXTRACT=1

log() { printf '[vm-test %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '[vm-test] ОШИБКА: %s\n' "$*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --iso) ISO="$2"; shift 2 ;;
    --firmware) FIRMWARE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --disk-size) DISK_SIZE="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --install-timeout) INSTALL_TIMEOUT="$2"; shift 2 ;;
    --firstboot-timeout) FIRSTBOOT_TIMEOUT="$2"; shift 2 ;;
    --no-reboot-check) REBOOT_CHECK=0; shift ;;
    --no-extract) EXTRACT=0; shift ;;
    -h | --help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
  esac
done
[ -n "$ISO" ] && [ -f "$ISO" ] || die "--iso: нет файла образа (${ISO:-не указан})"
[ -n "$OUT" ] || die "--out: папка для результатов"
case "$FIRMWARE" in bios | uefi | uefi-sb) ;; *) die "--firmware: bios, uefi или uefi-sb" ;; esac
for c in qemu-system-x86_64 qemu-img python3 curl; do
  command -v "$c" >/dev/null 2>&1 || die "нет программы $c (sudo apt-get install -y qemu-system-x86 qemu-utils ovmf python3 curl)"
done

mkdir -p "$OUT/screens"
OUT="$(cd "$OUT" && pwd)"
ISO="$(cd "$(dirname "$ISO")" && pwd)/$(basename "$ISO")"
QMP="$OUT/qmp.sock"
DISK="$OUT/disk.qcow2"
INSTALLER_LOG="$OUT/installer-syslog.log"
RESULT="$OUT/result.txt"
: >"$RESULT"

# ---------- Ускорение и тайм-ауты ----------
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  ACCEL=(-accel kvm -cpu host)
  SLOW=1
  log "KVM есть"
else
  ACCEL=(-accel tcg,thread=multi -cpu max)
  SLOW=3
  log "KVM нет — эмуляция TCG, тайм-ауты ×$SLOW"
fi
INSTALL_TIMEOUT=$((${INSTALL_TIMEOUT:-$((50 * SLOW))} * 60))
FIRSTBOOT_TIMEOUT=$((${FIRSTBOOT_TIMEOUT:-$((50 * SLOW))} * 60))
REBOOT_TIMEOUT=$((15 * SLOW * 60))
STALL_TIMEOUT=$((15 * SLOW * 60)) # установщик молчит в журнале дольше — завис на вопросе или ошибке

# ---------- Прошивка ----------
MACHINE=q35
FW=()
find_fw() { # find_fw <имя файла> — путь к файлу OVMF
  local d
  for d in /usr/share/OVMF /usr/share/ovmf /usr/share/edk2/ovmf /usr/share/qemu; do
    [ -f "$d/$1" ] && { printf '%s/%s' "$d" "$1"; return 0; }
  done
  die "нет прошивки $1 (sudo apt-get install -y ovmf)"
}
case "$FIRMWARE" in
  uefi)
    cp -f "$(find_fw OVMF_VARS_4M.fd)" "$OUT/efivars.fd"
    FW=(-drive "if=pflash,format=raw,readonly=on,file=$(find_fw OVMF_CODE_4M.fd)" -drive "if=pflash,format=raw,file=$OUT/efivars.fd")
    ;;
  uefi-sb)
    # Secure Boot включён, ключи Microsoft — как у мини-ПК из магазина.
    cp -f "$(find_fw OVMF_VARS_4M.ms.fd)" "$OUT/efivars.fd"
    MACHINE=q35,smm=on
    FW=(-global driver=cfi.pflash01,property=secure,value=on
      -drive "if=pflash,format=raw,readonly=on,file=$(find_fw OVMF_CODE_4M.secboot.fd)" -drive "if=pflash,format=raw,file=$OUT/efivars.fd")
    ;;
esac
STICK_AFTER_INSTALL=1
[ "$FIRMWARE" = bios ] && STICK_AFTER_INSTALL=0

rm -f -- "$DISK"
qemu-img create -q -f qcow2 "$DISK" "$DISK_SIZE"

# ---------- Журнал установщика (log_host=10.0.2.2:5514 в образе --serial) ----------
SINK_PID=""
: >"$INSTALLER_LOG"
python3 "$HERE/syslog-sink.py" "$SYSLOG_PORT" "$INSTALLER_LOG" &
SINK_PID=$!

# ---------- QEMU ----------
QEMU_PID=""
PHASE=""
qmp() { python3 "$HERE/qmp.py" "$QMP" "$@"; }
vm_running() { [ -n "$QEMU_PID" ] && kill -0 "$QEMU_PID" 2>/dev/null; }

shot() { # shot <имя> — снимок экрана в screens/<имя>.png
  vm_running || return 0
  qmp screendump "{\"filename\": \"$OUT/screens/$1.png\", \"format\": \"png\"}" >/dev/null 2>&1 \
    || qmp screendump "{\"filename\": \"$OUT/screens/$1.ppm\"}" >/dev/null 2>&1 || true
}

start_vm() { # start_vm <этап> <флешка 0|1> <-no-reboot 0|1>
  PHASE="$1"
  local args=(
    -name "ts-minipc-$FIRMWARE" -machine "$MACHINE" "${ACCEL[@]}" -smp "$CPUS" -m "$MEMORY"
    "${FW[@]}"
    -display none -vga std
    -serial "file:$OUT/serial-$PHASE.log"
    -qmp "unix:$QMP,server=on,wait=off"
    -rtc base=utc
    -netdev "user,id=lan,hostname=ts-test,hostfwd=tcp:127.0.0.1:$PORT-:4310"
    -device virtio-net-pci,netdev=lan
    -drive "file=$DISK,if=none,id=ssd,format=qcow2"
    -device nvme,serial=TS-TEST-NVME,drive=ssd,bootindex=1
    -device qemu-xhci,id=xhci
  )
  if [ "$2" = 1 ]; then
    args+=(-drive "file=$ISO,if=none,id=stick,format=raw,readonly=on"
      -device usb-storage,bus=xhci.0,drive=stick,removable=on,bootindex=0)
  fi
  [ "$3" = 1 ] && args+=(-no-reboot)
  rm -f -- "$QMP"
  log "этап $PHASE: запуск QEMU ($FIRMWARE, флешка: $([ "$2" = 1 ] && echo вставлена || echo нет))"
  printf '%q ' qemu-system-x86_64 "${args[@]}" >"$OUT/qemu-$PHASE.cmd"
  qemu-system-x86_64 "${args[@]}" >"$OUT/qemu-$PHASE.log" 2>&1 &
  QEMU_PID=$!
  local i
  for ((i = 0; i < 50; i++)); do
    [ -S "$QMP" ] && return 0
    vm_running || break
    sleep 0.2
  done
  cat "$OUT/qemu-$PHASE.log" >&2 || true
  vm_running || die "QEMU не запустился (этап $PHASE)"
}

wait_vm_exit() { # wait_vm_exit <секунд> — 0, если QEMU завершился сам
  local i
  for ((i = 0; i < $1; i++)); do
    vm_running || { wait "$QEMU_PID" 2>/dev/null || true; QEMU_PID=""; return 0; }
    sleep 1
  done
  return 1
}

stop_vm() {
  vm_running || { QEMU_PID=""; return 0; }
  qmp quit >/dev/null 2>&1 || true
  wait_vm_exit 20 || { kill -9 "$QEMU_PID" 2>/dev/null || true; wait "$QEMU_PID" 2>/dev/null || true; }
  QEMU_PID=""
}

# ---------- HUB ----------
api() { # api <путь> — тело ответа HUB через проброс порта (как с телефона в сети клуба)
  curl -fsS --max-time 5 "http://127.0.0.1:$PORT$1" 2>/dev/null
}
setup_open() {
  local body
  body="$(api /api/setup/status)" || return 1
  printf '%s' "$body" >"$OUT/api-setup-status-$PHASE.json"
  grep -Eq '"open"[[:space:]]*:[[:space:]]*true' <<<"$body"
}

# Ждать, пока мастер настройки откроется; снимок экрана раз в минуту. wait_setup <секунд>
wait_setup() {
  local start now last_shot=0 n=0
  start=$(date +%s)
  while :; do
    now=$(date +%s)
    if [ $((now - last_shot)) -ge 60 ]; then
      shot "$PHASE-$(printf '%03d' "$n")"
      n=$((n + 1))
      last_shot=$now
    fi
    if setup_open; then
      log "этап $PHASE: мастер настройки открыт через $(((now - start) / 60)) мин $(((now - start) % 60)) с"
      return 0
    fi
    vm_running || fail "QEMU завершился на этапе $PHASE, а HUB так и не ответил"
    [ $((now - start)) -lt "$1" ] || fail "этап $PHASE: за $(($1 / 60)) мин HUB не открыл мастер настройки (/api/setup/status)"
    sleep 10
  done
}

# ---------- Итог и журналы ----------
show_tail() { # show_tail <файл> <строк> <заголовок>
  [ -s "$1" ] || return 0
  echo "----- $3 (последние $2 строк, $1) -----"
  tail -n "$2" "$1" | tr -d '\r' | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | cut -c1-300
}

extract_guest_logs() {
  [ "$EXTRACT" = 1 ] || return 0
  local sudo="" dev="" p mnt="$OUT/.mnt" g="$OUT/guest-logs"
  [ "$(id -u)" -eq 0 ] || { sudo -n true 2>/dev/null && sudo="sudo -n"; } || { log "нет sudo — журналы с диска гостя не извлекаю"; return 0; }
  command -v qemu-nbd >/dev/null 2>&1 || { log "нет qemu-nbd — журналы с диска гостя не извлекаю"; return 0; }
  $sudo modprobe nbd max_part=16 2>/dev/null || true
  for p in /dev/nbd0 /dev/nbd1 /dev/nbd2 /dev/nbd3; do
    [ -e "$p" ] && [ "$(cat "/sys/block/${p#/dev/}/size" 2>/dev/null || echo 1)" = 0 ] && { dev=$p; break; }
  done
  [ -n "$dev" ] || { log "нет свободного /dev/nbdN — журналы с диска гостя не извлекаю"; return 0; }
  $sudo qemu-nbd --read-only --connect="$dev" "$DISK" || return 0
  sleep 2
  $sudo partprobe "$dev" 2>/dev/null || true
  mkdir -p "$mnt" "$g"
  local root=""
  for p in "$dev"p*; do
    [ -b "$p" ] || continue
    if [ "$($sudo blkid -o value -s LABEL "$p" 2>/dev/null)" = TS-HUB ]; then root=$p; break; fi
  done
  if [ -n "$root" ] && $sudo mount -o ro,noload "$root" "$mnt" 2>/dev/null; then
    log "журналы с диска гостя → $g"
    $sudo cp -a "$mnt/var/log/installer" "$g/installer" 2>/dev/null || true
    local f
    for f in var/log/ts-firstboot.log var/log/syslog var/log/apt/term.log var/log/apt/history.log \
      etc/ts-minipc/image-info etc/bills/hub.env var/lib/bills/updates.log etc/network/interfaces \
      etc/default/grub boot/grub/grub.cfg; do
      [ -f "$mnt/$f" ] && $sudo cp "$mnt/$f" "$g/$(printf '%s' "$f" | tr '/' '_')" 2>/dev/null || true
    done
    if [ -d "$mnt/var/log/journal" ] && command -v journalctl >/dev/null 2>&1; then
      $sudo journalctl --directory="$mnt/var/log/journal" --no-pager -o short-precise >"$g/journal.txt" 2>/dev/null || true
    fi
    $sudo umount "$mnt" || $sudo umount -l "$mnt" || true
  else
    log "на диске гостя нет раздела TS-HUB (установка не дошла до разметки?)"
  fi
  $sudo qemu-nbd --disconnect "$dev" >/dev/null 2>&1 || true
  rmdir "$mnt" 2>/dev/null || true
  [ -z "$sudo" ] || $sudo chown -R "$(id -u):$(id -g)" "$g" 2>/dev/null || true
}

finish() {
  local rc=$?
  trap - EXIT
  set +e
  if vm_running; then shot "$PHASE-last"; fi
  stop_vm
  [ -z "$SINK_PID" ] || kill "$SINK_PID" 2>/dev/null
  extract_guest_logs
  rm -f -- "$QMP"
  if [ "$rc" -ne 0 ]; then
    show_tail "$INSTALLER_LOG" 60 "журнал установщика"
    [ -s "$INSTALLER_LOG" ] && { echo "----- вопросы установщика (debconf INPUT) -----"; grep -a ' INPUT ' "$INSTALLER_LOG" | tail -n 15; }
    show_tail "$OUT/guest-logs/var_log_ts-firstboot.log" 40 "первая загрузка (ts-firstboot)"
    for f in "$OUT"/serial-*.log; do show_tail "$f" 40 "COM-порт"; done
  fi
  echo "----- итог -----"
  cat "$RESULT"
  exit "$rc"
}
trap finish EXIT

fail() {
  printf 'FAIL [%s] %s\n' "$PHASE" "$*" | tee -a "$RESULT" >&2
  exit 1
}
pass() { printf 'OK   [%s] %s\n' "$PHASE" "$*" | tee -a "$RESULT"; }

# ---------- 1. Установка с флешки ----------
start_vm install 1 1
start=$(date +%s)
last_shot=0
n=0
while vm_running; do
  now=$(date +%s)
  if [ $((now - last_shot)) -ge 60 ]; then
    shot "install-$(printf '%03d' "$n")"
    n=$((n + 1))
    last_shot=$now
  fi
  [ $((now - start)) -lt "$INSTALL_TIMEOUT" ] || fail "установка не закончилась за $((INSTALL_TIMEOUT / 60)) мин (снимки экрана — в screens/)"
  if grep -aq 'ts-minipc: автоматическая установка остановлена' "$INSTALLER_LOG" 2>/dev/null; then
    sleep 5
    shot install-stopped
    fail "pick-disk.sh остановил установку: $(grep -a 'ts-minipc: ' "$INSTALLER_LOG" | tail -n 3 | tr '\n' ' ')"
  fi
  if [ -s "$INSTALLER_LOG" ] && [ $((now - $(stat -c %Y "$INSTALLER_LOG"))) -ge "$STALL_TIMEOUT" ]; then
    shot install-stalled
    fail "установщик молчит $((STALL_TIMEOUT / 60)) мин — ждёт ответа на вопрос или показал ошибку (см. screens/install-stalled.png)"
  fi
  sleep 5
done
wait "$QEMU_PID" 2>/dev/null && qemu_rc=0 || qemu_rc=$?
QEMU_PID=""
[ "$qemu_rc" -eq 0 ] || fail "QEMU завершился с кодом $qemu_rc (см. qemu-install.log)"
pass "Debian и файлы TS установлены без вопросов за $((($(date +%s) - start) / 60)) мин, установщик перезагрузил мини-ПК"
grep -aq 'ts-minipc: готово' "$INSTALLER_LOG" 2>/dev/null && pass "late.sh выполнен (журнал установщика)"

# ---------- 2. Первая загрузка: установка HUB ----------
start_vm firstboot "$STICK_AFTER_INSTALL" 0
wait_setup "$FIRSTBOOT_TIMEOUT"
pass "GET /api/setup/status: $(cat "$OUT/api-setup-status-$PHASE.json")"
health="$(api /api/health)" || fail "/api/health не отвечает"
printf '%s' "$health" >"$OUT/api-health.json"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$health" || fail "/api/health без \"ok\":true: $health"
pass "GET /api/health: ok"
code="$(curl -sS -o "$OUT/setup-page.html" -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/setup" 2>/dev/null || true)"
[ "$code" = 200 ] || fail "GET /setup ответил $code вместо 200"
pass "GET /setup: страница мастера настройки (200)"
if grep -aq 'TS HUB установлен' "$OUT/serial-$PHASE.log"; then pass "ts-firstboot: «TS HUB установлен» (журнал на COM-порту)"; fi
sleep 15 # экран мини-ПК обновляется раз в 3 с
shot setup-screen
[ "$STICK_AFTER_INSTALL" = 1 ] && pass "флешка оставалась вставленной — меню флешки загрузило установленный TS"

# ---------- 3. Выключение кнопкой питания и повторная загрузка ----------
if [ "$REBOOT_CHECK" = 1 ]; then
  PHASE=reboot
  qmp system_powerdown >/dev/null || fail "QMP system_powerdown не прошёл"
  wait_vm_exit $((3 * 60 * SLOW)) || fail "мини-ПК не выключился по кнопке питания за $((3 * SLOW)) мин"
  pass "выключился по кнопке питания"
  start_vm reboot "$STICK_AFTER_INSTALL" 0
  wait_setup "$REBOOT_TIMEOUT"
  api /api/health | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' || fail "/api/health после перезагрузки без ok:true"
  pass "после перезагрузки HUB снова работает, мастер настройки открыт"
  sleep 15
  shot reboot-screen
  qmp system_powerdown >/dev/null 2>&1 || true
  wait_vm_exit $((3 * 60 * SLOW)) || true
fi

PHASE=done
pass "все этапы пройдены ($FIRMWARE)"
