#!/bin/sh
# shellcheck shell=sh disable=SC3043
# late.sh — последний шаг установщика Debian (preseed/late_command): ставит в новую систему
# (она смонтирована в /target) файлы TS для первой загрузки. Среда — busybox sh установщика.
#
# Что делает:
#   1. /opt/ts-minipc: firstboot.sh, console.sh, build-info и копия deploy/linux той же версии;
#      /etc/ts-minipc/image-info — признак «здесь стоит TS» (его ищут меню флешки и pick-disk.sh).
#   2. Службы ts-firstboot (ставит HUB при первой загрузке) и ts-console (адрес HUB на экране, tty1).
#   3. Экран: шрифт с кириллицей и псевдографикой для QR-кода.
#   4. Сеть: systemd-networkd + systemd-resolved — DHCP на любом проводном порту, переподключение
#      кабеля и поздно включившийся роутер подхватываются без перезагрузки (ifupdown так не умеет).
#      Сеть переключается, только когда в новой системе есть и networkd, и resolved; иначе
#      остаётся сеть, которую настроил установщик (ifupdown).
#   5. Автоматические обновления безопасности; apt ждёт чужую блокировку, а не падает
#      (первая загрузка ставит пакеты, пока apt-daily может обновлять списки).
#   6. Установка с последовательной консолью (console=ttyS…, так её запускает проверка в CI):
#      журнал systemd дублируется на эту консоль, чтобы ход первой загрузки был виден снаружи.

set -e
TS=/ts-minipc
T=/target

log() {
  echo "ts-minipc: $*" >&2
  logger -t ts-minipc -- "$*" 2>/dev/null || true
}

[ -d "$T/etc" ] || { log "нет $T/etc — система не смонтирована?"; exit 1; }

# ---------- 1. Файлы TS ----------
log "копирую файлы TS в /opt/ts-minipc"
mkdir -p "$T/opt/ts-minipc" "$T/etc/ts-minipc" "$T/etc/systemd/system/multi-user.target.wants"
cp -a "$TS/target/." "$T/"
chown -R 0:0 "$T/opt/ts-minipc"
chmod 755 "$T/opt/ts-minipc" "$T/opt/ts-minipc/"*.sh "$T/opt/ts-minipc/linux/"*.sh
chmod 644 "$T/etc/systemd/system/ts-firstboot.service" "$T/etc/systemd/system/ts-console.service"

disk=$(debconf-get partman-auto/disk 2>/dev/null || true)
{
  cat "$TS/build-info"
  echo "TS_INSTALLED_AT='$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
  echo "TS_TARGET_DISK='${disk:-unknown}'"
} >"$T/etc/ts-minipc/image-info"
chmod 644 "$T/etc/ts-minipc/image-info"

# ---------- 2. Службы ----------
ln -sf /etc/systemd/system/ts-firstboot.service "$T/etc/systemd/system/multi-user.target.wants/ts-firstboot.service"
ln -sf /etc/systemd/system/ts-console.service "$T/etc/systemd/system/multi-user.target.wants/ts-console.service"
# tty1 занимает экран TS; вход для техподдержки — Ctrl+Alt+F2.
rm -f "$T/etc/systemd/system/getty.target.wants/getty@tty1.service"

# ---------- 3. Экран: кириллица + блоки ▀▄█ для QR-кода (есть в FullCyrSlav) ----------
cat >"$T/etc/default/console-setup" <<'EOF'
# TS: шрифт консоли с кириллицей и псевдографикой (для QR-кода на экране мини-ПК).
ACTIVE_CONSOLES="/dev/tty[1-6]"
CHARMAP="UTF-8"
CODESET="FullCyrSlav"
FONTFACE="Fixed"
FONTSIZE="8x16"
VIDEOMODE=
EOF
# Основной язык системы — русский (установщик работал по-английски, см. preseed.cfg).
if grep -q '^ru_RU.UTF-8' "$T/etc/locale.gen" 2>/dev/null || [ -d "$T/usr/lib/locale/ru_RU.utf8" ]; then
  in-target update-locale LANG=ru_RU.UTF-8 >/dev/null 2>&1 || log "update-locale ru_RU.UTF-8 не удался"
else
  sed -i 's/^# *ru_RU.UTF-8 UTF-8/ru_RU.UTF-8 UTF-8/' "$T/etc/locale.gen" 2>/dev/null
  { in-target locale-gen >/dev/null 2>&1 && in-target update-locale LANG=ru_RU.UTF-8 >/dev/null 2>&1; } \
    || log "русская локаль не собрана — экран TS задаёт LANG сам"
