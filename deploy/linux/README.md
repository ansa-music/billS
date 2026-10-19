# TS HUB — развёртывание на Linux (Ubuntu Server LTS)

Скрипты в этой папке ставят HUB клуба на чистую Ubuntu Server 22.04/24.04 одной командой,
обновляют его с автоматическим откатом, делают ночные бэкапы базы и восстанавливают её.

## Установка одной командой

```bash
curl -fsSL https://raw.githubusercontent.com/ansa-music/billS/main/deploy/linux/install.sh | sudo bash
```

Скрипт сам скачает репозиторий во временную папку и запустится из `deploy/linux` оттуда.
Параметры можно передать так:

```bash
curl -fsSL https://raw.githubusercontent.com/ansa-music/billS/main/deploy/linux/install.sh \
  | sudo bash -s -- --ref v0.2.0 --port 4310
```

Вариант через git clone (если нужно посмотреть скрипты перед запуском):

```bash
git clone https://github.com/ansa-music/billS.git
cd billS
sudo bash deploy/linux/install.sh [--ref <tag|branch>] [--host 0.0.0.0] [--port 4310] [--node-from tarball]
```

| Параметр | По умолчанию | Смысл |
|---|---|---|
| `--ref` | `main` | ветка, тег или sha, которые ставим |
| `--host` | `0.0.0.0` | `HUB_HOST` в новом `hub.env` (0.0.0.0 — чтобы планшеты из LAN подключались) |
| `--port` | `4310` | `HUB_PORT` в новом `hub.env` |
| `--node-from` | `auto` | `nodesource` (deb-репозиторий), `tarball` (архив nodejs.org в `/usr/local`); `auto` пробует nodesource, при сбое — tarball |
| `--repo` / `BILLS_REPO` | `https://github.com/ansa-music/billS.git` | адрес репозитория (например, свой форк) |

Повторный запуск установщика безопасен: существующий `/etc/bills/hub.env` и база не трогаются,
релиз пересобирается только если изменился целевой коммит. Если на столах идут игры,
установщик (как и `bills update`) откажется перезапускать HUB — дождитесь свободных столов
или выполните `sudo bills update --force`.

В конце установщик печатает адрес для планшетов `http://<ip-сервера>:4310`.

> **Экран зала.** Каждый релиз собирает `apps/web/dist` (`npm run build -w @bills/web`). Раздача собранного экрана самим HUB по адресу `http://<ip>:4310/` — отдельный пункт этапа 1; пока он не слит, планшеты открывают экран зала там, где он запущен (`npm run dev -w @bills/web`, порт 5173, прокси `/api` на HUB), а адрес `:4310` отвечает по `/api/*` и `/metrics`.

**Важно:** HUB должен быть доступен только из локальной сети клуба. Не пробрасывайте порт на роутере.
Если включён `ufw`, установщик сам откроет `4310/tcp`.

## Что куда ставится

| Путь | Что это |
|---|---|
| `/opt/bills/repo` | зеркало git-репозитория (`git clone --mirror`) |
| `/opt/bills/releases/<ГГГГММДД-ЧЧММСС>-<sha>/` | релизы: код + `node_modules` + собранный `apps/web/dist` |
| `/opt/bills/current` | симлинк на рабочий релиз (из него запускается сервис) |
| `/opt/bills/previous` | симлинк на предыдущий релиз (для отката) |
| `/opt/bills/bin/` | эти скрипты (`install.sh`, `update.sh`, `backup.sh`, `restore.sh`, `bills.sh`, `lib.sh`) |
| `/usr/local/bin/bills` | команда-обёртка для оператора |
| `/var/lib/bills/hub.db` | база данных SQLite (WAL) |
| `/var/lib/bills/backups/` | бэкапы `hub-ГГГГ-ММ-ДД_ЧЧ-мм-сс.db.gz` |
| `/var/lib/bills/last-backup.json` | маркер последнего бэкапа (его показывает `/api/health`) |
| `/var/lib/bills/updates.log` | журнал обновлений и откатов |
| `/etc/bills/hub.env` | настройки (шаблон — `hub.env.example`) |
| `/etc/systemd/system/bills-hub.service` | сервис HUB (`User=bills`, `Restart=always`) |
| `/etc/systemd/system/bills-backup.{service,timer}` | ночной бэкап в 03:30 |

