#!/usr/bin/env bash
# build-iso.sh — сборка образа «TS для мини-ПК» (TS-minipc-<версия>.iso) из официального
# Debian netinst amd64. Тот же скрипт запускает GitHub Actions (.github/workflows/minipc.yml).
#
#   deploy/minipc/build-iso.sh [--version 1.0.0] [--ref <sha|тег|ветка>] [--debian current|13.1.0]
#                              [--iso debian-….iso] [--out dist/minipc] [--timeout 15] [--gpg auto|require|off]
#                              [--serial]
#
# Нужно: bash, curl, xorriso, cpio, gzip, sha512sum/sha256sum, openssl; для проверки подписи — gpg.
#   Ubuntu/Debian: sudo apt-get install -y xorriso cpio gzip curl openssl gnupg grub-common
# Права root не нужны. Подробности и причины выбора Debian — deploy/minipc/README.md.
#
# --serial — образ для автоматической проверки установки в QEMU (deploy/minipc/test/vm-test.sh):
#   TS-minipc-<версия>-serial.iso, отличается от обычного ТОЛЬКО консолью и журналами: меню флешки
#   дублируется на COM-порт, ядру пунктов TS добавлено «console=ttyS0,115200n8 console=tty0»
#   (установщик по-прежнему на экране; установленная система получает те же параметры), а журнал
#   установщика уходит по сети QEMU на машину проверки (log_host=10.0.2.2, DEBCONF_DEBUG=5).
#
# Что делает:
#   1. Скачивает SHA512SUMS (+ подпись Debian CD) и netinst ISO, проверяет контрольную сумму.
#   2. Собирает initrd «TS»: исходный install.amd/initrd.gz + дописанный cpio с preseed.cfg,
#      скриптами установщика (d-i/), файлами для новой системы (target/) и копией deploy/linux.
#      Исходный initrd не трогается — его использует пункт «обычный установщик Debian».
#   3. Заменяет меню загрузки (GRUB для UEFI, isolinux для BIOS) на меню TS с таймаутом.
#   4. Пересобирает ISO через xorriso с «-boot_image any replay»: загрузка BIOS и UEFI и гибридная
#      разметка для флешки берутся из оригинального образа Debian без изменений.

set -Eeuo pipefail
trap 'echo "[TS] ОШИБКА: сборка прервана (строка $LINENO): $BASH_COMMAND" >&2' ERR

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

DEBIAN_VERSION="${DEBIAN_VERSION:-current}"
DEBIAN_MIRROR="${DEBIAN_MIRROR:-https://cdimage.debian.org}"
DEBIAN_ISO="${DEBIAN_ISO:-}"
DEBIAN_GPG="${DEBIAN_GPG:-auto}"
TS_VERSION="${TS_VERSION:-}"
TS_REF="${TS_REF:-}"
TS_REPO="${TS_REPO:-https://github.com/ansa-music/billS.git}"
OUT_DIR="${OUT_DIR:-$ROOT/dist/minipc}"
WORK_DIR="${WORK_DIR:-}"
CACHE_DIR="${CACHE_DIR:-}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-15}"
SERIAL=0
# Образ --serial: журнал установщика — на 10.0.2.2:5514 (хост QEMU, vm-test.sh), консоль — и на COM-порт.
# tty0 последним — установщик остаётся на экране, как на мини-ПК. Параметры после «---» переходят
# в установленную систему, до «---» — только установщику.
SERIAL_DI_ARGS="log_host=10.0.2.2 log_port=5514 DEBCONF_DEBUG=5"
SERIAL_KERNEL_ARGS="console=ttyS0,115200n8 console=tty0"
KEEP_WORK=0
MAX_SIZE=2147483648 # 2 ГиБ — предел файла в GitHub Releases

# Ключи подписи образов Debian (https://www.debian.org/CD/verify), отпечатки сверены.
DEBIAN_CD_KEYS=(DF9B9C49EAA9298432589D76DA87E80D6294BE9B 10460DAD76165AD81FBC0CE9988021A964E6EA7D)

log() { printf '[TS] %s\n' "$*"; }
warn() { printf '[TS] ВНИМАНИЕ: %s\n' "$*" >&2; }
die() { printf '[TS] ОШИБКА: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) TS_VERSION="$2"; shift 2 ;;
    --ref) TS_REF="$2"; shift 2 ;;
    --repo) TS_REPO="$2"; shift 2 ;;
    --debian) DEBIAN_VERSION="$2"; shift 2 ;;
    --iso) DEBIAN_ISO="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --work) WORK_DIR="$2"; shift 2 ;;
    --cache) CACHE_DIR="$2"; shift 2 ;;
    --timeout) BOOT_TIMEOUT="$2"; shift 2 ;;
    --gpg) DEBIAN_GPG="$2"; shift 2 ;;
    --keep-work) KEEP_WORK=1; shift ;;
    --serial) SERIAL=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
  esac
