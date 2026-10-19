#!/usr/bin/env bash
# tailscale.sh — доступ к кабинету владельца и к облаку TS через Tailscale (РЕКОМЕНДУЕМЫЙ вариант).
#
# Tailscale — бесплатная частная сеть между вашими устройствами (мини-ПК клубов, телефон и ноутбук
# владельца). Ничего не открывается в интернет, проброс портов на роутере не нужен, «белый» IP не нужен.
# Устройства видят друг друга по адресам 100.x.y.z и по именам (MagicDNS).
#
#   sudo bills tailscale                         — установить, подключить, показать адреса
#   sudo bills tailscale --hostname ts-club1     — своё имя устройства в сети Tailscale
#   sudo bills tailscale --authkey tskey-auth-…  — вход без браузера (ключ из админки Tailscale)
#   sudo bills tailscale --https                 — настоящий HTTPS для кабинета (https://<имя>.<сеть>.ts.net)
#   sudo bills tailscale --status                — адреса и состояние
#   sudo bills tailscale --down                  — отключить этот мини-ПК от сети Tailscale
#
# Запускать и на главном мини-ПК (где облако), и на HUB других клубов — тем же аккаунтом Tailscale.
# Повторный запуск безопасен.

set -Eeuo pipefail
SCRIPT_NAME="tailscale.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

export DEBIAN_FRONTEND=noninteractive

usage() {
  cat <<USAGE
Использование: sudo bills tailscale [параметры]
  (без параметров)       установить Tailscale, подключить этот мини-ПК и показать адреса
  --hostname <имя>       имя устройства в сети Tailscale (по умолчанию ts-<имя компьютера>)
  --authkey <ключ>       вход без браузера: ключ tskey-auth-… из https://login.tailscale.com/admin/settings/keys
  --https                HTTPS-адрес для кабинета: https://<имя>.<ваша-сеть>.ts.net
                         (сначала включите HTTPS в админке: https://login.tailscale.com/admin/dns → HTTPS Certificates)
  --status               показать состояние и адреса
  --down                 отключить этот мини-ПК от сети Tailscale (Tailscale остаётся установленным)

Как это работает:
  1. Скрипт ставит Tailscale и печатает ссылку для входа — откройте её на телефоне или ПК
     владельца и войдите (Google/Apple/Microsoft). Один аккаунт — для всех клубов.
  2. На телефон владельца поставьте приложение Tailscale и войдите тем же аккаунтом.
  3. Кабинет открывается по адресу http://<имя>:$(cloud_port) (или http://100.x.y.z:$(cloud_port)).
  Funnel (публикация в интернет) этот скрипт НЕ включает — для TS он не нужен.
USAGE
}

NAME=""
AUTHKEY=""
DO_HTTPS=0
ACTION="up"
while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) [ $# -ge 2 ] || die "--hostname требует значение"; NAME="$2"; shift 2 ;;
    --hostname=*) NAME="${1#--hostname=}"; shift ;;
    --authkey|--auth-key) [ $# -ge 2 ] || die "--authkey требует значение"; AUTHKEY="$2"; shift 2 ;;
    --authkey=*|--auth-key=*) AUTHKEY="${1#*=}"; shift ;;
    --https) DO_HTTPS=1; shift ;;
    --status) ACTION="status"; shift ;;
    --down) ACTION="down"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
  esac
done

require_root "$@"
require_cmd curl systemctl

# ---------- Установка ----------
install_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    log "Tailscale уже установлен ($(tailscale version 2>/dev/null | head -n 1)) — пропускаю установку."
    return 0
  fi
  local id="" codename=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release && printf '%s' "${ID:-}")"
    # shellcheck disable=SC1091
    codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
  fi
  if { [ "$id" = "ubuntu" ] || [ "$id" = "debian" ]; } && [ -n "$codename" ]; then
    log "Ставлю Tailscale из официального репозитория pkgs.tailscale.com ($id $codename) ..."
    if curl -fsSL "https://pkgs.tailscale.com/stable/${id}/${codename}.noarmor.gpg" \
            -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
       && curl -fsSL "https://pkgs.tailscale.com/stable/${id}/${codename}.tailscale-keyring.list" \
            -o /etc/apt/sources.list.d/tailscale.list \
       && apt-get update -qq </dev/null \
       && apt-get install -y -qq tailscale </dev/null; then
      ok "Tailscale установлен из apt-репозитория."
      return 0
    fi
    warn "установка из apt-репозитория не удалась — пробую официальный установщик tailscale.com/install.sh"
    rm -f /etc/apt/sources.list.d/tailscale.list
  fi
  log "Ставлю Tailscale официальным установщиком (https://tailscale.com/install.sh) ..."
  local inst
  inst="$(mktemp /tmp/tailscale-install.XXXXXX)"
  curl -fsSL https://tailscale.com/install.sh -o "$inst" || { rm -f "$inst"; die "не удалось скачать https://tailscale.com/install.sh — есть ли интернет?"; }
  sh "$inst" </dev/null || { rm -f "$inst"; die "официальный установщик Tailscale завершился с ошибкой"; }
  rm -f "$inst"
  command -v tailscale >/dev/null 2>&1 || die "после установки команда tailscale не найдена"
  ok "Tailscale установлен."
}