Сервис работает от системного пользователя `bills` (без шелла, home `/opt/bills`).
Node 24 ставится в систему (`/usr/bin/node`); логи — в journald.

## Команда `bills`

```
bills status            состояние сервиса, таймера, текущий релиз, адрес для планшетов
bills logs [-n 200]     логи HUB (journalctl -u bills-hub -f)
bills restart           перезапустить HUB
bills update [...]      обновить (см. ниже)
bills backup            бэкап сейчас
bills restore [файл]    восстановить базу (без файла — список бэкапов)
bills check [файл]      PRAGMA integrity_check базы или файла
bills version           версия HUB
bills health            ответ /api/health
```

Команда сама поднимается до root через `sudo`.

## Обновление и откат

```bash
sudo bills update                 # до последнего main
sudo bills update --ref v0.2.0    # до тега / ветки / sha
sudo bills update --force         # даже если идут игры или не удался бэкап
sudo bills update --rollback      # вернуться на предыдущий релиз
```

Что происходит при обновлении:

1. `git fetch` в зеркало; если текущий релиз уже на целевом коммите — выход.
2. Проверка `/api/state`: если на столах идут игры и нет `--force` — отказ.
   Обновление перезапускает HUB примерно на 10 секунд; игры сохраняются и время
   считается дальше, но лучше обновлять, когда столы свободны.
3. Бэкап базы в `/var/lib/bills/backups` (через CLI, `VACUUM INTO`).
4. Новый релиз: `git clone --local` из зеркала, `npm ci`, `npm run build -w @bills/web`.
   Ошибка сборки = ошибка обновления, текущий релиз не трогается.
5. Атомарное переключение симлинка `current`, `systemctl restart bills-hub`,
   ожидание `/api/health` до 60 с.
6. Если health не прошёл — автоматический **откат** на предыдущий релиз и перезапуск.
7. Хранятся 3 релиза (current, previous и один старее), остальные удаляются.

Результат каждой попытки пишется в `/var/lib/bills/updates.log`.

## Бэкапы

Таймер `bills-backup.timer` запускает `backup.sh` каждый день в 03:30 (с разбросом до 10 минут,
пропущенный запуск выполняется после включения сервера). Скрипт:

- делает консистентную копию базы через CLI (`VACUUM INTO` + `integrity_check`, HUB останавливать не нужно);
- сжимает её в `hub-*.db.gz`;
- удаляет локальные копии старше `BACKUP_KEEP_DAYS` (по умолчанию 30 дней);
- при заданном `BACKUP_RCLONE_REMOTE` выгружает копию в облако и чистит там старые;
- при заданном `BACKUP_SECOND_DIR` копирует на второй диск/USB (только если он примонтирован).

```bash
sudo bills backup                              # бэкап вручную
systemctl list-timers bills-backup.timer       # когда следующий запуск
journalctl -u bills-backup -n 50               # лог последних бэкапов
systemctl status bills-backup.service          # failed = последний бэкап с ошибкой
ls -lh /var/lib/bills/backups/
```

Последний удачный бэкап виден в `/api/health` (`lastBackupAt`) и в метрике
`bills_last_backup_timestamp_seconds` — удобно повесить алерт «бэкапа не было больше суток».

### Подключить rclone (облако: Google Drive, Яндекс.Диск, S3 и т.п.)

```bash
sudo apt install rclone
sudo -u bills -H rclone config          # создайте remote, например gdrive
sudo -u bills -H rclone lsd gdrive:     # проверка доступа
```

