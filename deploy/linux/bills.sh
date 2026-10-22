#!/usr/bin/env bash
# bills.sh — удобная обёртка для оператора: /usr/local/bin/bills <команда>
#   bills status            состояние сервисов (HUB, облако) и таймера бэкапов
#   bills logs [-n 200]     логи HUB (по умолчанию «хвост» в реальном времени)
#   bills restart           перезапустить HUB
#   bills update [...]      обновить (см. update.sh --help)
#   bills backup            сделать бэкап сейчас (HUB и облако)
#   bills restore [файл]    восстановить из бэкапа / показать список (--cloud — база облака)
#   bills check [файл]      проверить целостность базы (или файла)
#   bills version           версия HUB (CLI version)
#   bills health            ответ /api/health
#   bills cloud <...>       команды облака на этом мини-ПК (cloud CLI): init, add-club [--connect], list ...
#   bills connect-cloud ... подключить этот HUB к облаку (в другом клубе сети)
#   bills cloud-logs        логи облака
#   bills tailscale|tunnel|duckdns ...  доступ к кабинету снаружи (tailscale.sh, cloudflare-tunnel.sh, duckdns.sh)
#   bills ca init|show      HTTPS: сертификат клуба для планшетов (см. README)

set -Eeuo pipefail
SCRIPT_NAME="bills"
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

usage() {
  cat <<USAGE
Использование: bills <команда> [аргументы]
  status            состояние bills-hub, облака (если включено) и таймера бэкапов
  logs [-n N]       логи HUB (journalctl -u bills-hub -f)
  restart           перезапустить HUB
  update [...]      обновить до origin/main (--ref, --force, --rollback)
  backup            сделать бэкап базы сейчас (и базы облака, если оно включено)
  restore [файл]    восстановить базу из бэкапа (без файла — список; --cloud — база облака)
  check [файл]      PRAGMA integrity_check базы (или указанного файла)
  version           версия HUB
  health            ответ /api/health

Облако TS на этом мини-ПК (включается: sudo bash /opt/bills/bin/install.sh --with-cloud):
  cloud init --company "<название>" --email <почта> [--name "<имя>"] [--password <пароль>]
                    создать компанию и владельца (пароль сгенерируется, если не указан)
  cloud add-club --name "<клуб>" [--tz Asia/Almaty] [--currency KZT] [--connect]
                    добавить клуб; --connect — сразу подключить к облаку HUB этого мини-ПК
  cloud new-hub-key --hub <HUB_ID>     новый ключ для HUB клуба (старый перестанет работать)
  cloud reset-password --email <почта> [--password <пароль>]
  cloud list | check | version         список компаний и клубов, проверка базы, версия
  cloud-logs [-n N] логи облака (journalctl -u bills-cloud -f)

Подключение HUB к облаку (в другом клубе сети):
  connect-cloud --url http://<адрес-облака>:4320 --hub-id <HUB_ID> --key <CLOUD_API_KEY>

Доступ к кабинету владельца снаружи:
  tailscale [...]   РЕКОМЕНДУЕТСЯ: частная сеть Tailscale (bills tailscale --help)
  tunnel [...]      Cloudflare Tunnel (bills tunnel --help)
  duckdns [...]     DuckDNS + Caddy с HTTPS, нужен «белый» IP (bills duckdns --help)
  ca init [...]     HTTPS в сети клуба: корневой сертификат + сертификат HUB, порты 443/80, hub.local
  ca show           показать сертификаты
USAGE
}

cmd="${1:-}"
[ -n "$cmd" ] || { usage; exit 1; }
shift

# Почти всё требует root — поднимаемся через sudo один раз.
if [ "$(id -u)" -ne 0 ]; then
  case "$cmd" in
    -h|--help|help) usage; exit 0 ;;
  esac
  exec sudo -- "$0" "$cmd" "$@"
fi

load_env
PORT="$(hub_port)"
current_dir="$(release_path "$CURRENT_LINK")"

