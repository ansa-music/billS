# Удалённая поддержка HUB

Для техподдержки (мы) и для управляющего клуба — чтобы он понимал, что именно подключено к его мини-ПК и как это отключить.

**Принцип:** HUB **никогда не публикуется в интернет**. Никаких пробросов портов на роутере клуба, никакого «белого» адреса. Поддержка подключается только через VPN: HUB сам устанавливает исходящее соединение с нашей сетью, а снаружи к нему по-прежнему никто не может достучаться. Общая картина безопасности — в [docs/INFRASTRUCTURE_RU.md](../../docs/INFRASTRUCTURE_RU.md), раздел 12; ежедневная эксплуатация — в [docs/OPERATIONS_RU.md](../../docs/OPERATIONS_RU.md).

Два варианта VPN. Для старта рекомендуем Tailscale; WireGuard — когда хочется обойтись без третьих сторон.

## 1. Tailscale (рекомендуется для старта)

Tailscale — сервис, который соединяет устройства в одну частную сеть (tailnet) поверх WireGuard. Координационный сервер Tailscale только знакомит устройства между собой; сам трафик идёт напрямую, зашифрованным.

### Установка на HUB

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname club-almaty-1 --advertise-tags=tag:bills-hub
```

- `--ssh` включает **Tailscale SSH**: вход по ключам самой сети, без паролей и без раздачи SSH-ключей по клубам. Кто может входить — решает ACL (ниже).
- `--hostname` задаёт имя узла. Договорённость: `club-<город>-<номер>`, например `club-almaty-1`, `club-astana-2`. Имя потом используется в адресах вместо IP.
- `--advertise-tags=tag:bills-hub` помечает узел как HUB клуба; тег должен быть разрешён в ACL владельцу тега (`tagOwners`).

Команда напечатает ссылку для авторизации узла — её открывает **сотрудник поддержки** в своём аккаунте Tailscale (не управляющий). После авторизации узел желательно сделать без срока истечения ключа (в админке: Machines → узел → Disable key expiry), иначе через 180 дней он отвалится.

Проверка:

```bash
tailscale status           # узел онлайн, видит остальные
tailscale ip -4            # адрес в tailnet, 100.x.y.z
```

### ACL: кто куда может

В админке Tailscale (Access controls) — минимальная политика: группа `support` имеет доступ к узлам с тегом `tag:bills-hub` по портам 22 (SSH) и 4310 (HUB) и больше никуда. HUB-ы друг друга не видят.

```json
{
  "groups": {
    "group:support": ["support1@example.com", "support2@example.com"]
  },
  "tagOwners": {
    "tag:bills-hub": ["group:support"]
  },
  "acls": [
    { "action": "accept", "src": ["group:support"], "dst": ["tag:bills-hub:22", "tag:bills-hub:4310"] }
  ],
  "ssh": [
    { "action": "check", "src": ["group:support"], "dst": ["tag:bills-hub"], "users": ["bills-admin"] }
  ]
}
```

`"action": "check"` в блоке `ssh` требует повторной аутентификации в браузере раз в несколько часов — удобно как «второй фактор» для доступа к продуктивным клубам.

### С ноутбука поддержки

Ноутбук тоже в tailnet (Tailscale для Windows/macOS/Linux, вход тем же аккаунтом из `group:support`). Дальше:

```bash
tailscale status                                   # club-almaty-1 должен быть online
curl -s http://club-almaty-1:4310/api/health       # здоровье HUB
ssh bills-admin@club-almaty-1                      # Tailscale SSH, без пароля
tailscale file cp bills-admin@club-almaty-1:... .  # см. раздел 4, как забрать бэкап
```

Экран зала и `/metrics` открываются в браузере по `http://club-almaty-1:4310` — так же, как с планшета в клубе.

### Плюсы и минусы

| Плюсы | Минусы |
|---|---|
| установка 2 минуты, NAT и роутеры клуба настраивать не надо | зависимость от сервиса Tailscale: если их координационный сервер недоступен, **новые** соединения не установятся (уже установленные живут) |
| Tailscale SSH: ключи не надо раздавать и отзывать по клубам | учётные записи и ACL хранятся у третьей стороны |
| бесплатный тариф — до 100 устройств и 3 пользователей; на сеть из 4–10 клубов хватает | при росте команды поддержки — платный тариф |
| имена узлов вместо IP, отдельный ACL для портов | — |

Альтернатива без третьей стороны, но с теми же клиентами — **Headscale** (открытая реализация координационного сервера Tailscale) на своём VPS. Разумный шаг, когда клубов станет больше десяти.

## 2. WireGuard (без третьих сторон)

Схема «звезда»: арендованный VPS (в Казахстане, может быть тот же, где будет облако) — концентратор `wg0` с подсетью `10.77.0.0/24`. Каждый клуб и каждый ноутбук поддержки — peer, который сам инициирует соединение к VPS. Клубы за NAT, входящих портов на их роутерах не нужно.