В `/etc/bills/hub.env` укажите `BACKUP_RCLONE_REMOTE=gdrive:bills-backups/club-1` и
запустите `sudo bills backup` для проверки. Конфиг rclone хранится в `/opt/bills/.config/rclone/`.

### Второй диск / USB

Примонтируйте диск (например, в `/mnt/usb` через `/etc/fstab` с опцией `nofail`), создайте папку
`/mnt/usb/bills-backups`, дайте права пользователю `bills` (`chown bills:bills`) и укажите
`BACKUP_SECOND_DIR=/mnt/usb/bills-backups` в `hub.env`. Если диск не примонтирован, копия
на него пропускается с предупреждением (на корневой диск ничего не пишется).

## Восстановление

```bash
sudo bills restore                                      # список последних бэкапов
sudo bills restore /var/lib/bills/backups/hub-2026-10-18_03-30-00.db.gz
sudo bills restore hub-2026-10-18_03-30-00.db.gz --yes  # без подтверждения, имя внутри папки бэкапов
```

Скрипт останавливает HUB, распаковывает `.gz`, вызывает CLI `restore` (проверка целостности,
старая база сохраняется как `hub.db.before-restore-<штамп>`), запускает HUB и ждёт `/api/health`.
Всё, что было записано после создания бэкапа, теряется — скрипт предупреждает об этом и
показывает, идут ли сейчас игры.

## Логи и диагностика

```bash
bills logs                          # хвост логов HUB в реальном времени
journalctl -u bills-hub -n 200      # последние 200 строк
journalctl -u bills-hub --since today
bills health                        # JSON /api/health
bills check                         # целостность базы
cat /var/lib/bills/updates.log
```

Настройки меняются в `/etc/bills/hub.env`, после чего `sudo systemctl restart bills-hub`.

## Мониторинг

HUB отдаёт:

- `GET /api/health` — JSON `{ ok, now, version, gitSha, uptimeSeconds, dbSizeBytes, lastBackupAt, freeDiskBytes, schemaVersion }`;
- `GET /metrics` — Prometheus text: `bills_sessions_active`, `bills_alerts_open`,
  `bills_lamp_commands_pending`, `bills_outbox_pending`, `bills_hub_uptime_seconds`,
  `bills_db_size_bytes`, `bills_last_backup_timestamp_seconds`, `bills_disk_free_bytes`,
  `bills_hub_info{version,git_sha}`.

**Uptime Kuma:** монитор типа HTTP(s) — Keyword, URL `http://<ip>:4310/api/health`, ключевое слово `"ok":true`.

**Prometheus** (`prometheus.yml`):

```yaml
scrape_configs:
  - job_name: bills-hub
    scrape_interval: 30s
    static_configs:
      - targets: ['192.168.1.10:4310']
        labels:
          club: club-1
```

Полезные правила алертов:

```yaml
groups:
  - name: bills
    rules:
      - alert: BillsHubDown
        expr: up{job="bills-hub"} == 0
        for: 2m
      - alert: BillsBackupStale
        expr: time() - bills_last_backup_timestamp_seconds > 36 * 3600
        for: 10m
      - alert: BillsDiskLow
        expr: bills_disk_free_bytes < 2 * 1024 * 1024 * 1024
```

Метрики и health доступны без авторизации — ещё одна причина держать HUB только в LAN.

## Файлы в этой папке

| Файл | Назначение |
|---|---|
| `install.sh` | установка (идемпотентна), работает и через `curl \| sudo bash` |
| `update.sh` | обновление / откат с health-check |
| `backup.sh` | бэкап (таймер и вручную) |
| `restore.sh` | восстановление из бэкапа |
| `bills.sh` | обёртка `bills <команда>` |
| `lib.sh` | общие функции (пути, логирование, запуск от `bills`, health) |
| `hub.env.example` | шаблон `/etc/bills/hub.env` |
| `systemd/` | `bills-hub.service`, `bills-backup.service`, `bills-backup.timer` |