# ---------- Сведения о себе (из tailscale status --json) ----------
# ts_self <поле> — BackendState | DNSName (без точки в конце) | HostName
ts_self() {
  local json
  json="$(tailscale status --json 2>/dev/null)" || { printf ''; return 0; }
  printf '%s' "$json" | F="$1" node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const s = JSON.parse(raw);
        const f = process.env.F;
        let v = f === "BackendState" ? s.BackendState : (s.Self || {})[f];
        v = String(v ?? "").replace(/\.$/, "");
        process.stdout.write(v);
      } catch { process.stdout.write(""); }
    });
  ' 2>/dev/null || printf ''
}

default_name() {
  local h
  h="$(hostname -s 2>/dev/null || hostname)"
  h="$(printf '%s' "$h" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')"
  case "$h" in ts-*) printf '%s' "$h" ;; *) printf 'ts-%s' "${h:-hub}" ;; esac
}

# ufw: порт облака — только на tailscale0 (если облако включено и ufw активен).
open_cloud_port_on_tailscale() {
  cloud_enabled || return 0
  command -v ufw >/dev/null 2>&1 || return 0
  ufw status 2>/dev/null | grep -q '^Status: active' || return 0
  ip link show tailscale0 >/dev/null 2>&1 || return 0
  log "ufw активен — разрешаю порт облака $(cloud_port)/tcp только на интерфейсе tailscale0"
  ufw allow in on tailscale0 to any port "$(cloud_port)" proto tcp comment 'TS cloud (Tailscale)' >/dev/null
}

print_addresses() {
  local ip4 dns short cport
  ip4="$(tailscale_ip)"
  dns="$(ts_self DNSName)"
  short="${dns%%.*}"
  echo
  echo "=============================================================="
  ok "Этот мини-ПК в сети Tailscale"
  echo "=============================================================="
  echo "  Адрес Tailscale (IP):  ${ip4:-нет}"
  [ -n "$dns" ] && echo "  Имя (MagicDNS):        $dns   (коротко: $short)"
  if cloud_enabled; then
    cport="$(cloud_port)"
    echo
    echo "  Кабинет владельца (с телефона/ПК, где стоит Tailscale и выполнен вход тем же аккаунтом):"
    [ -n "$short" ] && echo "    http://${short}:${cport}"
    [ -n "$ip4" ] && echo "    http://${ip4}:${cport}"
    if [ -n "$dns" ] && tailscale serve status 2>/dev/null | grep -q "https://"; then
      echo "    https://${dns}   (HTTPS через tailscale serve)"
    fi
    echo
    echo "  CLOUD_URL для HUB других клубов (на них тоже поставьте Tailscale с этим же аккаунтом):"
    echo "    http://${ip4:-<100.x.y.z>}:${cport}"
    echo "  Подключение HUB другого клуба:"
    echo "    Linux:   sudo bills connect-cloud --url http://${ip4:-<100.x.y.z>}:${cport} --hub-id <HUB_ID> --key <CLOUD_API_KEY>"
    echo "    Windows: connect-cloud.ps1 -Url http://${ip4:-<100.x.y.z>}:${cport} -HubId <HUB_ID> -Key <CLOUD_API_KEY>"
    echo "    (HUB_ID и ключ выдаёт здесь: sudo bills cloud add-club --name \"<клуб>\")"
  else
    echo
    echo "  Облако на этом мини-ПК не включено — значит, это HUB клуба. Подключите его к облаку главного клуба:"
    echo "    sudo bills connect-cloud --url http://<адрес Tailscale главного мини-ПК>:4320 --hub-id <HUB_ID> --key <CLOUD_API_KEY>"
  fi
  echo
  echo "  Funnel (публикация в интернет) не используется — кабинет виден только вашим устройствам в Tailscale."
  echo
}

