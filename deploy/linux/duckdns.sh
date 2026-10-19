#!/usr/bin/env bash
# duckdns.sh — запасной вариант доступа к кабинету: бесплатное имя <поддомен>.duckdns.org + Caddy с HTTPS.
#
# Работает ТОЛЬКО если у провайдера «белый» (публичный) IP — см. --help. Если белого IP нет
# или не хочется возиться с роутером — используйте Tailscale (sudo bills tailscale).
#
#   sudo bills duckdns --domain myclub --token <токен>           — обновлять адрес myclub.duckdns.org каждые 5 минут
#   sudo bills duckdns --domain myclub --token <токен> --https   — плюс Caddy: https://myclub.duckdns.org → кабинет
#   sudo bills duckdns --status                                  — состояние
#   sudo bills duckdns --remove                                  — убрать таймер (и сайт в Caddy)
#
# Токен хранится в /etc/bills/duckdns.env (root, 600), а не в командной строке службы.
# Повторный запуск безопасен.

set -Eeuo pipefail
SCRIPT_NAME="duckdns.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

export DEBIAN_FRONTEND=noninteractive
DUCK_ENV="$ENV_DIR/duckdns.env"
DUCK_SERVICE="bills-duckdns"
DUCK_UNIT_DIR="/etc/systemd/system"
CADDYFILE="/etc/caddy/Caddyfile"
CADDY_MARK="# TS: кабинет владельца через DuckDNS (создано duckdns.sh)"

usage() {
  cat <<USAGE
Использование: sudo bills duckdns [параметры]
  --domain <поддомен>   ваш поддомен на https://www.duckdns.org (например myclub → myclub.duckdns.org)
  --token <токен>       токен со страницы duckdns.org (после входа, вверху страницы)
  --https               поставить Caddy и открыть кабинет по https://<поддомен>.duckdns.org
                        (сертификат Let's Encrypt Caddy получает и продлевает сам)
  --status              показать состояние
  --remove              убрать таймер bills-duckdns, токен и сайт TS в Caddy

Что нужно ДО запуска:
  1. «Белый» IP. Многие провайдеры дают «серый» адрес (CGNAT) — тогда из интернета до роутера
     не достучаться, и DuckDNS не поможет. Как проверить: откройте страницу роутера → «Интернет/WAN»
     и сравните WAN-адрес с внешним адресом, который покажет этот скрипт. Совпадают — IP белый.
     Не совпадают или WAN-адрес вида 10.x, 100.64–100.127.x, 172.16–31.x, 192.168.x — это CGNAT:
     попросите у провайдера услугу «белый/статический IP» или используйте Tailscale.
  2. На роутере пробросьте порты 80 и 443 (TCP) на этот мини-ПК ($(primary_ip)).
     Порт HUB $(hub_port) и порт облака $(cloud_port) НЕ пробрасывайте — наружу смотрит только Caddy.
USAGE
}

DOMAIN=""
TOKEN=""
DO_HTTPS=0
ACTION="setup"
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) [ $# -ge 2 ] || die "--domain требует значение"; DOMAIN="$2"; shift 2 ;;
    --domain=*) DOMAIN="${1#--domain=}"; shift ;;
    --token) [ $# -ge 2 ] || die "--token требует значение"; TOKEN="$2"; shift 2 ;;
    --token=*) TOKEN="${1#--token=}"; shift ;;
    --https) DO_HTTPS=1; shift ;;
    --status) ACTION="status"; shift ;;
    --remove) ACTION="remove"; shift ;;
    --update) ACTION="update"; shift ;;   # служебный режим: его вызывает таймер
    -h|--help) load_env; usage; exit 0 ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
  esac
done

# ---------- Служебный режим таймера: одно обновление адреса ----------
# Запускается службой bills-duckdns (User=bills); DUCKDNS_DOMAIN/DUCKDNS_TOKEN приходят из
# EnvironmentFile=/etc/bills/duckdns.env. Токен передаётся curl через stdin (-K -), не в аргументах.
if [ "$ACTION" = "update" ]; then
  [ -n "${DUCKDNS_DOMAIN:-}" ] && [ -n "${DUCKDNS_TOKEN:-}" ] || die "нет DUCKDNS_DOMAIN/DUCKDNS_TOKEN (служба должна читать $DUCK_ENV)"
  resp="$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip="\n' "$DUCKDNS_DOMAIN" "$DUCKDNS_TOKEN" \
          | curl -fsS --max-time 20 -K -)" || die "DuckDNS не ответил (нет интернета?)"
  [ "$resp" = "OK" ] || die "DuckDNS ответил «$resp» — проверьте поддомен и токен (sudo bills duckdns --domain … --token …)"
  log "DuckDNS: адрес ${DUCKDNS_DOMAIN}.duckdns.org обновлён"
  exit 0
fi

