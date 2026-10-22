#!/usr/bin/env bash
# console.sh — экран мини-ПК (tty1, служба ts-console.service).
#
# Показывает крупно, что происходит, и куда идти дальше:
#   - во время первой установки: «Подключите кабель интернета» / «Идёт установка» / ошибка и повтор;
#   - TS установлен, мастер не пройден: адрес http://<ip>:4310/setup + QR-код + пароль администратора;
#   - мастер пройден (GET /api/setup/status говорит «закрыт») или HUB уже подключён к облаку:
#     адрес для экранов клуба http://<ip>:4310/ + QR-код. Пароль больше не показывается.
# 404 от /api/setup/status = «неизвестно»: показываем адрес настройки, пока HUB не подключён к облаку.
# Экран перерисовывается, когда меняется адрес или состояние (проверка каждые 3 секунды).

set -uo pipefail

TS_DIR=/opt/ts-minipc
STATE_DIR=/var/lib/ts-minipc
RUN_DIR=/run/ts-minipc
ENV_FILE=/etc/bills/hub.env
PASSWORD_FILE="$STATE_DIR/admin-password"
TTY=/dev/tty1
TS_VERSION=""
# shellcheck source=/dev/null
[ -r "$TS_DIR/build-info" ] && . "$TS_DIR/build-info"

E=$'\033'
BOLD="${E}[1m" OFF="${E}[0m" GREEN="${E}[1;32m" YELLOW="${E}[1;33m" RED="${E}[1;31m" CYAN="${E}[1;36m"
HALF_BLOCKS=0 # 1 — шрифт с ▀▄ загружен, можно компактный QR (ANSIUTF8)

# ---------- Экран ----------
setup_tty() {
  local f
  for f in /usr/share/consolefonts/FullCyrSlav-Fixed16.psf.gz /usr/share/consolefonts/Uni2-Fixed16.psf.gz; do
    if [ -r "$f" ] && setfont -C "$TTY" "$f" >/dev/null 2>&1; then
      case "$f" in *FullCyrSlav*) HALF_BLOCKS=1 ;; esac
      break
    fi
  done
  setterm --blank 0 --powerdown 0 --cursor off 2>/dev/null || true
  printf '%s' "${E}[0m${E}[H${E}[2J"
}

tty_size() { # печатает «строки столбцы»
  local s
  s=$(stty -F "$TTY" size 2>/dev/null) || s=""
  case "$s" in [0-9]*' '[0-9]*) printf '%s' "$s" ;; *) printf '25 80' ;; esac
}

# ---------- Данные ----------
# Значение KEY из hub.env (последняя незакомментированная строка) или значение по умолчанию.
env_get() {
  local v=""
  [ -r "$ENV_FILE" ] && v=$(awk -v k="$1" '
    /^[[:space:]]*#/ { next }
    { line = $0; sub(/^[[:space:]]+/, "", line); if (index(line, k "=") == 1) val = substr(line, length(k) + 2) }
    END { sub(/\r$/, "", val); print val }' "$ENV_FILE")
  printf '%s' "${v:-${2:-}}"
}

# Адрес мини-ПК в сети клуба (не Tailscale).
lan_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')
  case "$ip" in 100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) ip="" ;; esac
  if [ -z "$ip" ]; then
    ip=$(ip -4 -o addr show scope global 2>/dev/null \
      | awk '$2 !~ /^(tailscale|docker|veth|br-|virbr|lo)/ { sub(/\/.*/, "", $4); print $4; exit }')
  fi
  printf '%s' "$ip"
}

# Как обращаться к HUB: BASE — с этого же мини-ПК, SCHEME/PORT_SUFFIX — для людей.
CURL_TLS=()
hub_addr() {
  local port tls ca
  port=$(env_get HUB_PORT 4310)
  tls=$(env_get HUB_TLS_CERT "")
  CURL_TLS=()
  if [ -n "$tls" ]; then
    SCHEME=https
    ca=$(env_get HUB_TLS_CA "")
    CURL_TLS=(--cacert "${ca:-$(dirname "$tls")/ca.crt}")
  else
    SCHEME=http
  fi
  BASE="$SCHEME://127.0.0.1:$port"
  PORT_SUFFIX=":$port"
  if { [ "$SCHEME" = http ] && [ "$port" = 80 ]; } || { [ "$SCHEME" = https ] && [ "$port" = 443 ]; }; then
    PORT_SUFFIX=""
  fi
  MDNS=$(env_get HUB_MDNS_NAME "")
  MDNS=${MDNS%.local}
}

hub_healthy() {
  curl -fsS --max-time 3 "${CURL_TLS[@]}" "$BASE/api/health" 2>/dev/null | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
}