План адресов (записать в тикет-систему или таблицу):

| Узел | Адрес |
|---|---|
| VPS-концентратор | `10.77.0.1` |
| ноутбуки поддержки | `10.77.0.2–10.77.0.9` |
| клубы | `10.77.0.11` (клуб 1), `10.77.0.12` (клуб 2), … |

### Ключи

На каждом узле ключи генерируются **на месте**: приватный ключ никогда не покидает устройство, по сети передаётся только публичный.

```bash
sudo apt install -y wireguard
umask 077
wg genkey | tee private.key | wg pubkey > public.key
cat public.key      # этот — передать администратору VPS
```

### Сервер (VPS), `/etc/wireguard/wg0.conf`

```ini
[Interface]
Address = 10.77.0.1/24
ListenPort = 51820
PrivateKey = <приватный ключ VPS>

# --- клуб 1: club-almaty-1 ---
[Peer]
PublicKey = <публичный ключ клуба 1>
AllowedIPs = 10.77.0.11/32
PersistentKeepalive = 25

# --- ноутбук поддержки: support-ivan ---
[Peer]
PublicKey = <публичный ключ ноутбука>
AllowedIPs = 10.77.0.2/32
```

На VPS включить пересылку между peer-ами (иначе ноутбук не увидит клуб через концентратор) и открыть UDP 51820:

```bash
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-wireguard.conf && sudo sysctl --system
sudo ufw allow 51820/udp
sudo systemctl enable --now wg-quick@wg0
```

### Клуб (HUB), `/etc/wireguard/wg0.conf`

```ini
[Interface]
Address = 10.77.0.11/32
PrivateKey = <приватный ключ клуба, из private.key>

[Peer]
PublicKey = <публичный ключ VPS>
Endpoint = vpn.example.kz:51820
AllowedIPs = 10.77.0.0/24
PersistentKeepalive = 25
```

- `AllowedIPs = 10.77.0.0/24` — через туннель ходит только трафик VPN-подсети; интернет клуба в VPN не заворачивается.
- `PersistentKeepalive = 25` — клуб за NAT каждые 25 секунд даёт о себе знать, чтобы NAT-роутер не закрыл «дырку» и поддержка могла подключиться в любой момент.

```bash
sudo chmod 600 /etc/wireguard/wg0.conf
sudo systemctl enable --now wg-quick@wg0
sudo wg show                     # latest handshake — не старше пары минут, transfer растёт
ping -c 3 10.77.0.1              # VPS отвечает
```

### Ноутбук поддержки

Тот же шаблон, что у клуба, с адресом `10.77.0.2/32` (на Windows — приложение WireGuard, вставить тот же конфиг). После подключения:

```bash
curl -s http://10.77.0.11:4310/api/health
ssh bills-admin@10.77.0.11
```

### Как выпустить новый клуб

1. Выделить следующий адрес из таблицы (`10.77.0.12`).
2. На HUB клуба: `wg genkey | tee private.key | wg pubkey`, скопировать публичный ключ.
3. На VPS добавить блок `[Peer]` по шаблону выше и применить без разрыва остальных: `sudo wg syncconf wg0 <(wg-quick strip wg0)`.
4. На HUB положить `/etc/wireguard/wg0.conf`, `systemctl enable --now wg-quick@wg0`, проверить `wg show` и `ping 10.77.0.1`.
5. Записать в таблицу: клуб, адрес, дата, публичный ключ, кто выпускал.

### Хранение ключей

- Приватные ключи лежат только в `/etc/wireguard/wg0.conf` своего узла (права `600`, владелец root). Их **не копируют** в тикеты, чаты и бэкапы HUB.
- Публичные ключи и таблица адресов — в менеджере паролей команды поддержки или в закрытом репозитории.
- Приватный ключ VPS — одна точка доверия: его компрометация означает перевыпуск всех peer-ов. Доступ к VPS — только по SSH-ключам, тоже без паролей.

## 3. Что должно быть открыто (и закрыто)

**На роутере клуба — ничего входящего.** Нужны только исходящие соединения:

| Вариант | Исходящие порты |
|---|---|
| Tailscale | UDP 41641 (прямые соединения), HTTPS 443 (координация, при недоступности UDP — ретрансляция через DERP по 443) |
| WireGuard | UDP 51820 к адресу VPS |
| Обновления HUB и бэкап в облако | HTTPS 443 |

В обычном домашнем/офисном роутере всё это уже открыто. Если у клуба строгий провайдерский файрвол — попросить разрешить исходящий UDP на указанные порты.