# connect_hub <CLOUD_URL> <HUB_ID> <CLOUD_API_KEY>
# Записывает подключение к облаку в hub.env (копия — hub.env.bak) и перезапускает HUB.
connect_hub() {
  local url="$1" hub_id="$2" key="$3"
  [ -f "$ENV_FILE" ] || die "нет $ENV_FILE — HUB на этом мини-ПК не установлен (sudo bash install.sh)"
  cp -p -- "$ENV_FILE" "$ENV_FILE.bak"
  log "Копия прежних настроек: $ENV_FILE.bak"
  set_env_value "$ENV_FILE" CLOUD_URL "$url"
  set_env_value "$ENV_FILE" HUB_ID "$hub_id"
  set_env_value "$ENV_FILE" CLOUD_API_KEY "$key"
  chown root:"$BILLS_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  ok "В $ENV_FILE записано: CLOUD_URL=$url, HUB_ID=$hub_id, CLOUD_API_KEY=<скрыт>"
  log "Перезапускаю $HUB_SERVICE (игры сохраняются, время считается дальше) ..."
  systemctl restart "$HUB_SERVICE"
  if health_wait; then
    ok "HUB перезапущен и подключён к облаку: $(health_summary)"
    echo "  Проверить отправку событий: bills logs   (ошибки связи с облаком видны в логе HUB)"
  else
    warn "HUB не ответил на /api/health после перезапуска. Вернуть прежние настройки:"
    echo "    sudo cp $ENV_FILE.bak $ENV_FILE && sudo systemctl restart $HUB_SERVICE"
    die "смотрите: journalctl -u $HUB_SERVICE -n 100"
  fi
}

# cli_field <вывод CLI> <КЛЮЧ> — значение строки КЛЮЧ=… (последнее вхождение, без \r).
cli_field() {
  printf '%s\n' "$1" | tr -d '\r' | K="$2" awk 'index($0, ENVIRON["K"] "=") == 1 { v = substr($0, length(ENVIRON["K"]) + 2) } END { print v }'
}

