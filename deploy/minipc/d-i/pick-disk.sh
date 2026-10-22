#!/bin/sh
# shellcheck shell=sh disable=SC3043
# pick-disk.sh — выбор диска для автоматической установки TS.
# Запускает установщик Debian перед разметкой (partman/early_command в preseed.cfg).
# Среда — busybox sh установщика; stdout не трогаем (это канал debconf), пишем в stderr и syslog.
#
# Правила:
#   - никогда не берём флешку, с которой идёт установка, и вообще USB/съёмные/только-чтение диски;
#   - из оставшихся берём самый большой диск от 14 ГиБ (NVMe, SATA, eMMC);
#   - если на внутренних дисках уже стоит TS (метка TS-HUB, /etc/ts-minipc/image-info,
#     /etc/bills/hub.env или /var/lib/bills/hub.db) — останавливаем установку, ничего не стирая.
#     Пункт меню «Переустановить TS заново» передаёт ядру ts_reinstall=1 и эту проверку пропускает.
# Код выхода не 0 = установщик показывает ошибку и дальше не идёт (диск не трогается).

TS_DIR=/ts-minipc
MIN_SECTORS=29360128 # 14 ГиБ в секторах по 512 байт
MNT=/tmp/ts-check

log() {
  echo "ts-minipc: $*" >&2
  logger -t ts-minipc -- "$*" 2>/dev/null || true
}

# shellcheck disable=SC1091
. /usr/share/debconf/confmodule

# Показать сообщение из d-i/templates и остановить установку.
# stop_install <шаблон> <ПЕРЕМЕННАЯ> <значение>
stop_install() {
  log "автоматическая установка остановлена: $1 ($3)"
  # Шаблоны сообщений: командой протокола cdebconf, а если её нет — отдельной программой.
  db_x_loadtemplatefile "$TS_DIR/templates" ts-minipc 2>/dev/null \
    || debconf-loadtemplate ts-minipc "$TS_DIR/templates" 2>/dev/null || true
  db_subst "$1" "$2" "$3" || true
  db_fset "$1" seen false || true
  db_input critical "$1" || true
  db_go || true
  exit 1
}

# Имя диска (без раздела) для устройства: /dev/sdb1 → sdb, /dev/nvme0n1p2 → nvme0n1, /dev/dm-0 → диски под ним.
parent_disks() {
  local name sys s
  name=$(basename "$(readlink -f "$1" 2>/dev/null || echo "$1")")
  sys=/sys/class/block/$name
  [ -e "$sys" ] || return 0
  if [ -d "$sys/slaves" ] && [ -n "$(ls "$sys/slaves" 2>/dev/null)" ]; then
    for s in "$sys"/slaves/*; do parent_disks "/dev/$(basename "$s")"; done
  elif [ -e "$sys/partition" ]; then
    basename "$(dirname "$(readlink -f "$sys")")"
  else
    echo "$name"
  fi
}

in_list() { # in_list <слово> <список через пробел>
  case " $2 " in *" $1 "*) return 0 ;; esac
  return 1
}

# ---------- 1. С чего идёт установка ----------
install_disks=""
for src in $(awk '$2 == "/cdrom" || $2 == "/hd-media" { print $1 }' /proc/mounts 2>/dev/null); do
  case "$src" in
    /dev/loop*)
      # ISO, смонтированный из файла: сам диск попадёт сюда через /hd-media
      ;;
    /dev/*) install_disks="$install_disks $(parent_disks "$src" | tr '\n' ' ')" ;;
  esac
done
log "носитель установки: ${install_disks:-не найден (загрузка по сети?)}"

# ---------- 2. Кандидаты ----------
best=""
best_size=0
candidates=""
summary=""
for dev in $(list-devices disk 2>/dev/null); do
  name=$(basename "$dev")
  sys=/sys/class/block/$name
  [ -e "$sys" ] || continue
  size=$(cat "$sys/size" 2>/dev/null || echo 0)
  gib=$((size / 2097152))
  skip=""
  if in_list "$name" "$install_disks"; then skip="флешка установки"; fi
  case "$name" in
    loop* | ram* | zram* | sr* | fd* | md* | dm-* | mmcblk*boot* | mmcblk*rpmb) skip=${skip:-служебное} ;;
  esac
  [ "$(cat "$sys/ro" 2>/dev/null)" = 1 ] && skip=${skip:-только чтение}
  [ "$(cat "$sys/removable" 2>/dev/null)" = 1 ] && skip=${skip:-съёмный}
  case "$(readlink -f "$sys" 2>/dev/null)" in
    */usb[0-9]* | */usb/*) skip=${skip:-USB} ;;
  esac
  [ "$size" -ge "$MIN_SECTORS" ] 2>/dev/null || skip=${skip:-меньше 14 ГиБ}
  summary="$summary $name ${gib}G${skip:+ ($skip)};"
  log "диск $dev: ${gib} ГиБ${skip:+ — пропускаю: $skip}"
  [ -z "$skip" ] || continue
  candidates="$candidates $name"
  if [ "$size" -gt "$best_size" ]; then
    best=$dev
    best_size=$size
  fi
done

[ -n "$best" ] || stop_install ts-minipc/no-disk DISKS "${summary:-нет}"

# ---------- 3. Не стоит ли тут уже TS ----------
if grep -qw 'ts_reinstall=1' /proc/cmdline 2>/dev/null; then
  log "ts_reinstall=1 — проверку «TS уже установлен» пропускаю"
else
  found=""
  modprobe ext4 >/dev/null 2>&1 || true
  lvm_on=0
  if command -v vgchange >/dev/null 2>&1 && vgchange -ay >/dev/null 2>&1; then lvm_on=1; fi
  mkdir -p "$MNT"
  parts=$(list-devices partition 2>/dev/null)
  for lv in /dev/mapper/*; do
    case "$lv" in /dev/mapper/control | "/dev/mapper/*") ;; *) parts="$parts $lv" ;; esac
  done
  for part in $parts; do
    pd=$(parent_disks "$part" | tr '\n' ' ')
    hit=0
    for d in $pd; do in_list "$d" "$candidates" && hit=1; done
    [ "$hit" = 1 ] || continue
    if [ "$(blkid -o value -s LABEL "$part" 2>/dev/null)" = "TS-HUB" ]; then
      found="$found $part"
      continue
    fi
    if mount -t ext4 -o ro,noload "$part" "$MNT" >/dev/null 2>&1; then
      if [ -e "$MNT/etc/ts-minipc/image-info" ] || [ -e "$MNT/etc/bills/hub.env" ] || [ -e "$MNT/var/lib/bills/hub.db" ]; then
        found="$found $part"
      fi
      umount "$MNT" >/dev/null 2>&1 || umount -l "$MNT" >/dev/null 2>&1 || true
    fi
  done
  [ "$lvm_on" = 0 ] || vgchange -an >/dev/null 2>&1 || true
  if [ -n "$found" ]; then
    stop_install ts-minipc/already-installed FOUND "${found# }"
  fi
fi

# ---------- 4. Ответы разметке и загрузчику ----------
log "ставлю TS на $best ($((best_size / 2097152)) ГиБ); все диски:$summary"
# Как в официальном example-preseed.txt: debconf-set из partman/early_command.
for q in partman-auto/disk grub-installer/bootdev; do
  if ! debconf-set "$q" "$best"; then
    db_set "$q" "$best" || true
    db_fset "$q" seen true || true
  fi
done
exit 0