fi
in-target setupcon --save-only >/dev/null 2>&1 || log "setupcon --save-only не удался — шрифт загрузит ts-console"
mkdir -p "$T/etc/sysctl.d"
echo 'kernel.printk = 3 4 1 3' >"$T/etc/sysctl.d/90-ts-console.conf"

# ---------- 4. Сеть ----------
target_has() { # target_has <программа из /usr/lib/systemd>
  [ -x "$T/usr/lib/systemd/$1" ] || [ -x "$T/lib/systemd/$1" ]
}
target_apt() { # пакет в новую систему: штатным apt-install установщика, иначе apt-get внутри /target
  apt-install "$1" >/dev/null 2>&1 || in-target apt-get -y -q install "$1" >/dev/null 2>&1
}
# systemd-networkd входит в пакет systemd; если в этой версии Debian он отдельный — доставим.
target_has systemd-networkd || target_apt systemd-networkd || true
# systemd-resolved ставим последним: после его установки DNS внутри /target до перезагрузки не работает.
if ! target_has systemd-networkd; then
  log "в новой системе нет systemd-networkd — оставляю сеть, настроенную установщиком (ifupdown)"
elif ! target_has systemd-resolved && ! { target_apt systemd-resolved && target_has systemd-resolved; }; then
  log "systemd-resolved не установился — оставляю сеть, настроенную установщиком (ifupdown)"
elif ! in-target systemctl enable systemd-networkd.service systemd-resolved.service >/dev/null 2>&1; then
  # resolved уже включён своим пакетом и берёт DNS у ifupdown; networkd не трогаем.
  log "systemctl enable systemd-networkd не удался — оставляю ifupdown"
else
  log "сеть: systemd-networkd + systemd-resolved"
  mkdir -p "$T/etc/systemd/network" "$T/etc/systemd/resolved.conf.d" \
    "$T/etc/systemd/system/systemd-networkd-wait-online.service.d"
  cp "$TS/network/20-ts-wired.network" "$T/etc/systemd/network/20-ts-wired.network"
  cp "$TS/network/resolved-ts.conf" "$T/etc/systemd/resolved.conf.d/ts.conf"
  cp "$TS/network/wait-online-ts.conf" "$T/etc/systemd/system/systemd-networkd-wait-online.service.d/ts.conf"
  if [ -f "$T/etc/network/interfaces" ] && [ ! -f "$T/etc/network/interfaces.before-ts" ]; then
    mv "$T/etc/network/interfaces" "$T/etc/network/interfaces.before-ts"
  fi
  cat >"$T/etc/network/interfaces" <<'EOF'
# TS: проводными портами управляет systemd-networkd (/etc/systemd/network/20-ts-wired.network).
# Прежняя настройка установщика — interfaces.before-ts.
source /etc/network/interfaces.d/*

auto lo
iface lo inet loopback
EOF
  ln -sf /run/systemd/resolve/stub-resolv.conf "$T/etc/resolv.conf"
fi

# ---------- 5. Обновления безопасности и блокировка apt ----------
mkdir -p "$T/etc/apt/apt.conf.d"
cat >"$T/etc/apt/apt.conf.d/20auto-upgrades" <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat >"$T/etc/apt/apt.conf.d/90ts-lock-timeout" <<'EOF'
// TS: если apt уже занят (apt-daily, обновления безопасности) — ждать до 10 минут, а не падать.
DPkg::Lock::Timeout "600";
EOF

# ---------- 6. Последовательная консоль ----------
serial=$(tr ' ' '\n' </proc/cmdline | sed -n 's/^console=\(ttyS[0-9]*\).*/\1/p' | head -n 1)
if [ -n "$serial" ]; then
  log "установка с консолью $serial: журнал systemd дублируется на неё"
  mkdir -p "$T/etc/systemd/journald.conf.d"
  cat >"$T/etc/systemd/journald.conf.d/90-ts-serial.conf" <<EOF
# TS: установка шла с console=$serial — ход первой загрузки виден на последовательной консоли.
[Journal]
ForwardToConsole=yes
TTYPath=/dev/$serial
MaxLevelConsole=info
EOF
fi

log "готово: после перезагрузки ts-firstboot установит HUB"
exit 0