case "$cmd" in
  status)
    systemctl status "$HUB_SERVICE" --no-pager --lines=5 || true
    echo
    if cloud_enabled; then
      systemctl status "$CLOUD_SERVICE" --no-pager --lines=5 || true
      echo
    fi
    systemctl list-timers "$BACKUP_TIMER" --no-pager --all || true
    echo
    if [ -n "$current_dir" ]; then
      echo "Текущий релиз:   $(basename "$current_dir") ($(short_sha "$(release_sha "$current_dir")"))"
      prev="$(release_path "$PREVIOUS_LINK")"
      [ -n "$prev" ] && echo "Предыдущий релиз: $(basename "$prev")"
    fi
    if [ -n "${HUB_TLS_CERT:-}" ]; then
      echo "Адрес для планшетов: https://$(primary_ip):${PORT} (или https://hub.local), сертификат: http://$(primary_ip):${HUB_HTTP_PORT:-80}/ca"
    else
      echo "Адрес для планшетов: http://$(primary_ip):${PORT}  (HTTPS: bills ca init)"
    fi
    if health_wait 3; then
      echo "Health: $(health_summary)"
    else
      echo "Health: HUB не отвечает на $(hub_url)/api/health"
    fi
    if [ -n "${CLOUD_URL:-}" ] && [ -n "${HUB_ID:-}" ]; then
      echo "HUB подключён к облаку: $CLOUD_URL (HUB_ID=${HUB_ID:-?})"
    elif [ -f "$(dirname "${HUB_DB_PATH:-/var/lib/bills/hub.db}")/setup.json" ]; then
      echo "HUB подключён к облаку через мастер настройки (setup.json)"
    else
      echo "HUB к облаку не подключён — мастер настройки: http://<адрес этого ПК>:4310/setup"
    fi
    if cloud_enabled; then
      cport="$(cloud_port)"
      echo
      echo "Облако включено ($CLOUD_ENV_FILE), порт $cport"
      echo "  Кабинет в локальной сети: http://$(primary_ip):${cport}"
      tsip="$(tailscale_ip)"
      if [ -n "$tsip" ]; then echo "  Кабинет через Tailscale:  http://${tsip}:${cport}"; fi
      if cloud_health_wait 3; then
        echo "  Health облака: $(health_summary "$CLOUD_HEALTH_BODY")"
      else
        echo "  Health облака: не отвечает на http://127.0.0.1:${cport}/api/health (bills cloud-logs)"
      fi
    fi
    ;;
  logs)
    if [ $# -eq 0 ]; then
      exec journalctl -u "$HUB_SERVICE" -f -n 100
    fi
    exec journalctl -u "$HUB_SERVICE" "$@"
    ;;
  cloud-logs)
    if [ $# -eq 0 ]; then
      exec journalctl -u "$CLOUD_SERVICE" -f -n 100
    fi
    exec journalctl -u "$CLOUD_SERVICE" "$@"
    ;;
  restart)
    systemctl restart "$HUB_SERVICE"
    if health_wait; then ok "HUB перезапущен: $(health_summary)"; else die "HUB не ответил на /api/health — journalctl -u $HUB_SERVICE -n 100"; fi
    ;;
  update)    exec bash "$SCRIPT_DIR/update.sh" "$@" ;;
  backup)    exec bash "$SCRIPT_DIR/backup.sh" "$@" ;;
  restore)   exec bash "$SCRIPT_DIR/restore.sh" "$@" ;;
  tailscale) exec bash "$SCRIPT_DIR/tailscale.sh" "$@" ;;
  tunnel)    exec bash "$SCRIPT_DIR/cloudflare-tunnel.sh" "$@" ;;
  duckdns)   exec bash "$SCRIPT_DIR/duckdns.sh" "$@" ;;
  check|version)
    [ -n "$current_dir" ] || die "нет установленного релиза ($CURRENT_LINK)"
    exec_rc=0
    hub_cli "$current_dir" "$cmd" "$@" || exec_rc=$?
    exit "$exec_rc"
    ;;
  cloud)
    cloud_enabled || die "облако на этом мини-ПК не включено. Включить: sudo bash $BIN_DIR/install.sh --with-cloud"
    [ -n "$current_dir" ] || die "нет установленного релиза ($CURRENT_LINK)"
    [ $# -gt 0 ] || { usage; exit 1; }
    sub="$1"
    if [ "$sub" = "restore" ]; then
      die "восстановление базы облака — через: sudo bills restore --cloud [<файл>] (останавливает облако и проверяет health)"
    fi
    # Ищем --connect (только для add-club) и убираем его из аргументов CLI.
    connect=0
    args=()
    for a in "$@"; do
      if [ "$a" = "--connect" ]; then connect=1; else args+=("$a"); fi
    done
    if [ "$connect" -eq 1 ] && [ "$sub" != "add-club" ]; then
      die "--connect работает только с add-club: bills cloud add-club --name \"<клуб>\" --connect"
    fi
    if [ "$connect" -eq 0 ]; then
      exec_rc=0
      cloud_cli "$current_dir" "${args[@]}" || exec_rc=$?
      exit "$exec_rc"
    fi
    # add-club --connect: создаём клуб и сразу подключаем HUB этого мини-ПК к облаку на этом же мини-ПК.
    out="$(cloud_cli "$current_dir" "${args[@]}")" || die "cloud add-club завершился с ошибкой (см. вывод выше)"
    printf '%s\n' "$out"
    new_hub="$(cli_field "$out" HUB_ID)"
    new_key="$(cli_field "$out" CLOUD_API_KEY)"
    [ -n "$new_hub" ] && [ -n "$new_key" ] \
      || die "в выводе add-club нет HUB_ID/CLOUD_API_KEY — подключите вручную: sudo bills connect-cloud --url http://127.0.0.1:$(cloud_port) --hub-id … --key …"
    echo
    log "Подключаю HUB этого мини-ПК к облаку на этом же мини-ПК ..."
    connect_hub "http://127.0.0.1:$(cloud_port)" "$new_hub" "$new_key"
    ;;
  connect-cloud)
    url="" hub_id="" key=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --url) [ $# -ge 2 ] || die "--url требует значение"; url="$2"; shift 2 ;;
        --url=*) url="${1#--url=}"; shift ;;
        --hub-id) [ $# -ge 2 ] || die "--hub-id требует значение"; hub_id="$2"; shift 2 ;;
        --hub-id=*) hub_id="${1#--hub-id=}"; shift ;;
        --key) [ $# -ge 2 ] || die "--key требует значение"; key="$2"; shift 2 ;;
        --key=*) key="${1#--key=}"; shift ;;
        -h|--help)
          echo "Использование: bills connect-cloud --url http://<адрес-облака>:4320 --hub-id <HUB_ID> --key <CLOUD_API_KEY>"
          echo "  HUB_ID и CLOUD_API_KEY выдаёт на главном мини-ПК: sudo bills cloud add-club --name \"<клуб>\""
          echo "  Адрес облака (обычно http://100.x.y.z:4320) печатает на главном мини-ПК: sudo bills tailscale --status"
          exit 0 ;;
        *) die "неизвестный параметр: $1 (bills connect-cloud --help)" ;;
      esac
    done
    [ -n "$url" ] && [ -n "$hub_id" ] && [ -n "$key" ] \
      || die "нужны все три параметра: --url, --hub-id, --key (bills connect-cloud --help)"
    case "$url" in http://*|https://*) ;; *) die "--url должен начинаться с http:// или https:// (например http://100.101.102.103:4320)" ;; esac
    url="${url%/}"
    case "$hub_id$key" in *[[:space:]]*) die "в HUB_ID и ключе не должно быть пробелов — скопируйте их точно" ;; esac
    log "Проверяю облако: $url/api/health ..."
    if body="$(curl -fsS --max-time 8 "$url/api/health" 2>/dev/null)" \
       && printf '%s' "$body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
      ok "Облако отвечает: $(health_summary "$body")"
    else
      warn "облако по адресу $url не отвечает. Настройки всё равно будут записаны — HUB будет пробовать сам."
      echo "  Проверьте: 1) на этом мини-ПК стоит Tailscale и вход выполнен тем же аккаунтом: sudo bills tailscale"
      echo "             2) на главном мини-ПК облако работает: sudo bills status"
      echo "             3) адрес и порт верные (обычно http://100.x.y.z:4320)"
    fi
    connect_hub "$url" "$hub_id" "$key"
    ;;
  ca)
    [ -n "$current_dir" ] || die "нет установленного релиза ($CURRENT_LINK)"
    sub="${1:-}"; shift || true
    tls_dir="$STATE_DIR/tls"
    case "$sub" in
      show)
        hub_cli "$current_dir" ca show "--dir=$tls_dir" "$@"
        ;;
      init)
        https_port=443; http_port=80; cli_args=()
        while [ $# -gt 0 ]; do
          case "$1" in
            --https-port) https_port="$2"; shift 2 ;;
            --http-port)  http_port="$2"; shift 2 ;;
            --ip|--name|--label) cli_args+=("$1=$2"); shift 2 ;;
            *) cli_args+=("$1"); shift ;;
          esac
        done
        # Имя в сети клуба: hub.local (HUB объявляет его сам по mDNS).
        set_env_var HUB_MDNS_NAME "${HUB_MDNS_NAME:-hub}"
        load_env
        lines="$(hub_cli "$current_dir" ca init "--dir=$tls_dir" "${cli_args[@]}")" || die "ca init не удался"
        while IFS= read -r line; do
          case "$line" in HUB_TLS_*=*) set_env_var "${line%%=*}" "${line#*=}" ;; esac
        done <<< "$lines"
        set_env_var HUB_PORT "$https_port"
        set_env_var HUB_HTTP_PORT "$http_port"
        if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
          ufw allow "$https_port/tcp" comment 'TS HUB HTTPS (только LAN)' >/dev/null
          ufw allow "$http_port/tcp" comment 'TS HUB: сертификат и переход на HTTPS' >/dev/null
          ufw allow 5353/udp comment 'TS HUB: имя hub.local (mDNS)' >/dev/null
        fi
        # Службы, поставленные до HTTPS, не умеют занимать порты ниже 1024 — добавляем это право одним файлом.
        dropin="/etc/systemd/system/${HUB_SERVICE}.service.d"
        mkdir -p "$dropin"
        printf '[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n' > "$dropin/https-ports.conf"
        systemctl daemon-reload
        load_env
        PORT="$(hub_port)"
        systemctl restart "$HUB_SERVICE"
        if health_wait; then ok "HUB работает по HTTPS: $(health_summary)"; else die "HUB не ответил на $(hub_url)/api/health — journalctl -u $HUB_SERVICE -n 100"; fi
        ip="$(primary_ip)"
        echo "  Приложение:            https://hub.local$( [ "$https_port" = 443 ] || printf ':%s' "$https_port")/  или  https://${ip}$( [ "$https_port" = 443 ] || printf ':%s' "$https_port")/"
        echo "  Сертификат для планшетов (QR-код — на странице «Оборудование»):"
        echo "                         http://${ip}$( [ "$http_port" = 80 ] || printf ':%s' "$http_port")/ca"
        echo "  Сменился IP сервера — выполните bills ca init ещё раз: корневой сертификат останется прежним."
        ;;
      *) die "bills ca init [--https-port 443] [--http-port 80] [--ip a,b] [--force] | bills ca show" ;;
    esac
    ;;
  health)
    body="$(hub_curl -fsS --max-time 5 "$(hub_url)/api/health")" \
      || die "HUB не отвечает на $(hub_url)/api/health (systemctl status $HUB_SERVICE)"
    printf '%s' "$body" | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        let h;
        try { h = JSON.parse(raw); } catch { console.log(raw); return; }
        const gb = (b) => (b === null || b === undefined ? "?" : (b / 1e9).toFixed(1) + " ГБ");
        const hours = Math.floor((h.uptimeSeconds ?? 0) / 3600), mins = Math.floor(((h.uptimeSeconds ?? 0) % 3600) / 60);
        const backup = h.lastBackupAt ? new Date(h.lastBackupAt).toLocaleString("ru-RU") : "ЕЩЁ НЕ БЫЛО";
        const ageH = h.lastBackupAt ? (Date.now() - h.lastBackupAt) / 36e5 : Infinity;
        const c = h.counters ?? {};
        console.log(`HUB ${h.ok ? "работает" : "НЕ В ПОРЯДКЕ"}: версия ${h.version ?? "?"}${h.gitSha ? " (git " + String(h.gitSha).slice(0, 7) + ")" : ""}, аптайм ${hours} ч ${mins} мин`);
        console.log(`Последний бэкап: ${backup}${ageH > 36 ? "  <-- СТАРШЕ 36 ЧАСОВ, проверьте таймер" : ""}`);
        console.log(`Свободно на диске: ${gb(h.freeDiskBytes)}${h.freeDiskBytes !== null && h.freeDiskBytes < 2e9 ? "  <-- МАЛО МЕСТА" : ""}, база ${((h.dbSizeBytes ?? 0) / 1e6).toFixed(1)} МБ`);
        console.log(`Игр идёт: ${c.sessionsActive ?? "?"}, ждут оплаты: ${c.sessionsUnpaid ?? "?"}, тревог открыто: ${c.alertsOpen ?? "?"}, команд лампам в очереди: ${c.lampCommandsPending ?? "?"}`);
        console.log("");
        console.log(JSON.stringify(h, null, 2));
      });
    '
    ;;
  -h|--help|help) usage ;;
  *) die "неизвестная команда: $cmd (bills --help)" ;;
esac