**На HUB — ufw.** Порты 22 (SSH) и 4310 (HUB) доступны только из локальной сети клуба и из VPN-подсети; всё остальное входящее закрыто:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
# локальная сеть клуба (подставить свою: 192.168.1.0/24 или шире)
sudo ufw allow from 192.168.0.0/16 to any port 4310 proto tcp
sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp
# VPN: один из двух
sudo ufw allow in on tailscale0            # Tailscale
sudo ufw allow in on wg0                   # WireGuard
sudo ufw enable
sudo ufw status verbose
```

Если включён Tailscale SSH, обычный sshd на порту 22 из VPN можно вовсе не открывать — вход идёт через процесс `tailscaled`.

**SSH на HUB — только ключи.** Отдельный пользователь `bills-admin` с sudo (служба HUB работает от пользователя `bills` без права входа):

```bash
sudo adduser --disabled-password --gecos "billS support" bills-admin
sudo usermod -aG sudo bills-admin
sudo mkdir -p /home/bills-admin/.ssh
echo '<публичный SSH-ключ поддержки>' | sudo tee -a /home/bills-admin/.ssh/authorized_keys
sudo chown -R bills-admin:bills-admin /home/bills-admin/.ssh && sudo chmod 700 /home/bills-admin/.ssh && sudo chmod 600 /home/bills-admin/.ssh/authorized_keys
```

В `/etc/ssh/sshd_config.d/10-bills.conf`:

```
PasswordAuthentication no
PermitRootLogin no
AllowUsers bills-admin
```

```bash
sudo systemctl reload ssh
```

fail2ban не обязателен: порт 22 снаружи не виден, перебирать пароли некому и нечего (паролей нет).

## 4. Регламент поддержки

**Что делаем удалённо сами** (в рабочее окно, с записью в тикет):

```bash
bills status && bills health          # диагностика
bills logs                            # журнал, Ctrl+C для выхода
sudo bills backup                     # внеплановая копия перед работами
sudo bills update                     # обновление при свободных столах (скрипт сам откажется, если идут игры)
bills check                           # целостность базы
```

Забрать бэкап к себе (для разбора инцидента или учебного восстановления):

```bash
# WireGuard / обычный SSH
scp bills-admin@10.77.0.11:/var/lib/bills/backups/hub-2026-10-18_03-30-00.db.gz ./club-1/

# Tailscale (SSH тем же способом, либо встроенная передача файлов)
scp bills-admin@club-almaty-1:/var/lib/bills/backups/hub-2026-10-18_03-30-00.db.gz ./club-1/
ssh bills-admin@club-almaty-1 'sudo tailscale file cp /var/lib/bills/backups/hub-2026-10-18_03-30-00.db.gz support-laptop:'
sudo tailscale file get ./club-1/      # на ноутбуке
```

Скачанные бэкапы — это данные клуба (игры, оплаты, сотрудники). Хранить в зашифрованном месте, удалять после разбора.

**Что не делаем без явного согласия управляющего** (по телефону или в чате, с фиксацией в тикете):

- `bills restore` — подмена базы; всегда проговариваем, какой бэкап и что потеряется;
- `bills restart` и `bills update --force` при идущих играх — экран зала пропадёт на ~10 секунд у официантов в разгар смены;
- любые правки `/etc/bills/hub.env`, тарифов и столов напрямую в базе;
- изменения в ufw, SSH, VPN на HUB.

**Журнал вмешательств.** Обновления и откаты пишутся автоматически в `/var/lib/bills/updates.log`. Всё остальное (перезапуск, restore, правка конфига) — заметка в тикете: дата и время, клуб, кто, что сделал, какой командой, результат. Управляющий вправе попросить выписку.

**Как отозвать доступ** (ушёл сотрудник поддержки, потерян ноутбук, смена подрядчика):

- Tailscale: в админке удалить пользователя из `group:support` (или устройство из Machines) — доступ пропадает сразу на всех HUB. Если скомпрометирован сам узел клуба — Machines → узел → Delete, на HUB `sudo tailscale logout` и выпустить заново.
- WireGuard: на VPS удалить блок `[Peer]` ноутбука и `wg syncconf`. Если утёк ключ клуба — сгенерировать на HUB новую пару, заменить публичный ключ на VPS.
- SSH-ключи: убрать строку из `/home/bills-admin/.ssh/authorized_keys` на каждом HUB (список клубов — из таблицы адресов).
- Управляющий всегда может отключить поддержку физически: `sudo systemctl disable --now wg-quick@wg0` или `sudo tailscale down` — клуб продолжит работать, пропадёт только удалённый доступ.

## 5. Windows-вариант

Если HUB стоит на Windows (`deploy/windows`): поставить Tailscale для Windows на HUB, войти аккаунтом поддержки с тем же тегом `tag:bills-hub`, и внутри tailnet подключаться по RDP (`mstsc /v:club-almaty-1`) или PowerShell Remoting (`Enter-PSSession -ComputerName club-almaty-1 -Credential bills-admin`, предварительно `Enable-PSRemoting -Force` на HUB), разрешив в брандмауэре Windows порты 3389/5985 **только для интерфейса Tailscale**; `http://club-almaty-1:4310/api/health` работает так же, как на Linux.