done

for c in curl xorriso cpio gzip sha512sum sha256sum md5sum openssl awk sed; do
  command -v "$c" >/dev/null 2>&1 || die "не найдена программа '$c' (sudo apt-get install -y xorriso cpio gzip curl openssl)"
done

# ---------- Версия и ref TS ----------
if [ -z "$TS_REF" ]; then
  if git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1; then
    TS_REF="$(git -C "$ROOT" rev-parse HEAD)"
    if [ -z "$(git -C "$ROOT" branch -r --contains HEAD 2>/dev/null)" ]; then
      warn "коммит $TS_REF не найден в origin: мини-ПК сможет поставить его, только когда он будет на GitHub (или укажите --ref main)"
    fi
  else
    TS_REF=main
  fi
fi
[ -n "$TS_VERSION" ] || TS_VERSION="dev-${TS_REF:0:7}"
[[ "$TS_VERSION" =~ ^[0-9A-Za-z._-]+$ ]] || die "--version: только буквы, цифры, точка, дефис, подчёркивание"
[[ "$TS_REF" =~ ^[0-9A-Za-z._/-]+$ ]] || die "--ref: недопустимые символы"
[[ "$TS_REPO" =~ ^https://[A-Za-z0-9./_-]+$ ]] || die "--repo: нужен адрес https://… без пробелов и кавычек"
[[ "$BOOT_TIMEOUT" =~ ^[0-9]+$ ]] && [ "$BOOT_TIMEOUT" -ge 5 ] || die "--timeout: число секунд, не меньше 5"
case "$DEBIAN_GPG" in auto | require | off) ;; *) die "--gpg: auto, require или off" ;; esac

# ---------- Рабочие папки ----------
if [ -z "$WORK_DIR" ]; then
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ts-minipc.XXXXXX")"
else
  mkdir -p "$WORK_DIR"
fi
WORK_DIR="$(cd "$WORK_DIR" && pwd)"
CACHE_DIR="${CACHE_DIR:-$WORK_DIR/cache}"
mkdir -p "$CACHE_DIR" "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
cleanup() { [ "$KEEP_WORK" -eq 1 ] || rm -rf -- "$WORK_DIR/x" "$WORK_DIR/overlay" "$WORK_DIR/gnupg"; }
trap cleanup EXIT
X="$WORK_DIR/x"
rm -rf -- "$X"
mkdir -p "$X"

# ---------- 1. Debian netinst ----------
verify_sums_signature() { # <SHA512SUMS> <SHA512SUMS.sign>
  [ "$DEBIAN_GPG" != off ] || { warn "проверка подписи Debian отключена (--gpg off)"; return 0; }
  local fail=warn
  [ "$DEBIAN_GPG" = require ] && fail=die
  command -v gpg >/dev/null 2>&1 || { $fail "нет gpg — подпись SHA512SUMS не проверена"; return 0; }
  [ -s "$2" ] || { $fail "нет SHA512SUMS.sign — подпись не проверена"; return 0; }
  local gh="$WORK_DIR/gnupg" fpr keys="$WORK_DIR/debian-cd-keys.asc" status
  rm -rf -- "$gh" && mkdir -m 700 "$gh"
  : >"$keys"
  for fpr in "${DEBIAN_CD_KEYS[@]}"; do
    curl -fsS --retry 3 --max-time 60 "https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0x$fpr" >>"$keys" 2>/dev/null || true
  done
  if ! GNUPGHOME="$gh" gpg --batch --quiet --import "$keys" 2>/dev/null; then
    $fail "не удалось получить ключи Debian CD с keyserver.ubuntu.com — подпись не проверена"
    return 0
  fi
  status="$(GNUPGHOME="$gh" gpg --batch --status-fd 1 --verify "$2" "$1" 2>/dev/null || true)"
  # VALIDSIG …последнее поле — отпечаток основного ключа; принимаем только ключи из списка.
  fpr="$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $NF; exit }')"
  for k in "${DEBIAN_CD_KEYS[@]}"; do
    if [ "$fpr" = "$k" ]; then log "Подпись SHA512SUMS верна (ключ Debian CD $k)"; return 0; fi
  done
  die "подпись SHA512SUMS не подтверждена ключом Debian CD (получено: ${fpr:-нет подписи})"
}