# Мастер настройки HUB: open | closed | unknown (нет такого адреса = unknown).
setup_state() {
  local out code body
  out=$(curl -sS --max-time 3 "${CURL_TLS[@]}" -w $'\n%{http_code}' "$BASE/api/setup/status" 2>/dev/null) || { echo unknown; return; }
  code=${out##*$'\n'}
  body=${out%$'\n'*}
  [ "$code" = 200 ] || { echo unknown; return; }
  if grep -Eqi '"(open|required|needed|pending)"[[:space:]]*:[[:space:]]*false|"(closed|done|configured|complete|completed|finished)"[[:space:]]*:[[:space:]]*true|"(status|state)"[[:space:]]*:[[:space:]]*"(closed|done|configured|complete|completed|finished)"' <<<"$body"; then
    echo closed
  elif grep -Eqi '"(open|required|needed|pending)"[[:space:]]*:[[:space:]]*true|"(status|state)"[[:space:]]*:[[:space:]]*"(open|pending|required)"' <<<"$body"; then
    echo open
  else
    echo unknown
  fi
}

cloud_connected() { [ -n "$(env_get CLOUD_URL)" ] && [ -n "$(env_get HUB_ID)" ] && [ -n "$(env_get CLOUD_API_KEY)" ]; }

read_run() { [ -r "$RUN_DIR/$1" ] && head -n 1 "$RUN_DIR/$1"; }

# ---------- Части экрана ----------
LOGO=(
  "████████  ███████"
  "   ██     ██     "
  "   ██     ███████"
  "   ██          ██"
  "   ██     ███████"
)

logo() { # logo <цвет> <надпись справа>
  local i
  echo
  for i in "${!LOGO[@]}"; do
    if [ "$i" -eq 2 ]; then
      printf '   %s%s%s    %s\n' "$1" "${LOGO[$i]}" "$OFF" "$2"
    else
      printf '   %s%s%s\n' "$1" "${LOGO[$i]}" "$OFF"
    fi
  done
  echo
}

# QR-код, если помещается: крупный (2 пробела на точку), иначе компактный (▀▄), иначе ничего.
qr_block() { # qr_block <адрес> <свободных строк> <столбцов>
  command -v qrencode >/dev/null 2>&1 || return 1
  local t q lines
  for t in ANSI ANSIUTF8; do
    [ "$t" = ANSIUTF8 ] && [ "$HALF_BLOCKS" -ne 1 ] && continue
    q=$(qrencode -t "$t" -m 2 -o - "$1" 2>/dev/null) || continue
    lines=$(printf '%s\n' "$q" | wc -l)
    if [ "$lines" -le "$2" ] && [ $((lines * 2 + 6)) -le "$3" ]; then
      printf '%s\n' "$q" | sed 's/^/      /'
      return 0
    fi
  done
  return 1
}

footer() {
  local ip="$1" pw=""
  [ "${2:-}" = with-password ] && [ -r "$PASSWORD_FILE" ] && pw=$(head -n 1 "$PASSWORD_FILE")
  echo
  if [ -n "$pw" ]; then
    printf '   Пароль администратора мини-ПК (для техподдержки): %s%s%s — запишите.\n' "$BOLD" "$pw" "$OFF"
  fi
  printf '   Мини-ПК %s · адрес %s · TS %s\n' "$(hostname 2>/dev/null || echo ts-hub)" "${ip:-нет сети}" "${TS_VERSION:-?}"
}

# ---------- Экраны ----------
# Каждый печатает текст без QR в TEXT и адрес для QR в QR_URL.
screen_install() {
  local state detail since mins ip
  state=$(read_run state)
  detail=$(read_run detail)
  ip=$(lan_ip)
  since=$(stat -c %Y "$RUN_DIR/state" 2>/dev/null || date +%s)
  mins=$((($(date +%s) - since) / 60))
  case "$state" in
    nonet)
      logo "$YELLOW" "${YELLOW}Подключите кабель интернета${OFF}"
      echo "   Вставьте кабель от роутера клуба в мини-ПК."
      echo "   Установка TS продолжится сама, как только появится интернет."
      [ -n "$detail" ] && echo "   ($detail)"
      ;;
    nointernet)
      logo "$YELLOW" "${YELLOW}Нет интернета${OFF}"
      echo "   Кабель подключён, но роутер не выпускает в интернет."
      echo "   Проверьте роутер — установка TS продолжится сама."
      ;;
    clock)
      logo "$CYAN" "${CYAN}Настраиваю часы мини-ПК…${OFF}"
      ;;
    installing)
      logo "$CYAN" "${CYAN}Идёт установка TS — не выключайте мини-ПК${OFF}"
      echo "   Обычно это 10–20 минут. Прошло: ${mins} мин."
      echo
      echo "   Сейчас: ${detail:-подготовка}"
      ;;
    failed)
      logo "$RED" "${RED}Установка не удалась — повторим через минуту${OFF}"
      echo "   Причина: ${detail:-неизвестно}"
      echo
      echo "   Если это сообщение не уходит больше 30 минут — позвоните в поддержку TS."
      echo "   Для поддержки: Ctrl+Alt+F2, вход ts, команда journalctl -u ts-firstboot"
      ;;
    *)
      logo "$CYAN" "${CYAN}Подготовка к установке TS…${OFF}"
      ;;
  esac
  footer "$ip" with-password
}