require_root "$@"
require_cmd curl systemctl
load_env

external_ip() { curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 10 https://ifconfig.me 2>/dev/null || true; }

caddy_is_ours() { [ -f "$CADDYFILE" ] && grep -qF "$CADDY_MARK" "$CADDYFILE"; }

# ---------- --status ----------
if [ "$ACTION" = "status" ]; then
  systemctl list-timers "${DUCK_SERVICE}.timer" --no-pager --all 2>/dev/null || true
  echo
  systemctl status "${DUCK_SERVICE}.service" --no-pager --lines=5 2>/dev/null || true
  if [ -f "$DUCK_ENV" ]; then
    d="$(env_value "$DUCK_ENV" DUCKDNS_DOMAIN)"
    echo
    echo "Поддомен:      ${d}.duckdns.org"
    echo "Внешний IP:    $(external_ip)"
    echo "DNS сейчас:    $(getent hosts "${d}.duckdns.org" 2>/dev/null | awk '{print $1}' | head -n 1)"
  else
    echo "DuckDNS не настроен (нет $DUCK_ENV)."
  fi
  if caddy_is_ours; then
    echo "Caddy:         $(systemctl is-active caddy 2>/dev/null || true), сайт TS в $CADDYFILE"
  fi
  exit 0
fi

# ---------- --remove ----------
if [ "$ACTION" = "remove" ]; then
  systemctl disable --now --quiet "${DUCK_SERVICE}.timer" 2>/dev/null || true
  rm -f "$DUCK_UNIT_DIR/${DUCK_SERVICE}.timer" "$DUCK_UNIT_DIR/${DUCK_SERVICE}.service" "$DUCK_ENV"
  systemctl daemon-reload
  ok "Таймер $DUCK_SERVICE и токен ($DUCK_ENV) удалены."
  if caddy_is_ours; then
    cp -p "$CADDYFILE" "$CADDYFILE.bak.$(timestamp)"
    printf '%s\n' "# Caddyfile: сайт TS удалён duckdns.sh --remove ($(date '+%Y-%m-%d %H:%M'))" >"$CADDYFILE"
    systemctl disable --now --quiet caddy 2>/dev/null || true
    ok "Сайт TS убран из Caddy, Caddy остановлен (пакет не удалён; копия: $CADDYFILE.bak.*)."
  fi
  echo "  Не забудьте убрать проброс портов 80 и 443 на роутере, если он больше не нужен."
  exit 0
fi

# ---------- Настройка ----------
DOMAIN="${DOMAIN%.duckdns.org}"
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
if [ -z "$DOMAIN" ] && [ -f "$DUCK_ENV" ]; then DOMAIN="$(env_value "$DUCK_ENV" DUCKDNS_DOMAIN)"; fi
if [ -z "$TOKEN" ] && [ -f "$DUCK_ENV" ]; then TOKEN="$(env_value "$DUCK_ENV" DUCKDNS_TOKEN)"; fi
[ -n "$DOMAIN" ] && [ -n "$TOKEN" ] || { usage; die "нужны --domain и --token (их даёт https://www.duckdns.org после входа)"; }
case "$DOMAIN" in *[!a-z0-9-]*) die "--domain: только латинские буквы, цифры и дефис (например myclub)" ;; esac
case "$TOKEN" in *[!A-Za-z0-9-]*) die "--token выглядит неправильно — скопируйте его со страницы duckdns.org целиком" ;; esac
FQDN="${DOMAIN}.duckdns.org"
[ -f "$BIN_DIR/duckdns.sh" ] && [ -f "$BIN_DIR/lib.sh" ] \
  || die "нет $BIN_DIR/duckdns.sh — сначала установите TS: sudo bash install.sh"

# Токен — в файл root 600 (systemd читает его сам и передаёт службе через окружение).
install -d -m 755 -o root -g root "$ENV_DIR"
umask 077
printf '# DuckDNS для TS (создано duckdns.sh). Не публикуйте токен.\nDUCKDNS_DOMAIN=%s\nDUCKDNS_TOKEN=%s\n' "$DOMAIN" "$TOKEN" >"$DUCK_ENV"
umask 022
chown root:root "$DUCK_ENV"
chmod 600 "$DUCK_ENV"
log "Поддомен и токен сохранены в $DUCK_ENV (root, 600)"

cat >"$DUCK_UNIT_DIR/${DUCK_SERVICE}.service" <<UNIT
# TS: обновление адреса ${FQDN} в DuckDNS (создано duckdns.sh). Токен — в $DUCK_ENV.
[Unit]
Description=TS: обновление адреса DuckDNS
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$BILLS_USER
Group=$BILLS_USER
EnvironmentFile=$DUCK_ENV
ExecStart=/bin/bash $BIN_DIR/duckdns.sh --update
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
UNIT
cat >"$DUCK_UNIT_DIR/${DUCK_SERVICE}.timer" <<UNIT
# TS: DuckDNS — обновлять адрес каждые 5 минут (создано duckdns.sh).
[Unit]
Description=TS: обновление адреса DuckDNS каждые 5 минут

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Unit=${DUCK_SERVICE}.service