fetch_debian() {
  local base sums="$CACHE_DIR/SHA512SUMS" name
  if [ "$DEBIAN_VERSION" = current ]; then
    base="$DEBIAN_MIRROR/debian-cd/current/amd64/iso-cd"
  else
    [[ "$DEBIAN_VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || die "--debian: current или номер версии, например 13.1.0"
    base="$DEBIAN_MIRROR/debian-cd/$DEBIAN_VERSION/amd64/iso-cd"
    curl -fsS --head --max-time 30 "$base/SHA512SUMS" >/dev/null 2>&1 || base="$DEBIAN_MIRROR/cdimage/archive/$DEBIAN_VERSION/amd64/iso-cd"
  fi
  log "Debian: $base"
  curl -fsSL --retry 3 "$base/SHA512SUMS" -o "$sums" || die "не удалось скачать $base/SHA512SUMS"
  curl -fsSL --retry 3 "$base/SHA512SUMS.sign" -o "$sums.sign" 2>/dev/null || rm -f "$sums.sign"
  verify_sums_signature "$sums" "$sums.sign"
  name="$(grep -oE 'debian-[0-9][0-9.]*-amd64-netinst\.iso' "$sums" | head -n 1)"
  [ -n "$name" ] || die "в SHA512SUMS нет debian-*-amd64-netinst.iso"
  DEBIAN_ISO="$CACHE_DIR/$name"
  if [ -f "$DEBIAN_ISO" ] && (cd "$CACHE_DIR" && grep " $name\$" SHA512SUMS | sha512sum -c --quiet - >/dev/null 2>&1); then
    log "Уже скачан: $name"
    return 0
  fi
  log "Скачиваю $name ..."
  curl -fL --retry 3 --progress-bar "$base/$name" -o "$DEBIAN_ISO.part" || die "не удалось скачать $base/$name"
  mv -f "$DEBIAN_ISO.part" "$DEBIAN_ISO"
  (cd "$CACHE_DIR" && grep " $name\$" SHA512SUMS | sha512sum -c --quiet -) || die "контрольная сумма $name не совпала с SHA512SUMS"
  log "Контрольная сумма SHA512 верна: $name"
}

if [ -n "$DEBIAN_ISO" ]; then
  [ -f "$DEBIAN_ISO" ] || die "нет файла $DEBIAN_ISO"
  DEBIAN_ISO="$(cd "$(dirname "$DEBIAN_ISO")" && pwd)/$(basename "$DEBIAN_ISO")"
  warn "используется готовый образ $DEBIAN_ISO — контрольную сумму проверяйте сами"
else
  fetch_debian
fi

# Список файлов образа один раз (xorriso -lsd возвращает 0 и для отсутствующего файла).
ISO_FILES="$(xorriso -indev "$DEBIAN_ISO" -find / 2>/dev/null)" || die "xorriso не прочитал $DEBIAN_ISO"
iso_has() { grep -Fxq "'$1'" <<<"$ISO_FILES"; }
for f in /install.amd/vmlinuz /install.amd/initrd.gz /boot/grub/grub.cfg; do
  iso_has "$f" || die "в $DEBIAN_ISO нет $f — это не Debian netinst amd64?"
done
HAS_ISOLINUX=0
iso_has /isolinux/isolinux.cfg && HAS_ISOLINUX=1
[ "$HAS_ISOLINUX" -eq 1 ] || warn "в образе нет isolinux (BIOS) — меню TS только в GRUB"

extract=(-extract /install.amd/initrd.gz "$X/initrd.gz" -extract /boot/grub/grub.cfg "$X/grub-debian.cfg")
[ "$HAS_ISOLINUX" -eq 1 ] && extract+=(-extract /isolinux/isolinux.cfg "$X/isolinux-debian.cfg")
iso_has /md5sum.txt && extract+=(-extract /md5sum.txt "$X/md5sum.txt")
iso_has /sha256sum.txt && extract+=(-extract /sha256sum.txt "$X/sha256sum.txt")
xorriso -osirrox on -indev "$DEBIAN_ISO" "${extract[@]}" >/dev/null 2>&1 || die "не удалось извлечь файлы из $DEBIAN_ISO"
chmod -R u+w "$X"
DEBIAN_NAME="$(basename "$DEBIAN_ISO")"

# ---------- 2. initrd TS ----------
log "Собираю initrd TS (preseed + скрипты, ref $TS_REF)"
OV="$WORK_DIR/overlay"
rm -rf -- "$OV"
T="$OV/ts-minipc/target"
mkdir -p "$OV/ts-minipc/network" "$T/opt/ts-minipc/linux/systemd" "$T/etc/systemd/system"

BUILT_EPOCH="$(date +%s)"
{
  echo "# TS для мини-ПК: из чего собран образ (deploy/minipc/build-iso.sh)"
  echo "TS_VERSION='$TS_VERSION'"
  echo "TS_REF='$TS_REF'"
  echo "TS_REPO='$TS_REPO'"
  echo "TS_BUILT='$(date -u -d "@$BUILT_EPOCH" +%Y-%m-%dT%H:%M:%SZ)'"
  echo "TS_BUILT_EPOCH='$BUILT_EPOCH'"
  echo "TS_DEBIAN_ISO='$DEBIAN_NAME'"
  [ "$SERIAL" -eq 0 ] || echo "TS_SERIAL_CONSOLE='1'"
} >"$OV/ts-minipc/build-info"

# Пароль пользователя ts на время установки: хэш случайного пароля, который тут же забывается.
PW_HASH="$(head -c 32 /dev/urandom | base64 | openssl passwd -6 -stdin)"
sed "s|@TS_USER_PASSWORD_HASH@|$PW_HASH|" "$HERE/preseed.cfg" >"$OV/preseed.cfg"
grep -q '@TS_' "$OV/preseed.cfg" && die "в preseed.cfg остались подстановки @TS_…@"

install -m 755 "$HERE/d-i/pick-disk.sh" "$HERE/d-i/late.sh" "$OV/ts-minipc/"
install -m 644 "$HERE/d-i/templates" "$OV/ts-minipc/templates"
install -m 644 "$HERE"/network/* "$OV/ts-minipc/network/"
install -m 755 "$HERE"/target/opt/ts-minipc/*.sh "$T/opt/ts-minipc/"
install -m 644 "$HERE"/target/etc/systemd/system/*.service "$T/etc/systemd/system/"
install -m 644 "$OV/ts-minipc/build-info" "$T/opt/ts-minipc/build-info"
# Копия deploy/linux той же версии: первая загрузка ставит HUB именно ею.
install -m 755 "$ROOT"/deploy/linux/*.sh "$T/opt/ts-minipc/linux/"
install -m 644 "$ROOT"/deploy/linux/*.example "$ROOT"/deploy/linux/*.md "$T/opt/ts-minipc/linux/"
install -m 644 "$ROOT"/deploy/linux/systemd/* "$T/opt/ts-minipc/linux/systemd/"
find "$OV" -type d -exec chmod 755 {} +

(cd "$OV" && find . -mindepth 1 | sed 's|^\./||' | LC_ALL=C sort | cpio -o -H newc -R 0:0 --quiet) | gzip -9n >"$X/overlay.cpio.gz"
# Ядро Linux распаковывает подряд идущие сжатые cpio-архивы: исходный initrd + наш.
cat "$X/initrd.gz" "$X/overlay.cpio.gz" >"$X/ts-initrd.gz"

# ---------- 3. Меню загрузки ----------
sed -e "s|@TIMEOUT@|$BOOT_TIMEOUT|g" -e "s|@TS_VERSION@|$TS_VERSION|g" "$HERE/boot/grub.cfg" >"$X/grub.cfg"
# --serial: те же пункты меню, только с последовательной консолью (см. шапку).
serial_menu() { # serial_menu <файл меню> <строка в начало (пусто — не нужна)>
  local f="$1" kernel_lines
  kernel_lines="$(grep -c -- ' --- quiet$' "$f" || true)"
  [ "$kernel_lines" -gt 0 ] || die "в $f нет строк ядра «… --- quiet» — шаблон меню изменился?"
  sed -i "s| --- quiet\$| $SERIAL_DI_ARGS --- quiet $SERIAL_KERNEL_ARGS|" "$f"
  [ "$(grep -c -- " --- quiet $SERIAL_KERNEL_ARGS\$" "$f")" -eq "$kernel_lines" ] || die "не удалось добавить консоль в $f"
  [ -z "$2" ] || sed -i "1i $2" "$f"
}
if [ "$SERIAL" -eq 1 ]; then
  log "Образ для проверки в QEMU: консоль ttyS0 (--serial)"
  serial_menu "$X/grub.cfg" ""
  sed -i 's|^# @TS_SERIAL@$|serial --unit=0 --speed=115200\nterminal_input --append serial\nterminal_output --append serial|' "$X/grub.cfg"
  grep -q '^terminal_output --append serial$' "$X/grub.cfg" || die "в grub.cfg нет метки # @TS_SERIAL@"
else
  sed -i '/^# @TS_SERIAL@$/d' "$X/grub.cfg"
fi
map=(
  -map "$X/ts-initrd.gz" /install.amd/ts-initrd.gz
  -map "$X/grub.cfg" /boot/grub/grub.cfg
  -map "$X/grub-debian.cfg" /boot/grub/grub-debian.cfg
)
if [ "$HAS_ISOLINUX" -eq 1 ]; then
  sed -e "s|@TIMEOUT_DS@|$((BOOT_TIMEOUT * 10))|g" -e "s|@TS_VERSION@|$TS_VERSION|g" "$HERE/boot/isolinux.cfg" >"$X/isolinux.cfg"
  # isolinux: директива serial должна идти первой.
  [ "$SERIAL" -eq 0 ] || serial_menu "$X/isolinux.cfg" "serial 0 115200"
  map+=(-map "$X/isolinux.cfg" /isolinux/isolinux.cfg -map "$X/isolinux-debian.cfg" /isolinux/isolinux-debian.cfg)
fi
# Шрифт GRUB с кириллицей (если есть на машине сборки); иначе — шрифт Debian.
if [ -r /usr/share/grub/unicode.pf2 ]; then
  map+=(-map /usr/share/grub/unicode.pf2 /boot/grub/ts-unicode.pf2)
else
  warn "нет /usr/share/grub/unicode.pf2 (пакет grub-common) — меню UEFI возьмёт шрифт Debian"
fi
{
  echo "TS для мини-ПК $TS_VERSION"
  echo "Собран из ansa-music/billS @ $TS_REF на основе $DEBIAN_NAME."
  echo "Установка с этой флешки СТИРАЕТ диск мини-ПК. Инструкция: docs/MINIPC_RU.md"
} >"$X/TS-MINIPC.txt"
map+=(-map "$X/TS-MINIPC.txt" /TS-MINIPC.txt)

# Контрольные суммы файлов внутри образа (их проверяет пункт «Проверка носителя» установщика).
update_sums() { # <файл сумм> <программа> <путь в ISO> <локальный файл> ...
  local sumfile="$1" prog="$2" p f h tmp
  shift 2
  [ -f "$sumfile" ] || return 0
  while [ $# -gt 0 ]; do
    p="$1" f="$2"
    shift 2
    h="$($prog "$f" | awk '{ print $1 }')"
    tmp="$sumfile.tmp"
    awk -v p="./${p#/}" '$2 != p' "$sumfile" >"$tmp"
    printf '%s  ./%s\n' "$h" "${p#/}" >>"$tmp"
    mv -f "$tmp" "$sumfile"
  done
}
pairs=()
for ((i = 0; i < ${#map[@]}; i += 3)); do pairs+=("${map[i + 2]}" "${map[i + 1]}"); done
update_sums "$X/md5sum.txt" md5sum "${pairs[@]}"
update_sums "$X/sha256sum.txt" sha256sum "${pairs[@]}"
[ -f "$X/md5sum.txt" ] && map+=(-map "$X/md5sum.txt" /md5sum.txt)
[ -f "$X/sha256sum.txt" ] && map+=(-map "$X/sha256sum.txt" /sha256sum.txt)

# ---------- 4. Сборка ISO ----------
OUT_ISO="$OUT_DIR/TS-minipc-$TS_VERSION.iso"
[ "$SERIAL" -eq 0 ] || OUT_ISO="$OUT_DIR/TS-minipc-$TS_VERSION-serial.iso"
rm -f -- "$OUT_ISO" "$OUT_ISO.sha256"
log "Пересобираю образ: $OUT_ISO"
xorriso -report_about WARNING -indev "$DEBIAN_ISO" -outdev "$OUT_ISO" "${map[@]}" -boot_image any replay \
  || die "xorriso не смог собрать образ"

size="$(stat -c %s "$OUT_ISO")"
[ "$size" -lt "$MAX_SIZE" ] || die "образ $((size / 1048576)) МБ — больше 2 ГиБ, GitHub Releases его не примет"
(cd "$OUT_DIR" && sha256sum "$(basename "$OUT_ISO")" >"$(basename "$OUT_ISO").sha256")
log "Готово: $OUT_ISO ($((size / 1048576)) МБ)"
log "SHA256: $(cut -d' ' -f1 "$OUT_ISO.sha256")"
xorriso -indev "$OUT_ISO" -report_el_torito plain 2>/dev/null | grep -E 'El Torito (boot img|img path)' | sed 's/^/[TS]   /' || true