screen_hub() {
  local ip url mdns_url setup cloud
  ip=$(lan_ip)
  hub_addr
  if [ -z "$ip" ]; then
    logo "$YELLOW" "${YELLOW}Нет сети${OFF}"
    echo "   TS установлен, но мини-ПК не видит сеть клуба. Проверьте кабель от роутера."
    footer "" with-password
    return
  fi
  if ! hub_healthy; then
    logo "$CYAN" "${CYAN}HUB запускается…${OFF}"
    echo "   Если это длится дольше 5 минут — выключите и включите мини-ПК."
    footer "$ip" with-password
    return
  fi
  setup=$(setup_state)
  cloud=0
  cloud_connected && cloud=1
  if [ "$setup" = closed ] || { [ "$setup" = unknown ] && [ "$cloud" = 1 ]; }; then
    url="$SCHEME://$ip$PORT_SUFFIX/"
    mdns_url=""
    [ -n "$MDNS" ] && mdns_url="$SCHEME://$MDNS.local$PORT_SUFFIX/"
    if [ "$cloud" = 1 ]; then
      logo "$GREEN" "${GREEN}HUB подключён к облаку${OFF}"
    else
      logo "$GREEN" "${GREEN}HUB настроен и работает${OFF}"
    fi
    echo "   Адрес для экранов клуба (планшеты, касса):"
    echo
    printf '      %s%s%s\n' "$BOLD" "$url" "$OFF"
    [ -n "$mdns_url" ] && echo "      или $mdns_url"
    QR_URL=$url
    QR_NOTE="   Совет: закрепите за мини-ПК постоянный адрес в настройках роутера."
    footer "$ip"
  else
    url="$SCHEME://$ip$PORT_SUFFIX/setup"
    mdns_url=""
    [ -n "$MDNS" ] && mdns_url="$SCHEME://$MDNS.local$PORT_SUFFIX/setup"
    logo "$GREEN" "${GREEN}TS HUB готов${OFF}"
    echo "   Откройте на телефоне или ПК в сети клуба (тот же Wi-Fi или роутер):"
    echo
    printf '      %s%s%s\n' "$BOLD" "$url" "$OFF"
    [ -n "$mdns_url" ] && echo "      или $mdns_url"
    QR_URL=$url
    QR_NOTE="   Дальше — шаги на экране телефона (понадобится код подключения из кабинета TS)."
    footer "$ip" with-password
  fi
}

# screen_hub задаёт QR_URL/QR_NOTE, поэтому вызываем его в текущей оболочке, а вывод собираем во временный файл.
compose() {
  local size rows cols tmp lines free qr
  size=$(tty_size)
  rows=${size% *}
  cols=${size#* }
  QR_URL=""
  QR_NOTE=""
  tmp=$(mktemp)
  if [ -e "$STATE_DIR/installed" ]; then screen_hub >"$tmp"; else screen_install >"$tmp"; fi
  if [ -n "$QR_URL" ]; then
    lines=$(wc -l <"$tmp")
    free=$((rows - lines - 3))
    if qr=$(qr_block "$QR_URL" "$free" "$cols"); then
      # QR — после адреса (перед подвалом): вставляем после строки с адресом.
      awk -v qr="$qr" -v note="$QR_NOTE" -v url="$QR_URL" '
        { print }
        !done && index($0, url) { print ""; print qr; if (note != "") { print ""; print note }; done = 1 }
      ' "$tmp"
    else
      awk -v note="$QR_NOTE" -v url="$QR_URL" '
        { print }
        !done && index($0, url) { if (note != "") { print ""; print note }; done = 1 }
      ' "$tmp"
    fi
  else
    cat "$tmp"
  fi
  rm -f "$tmp"
}

draw() { # перерисовка без мигания: курсор в начало, строки с очисткой хвоста, затем очистка остатка
  local line
  printf '%s' "${E}[H"
  while IFS= read -r line; do printf '%s%s\n' "$line" "${E}[0m${E}[K"; done <<<"$1"
  printf '%s' "${E}[J"
}

main() {
  local screen prev="" last_full=0 now
  setup_tty
  while :; do
    screen=$(compose)
    now=$(date +%s)
    if [ $((now - last_full)) -ge 600 ]; then
      printf '%s' "${E}[0m${E}[H${E}[2J"
      last_full=$now
      prev=""
    fi
    if [ "$screen" != "$prev" ]; then
      draw "$screen"
      prev=$screen
    fi
    sleep 3
  done
}

main "$@"