# ---------- Действия ----------
case "$ACTION" in
  status)
    command -v tailscale >/dev/null 2>&1 || die "Tailscale не установлен. Установить: sudo bills tailscale"
    tailscale status || true
    echo
    tailscale serve status 2>/dev/null || true
    if [ "$(ts_self BackendState)" = "Running" ]; then
      print_addresses
    else
      warn "Tailscale не подключён (состояние: $(ts_self BackendState)). Подключить: sudo bills tailscale"
    fi
    exit 0
    ;;
  down)
    command -v tailscale >/dev/null 2>&1 || die "Tailscale не установлен"
    tailscale down
    ok "Этот мини-ПК отключён от сети Tailscale. Другие клубы и телефон владельца его больше не видят."
    echo "  Подключить снова: sudo bills tailscale"
    exit 0
    ;;
esac

install_tailscale
systemctl enable --quiet --now tailscaled

[ -n "$NAME" ] || NAME="$(default_name)"
case "$NAME" in *[!a-z0-9-]*|'') die "--hostname: только латинские строчные буквы, цифры и дефис (например ts-club1)" ;; esac

state="$(ts_self BackendState)"
if [ "$state" = "Running" ]; then
  current="$(ts_self HostName)"
  if [ -n "$NAME" ] && [ "$current" != "$NAME" ]; then
    log "Меняю имя устройства в Tailscale: $current → $NAME"
    tailscale set --hostname "$NAME" || warn "не удалось сменить имя (tailscale set --hostname) — оставляю $current"
  else
    log "Tailscale уже подключён как $current — вход не нужен."
  fi
else
  up_args=(up --hostname "$NAME")
  if [ -n "$AUTHKEY" ]; then
    log "Подключаю этот мини-ПК к Tailscale по ключу (имя: $NAME) ..."
    up_args+=(--auth-key "$AUTHKEY")
  else
    echo
    log "Подключаю этот мини-ПК к Tailscale (имя: $NAME)."
    echo "  Сейчас появится строка «To authenticate, visit: https://login.tailscale.com/…»."
    echo "  Откройте эту ссылку на телефоне или ПК владельца и войдите (Google/Apple/Microsoft/почта)."
    echo "  Используйте ОДИН аккаунт для всех клубов сети. Скрипт продолжит сам после входа."
    echo
  fi
  tailscale "${up_args[@]}" || die "tailscale up не удался. Попробуйте ещё раз: sudo bills tailscale"
fi

[ "$(ts_self BackendState)" = "Running" ] || die "Tailscale не перешёл в рабочее состояние (сейчас: $(ts_self BackendState)). Смотрите: tailscale status"
ok "Tailscale подключён: $(tailscale_ip)"

open_cloud_port_on_tailscale

# ---------- HTTPS через tailscale serve (только внутри вашей сети Tailscale) ----------
if [ "$DO_HTTPS" -eq 1 ]; then
  cloud_enabled || die "--https нужен для кабинета, а облако на этом мини-ПК не включено (install.sh --with-cloud)"
  log "Включаю HTTPS для кабинета: tailscale serve --bg --https=443 http://127.0.0.1:$(cloud_port)"
  echo "  Нужно один раз включить HTTPS в админке Tailscale: https://login.tailscale.com/admin/dns"
  echo "  (раздел MagicDNS должен быть включён, затем «HTTPS Certificates» → Enable HTTPS)."
  if tailscale serve --bg --https=443 "http://127.0.0.1:$(cloud_port)"; then
    ok "Кабинет доступен по HTTPS: https://$(ts_self DNSName)  (сертификат *.ts.net выдаётся автоматически)"
    echo "  Это по-прежнему видно только устройствам вашей сети Tailscale (не Funnel)."
    echo "  Если кабинет открывают ТОЛЬКО по https://, можно поставить CLOUD_SECURE_COOKIES=1 в $CLOUD_ENV_FILE"
    echo "  и выполнить: sudo systemctl restart $CLOUD_SERVICE"
  else
    warn "tailscale serve не удался. Чаще всего HTTPS не включён в админке: https://login.tailscale.com/admin/dns"
    echo "  Включите MagicDNS и HTTPS Certificates и запустите снова: sudo bills tailscale --https"
  fi
fi

print_addresses