[Install]
WantedBy=timers.target
UNIT
chmod 644 "$DUCK_UNIT_DIR/${DUCK_SERVICE}.service" "$DUCK_UNIT_DIR/${DUCK_SERVICE}.timer"
systemctl daemon-reload
systemctl enable --quiet --now "${DUCK_SERVICE}.timer"

log "Проверяю: обновляю адрес ${FQDN} сейчас ..."
if systemctl start "${DUCK_SERVICE}.service"; then
  ok "DuckDNS принял обновление: ${FQDN}"
else
  journalctl -u "${DUCK_SERVICE}.service" -n 10 --no-pager || true
  die "DuckDNS не принял обновление — проверьте поддомен и токен на https://www.duckdns.org"
fi

ext="$(external_ip)"
echo
echo "  Внешний IP этого подключения: ${ext:-не удалось узнать}"
echo "  Проверка «белого» IP: откройте страницу роутера → Интернет/WAN и сравните WAN-адрес с ${ext:-внешним IP}."
echo "  Если отличается (или WAN-адрес 10.x / 100.64–100.127.x / 172.16–31.x / 192.168.x) — у вас CGNAT,"
echo "  из интернета до мини-ПК не достучаться. Попросите у провайдера «белый IP» или используйте: sudo bills tailscale"
echo

# ---------- Caddy (HTTPS) ----------
if [ "$DO_HTTPS" -eq 1 ]; then
  cloud_enabled || die "--https нужен для кабинета, а облако на этом мини-ПК не включено (install.sh --with-cloud)"
  cport="$(cloud_port)"
  if ! command -v caddy >/dev/null 2>&1; then
    log "Ставлю Caddy из официального репозитория (dl.cloudsmith.io/public/caddy/stable) ..."
    apt-get update -qq </dev/null
    apt-get install -y -qq --no-install-recommends debian-keyring debian-archive-keyring apt-transport-https curl gnupg </dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq </dev/null
    apt-get install -y -qq caddy </dev/null
    ok "Caddy установлен."
  else
    log "Caddy уже установлен — пропускаю установку."
  fi
  # Свой Caddyfile, отличный от нашего, сохраняем в копию.
  if [ -f "$CADDYFILE" ] && ! caddy_is_ours; then
    cp -p "$CADDYFILE" "$CADDYFILE.bak.$(timestamp)"
    log "Прежний $CADDYFILE сохранён в $CADDYFILE.bak.*"
  fi
  install -d -m 755 /etc/caddy
  cat >"$CADDYFILE" <<CADDY
$CADDY_MARK
# Кабинет владельца: https://${FQDN} → облако TS на этом мини-ПК (127.0.0.1:${cport}).
# Сертификат Let's Encrypt Caddy получает и продлевает сам (нужны проброшенные порты 80 и 443).
${FQDN} {
	reverse_proxy 127.0.0.1:${cport}
}
CADDY
  chmod 644 "$CADDYFILE"
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null || die "Caddyfile не прошёл проверку (caddy validate)"
  systemctl enable --quiet caddy
  systemctl reload-or-restart caddy
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    log "ufw активен — открываю 80/tcp и 443/tcp для Caddy"
    ufw allow 80/tcp comment 'TS Caddy (Lets Encrypt)' >/dev/null
    ufw allow 443/tcp comment 'TS Caddy (HTTPS)' >/dev/null
  fi
  ok "Caddy настроен: https://${FQDN} → http://127.0.0.1:${cport}"
  echo "  Первое открытие может занять до минуты — Caddy получает сертификат."
  echo "  Если сертификат не выдаётся: journalctl -u caddy -n 50 (обычно не проброшены 80/443 или серый IP)."
  echo "  Если кабинет открывают ТОЛЬКО по https://, можно поставить CLOUD_SECURE_COOKIES=1 в $CLOUD_ENV_FILE"
  echo "  и выполнить: sudo systemctl restart $CLOUD_SERVICE"
else
  echo "  Без --https адрес ${FQDN} только указывает на ваш роутер. Чтобы открыть кабинет по HTTPS:"
  echo "    sudo bills duckdns --domain ${DOMAIN} --token <токен> --https"
fi

echo
warn "На роутере пробросьте ТОЛЬКО порты 80 и 443 (TCP) на этот мини-ПК ($(primary_ip))."
echo "  Порт HUB $(hub_port) НЕ пробрасывайте никогда. Порт облака $(cloud_port) тоже не нужен — наружу смотрит Caddy."
echo "  Кабинет при этом открыт в интернет (вход по паролю владельца) — сделайте пароль длинным."
