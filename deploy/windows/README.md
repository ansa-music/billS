# TS HUB на Windows (запасной вариант ОС)

Основная платформа HUB — Linux (см. `deploy/linux/`). Этот набор скриптов — для случая, когда в клубе
уже стоит ПК с Windows 10/11 и ставить Linux некому. HUB работает как задача Планировщика Windows
(без сторонних программ), сам перезапускается при падении и стартует вместе с системой до входа пользователя.

Все скрипты — PowerShell 5.1 (встроен в Windows), сообщения по-русски, файлы в UTF-8 с BOM.

## Что ставится и куда

| Путь | Что |
|---|---|
| `C:\bills\app\` | код (git clone `https://github.com/ansa-music/billS.git`), `node_modules`, сборка экрана зала `apps\web\dist` |
| `C:\bills\app\.env` | конфигурация HUB (создаётся из `hub.env.example`, при повторной установке не перезаписывается) |
| `C:\bills\data\hub.db` | база SQLite (+ `hub.db-wal`, `hub.db-shm` при работе) |
| `C:\bills\data\last-backup.json` | маркер последнего бэкапа (его показывает `/api/health` → `lastBackupAt`) |
| `C:\bills\backups\hub-ГГГГ-ММ-ДД_ЧЧ-мм-сс.zip` | ежедневные бэкапы, хранятся 30 дней |
| `C:\bills\logs\hub.log` (+ `hub.1.log`) | лог HUB, ротация при 20 МБ |
| `C:\bills\logs\install.log`, `backup.log`, `update.log`, `restore.log` | логи скриптов |
| `C:\bills\bin\` | копии скриптов (`run-hub.cmd`, `backup.ps1`, `update.ps1`, `restore.ps1`, `hub.ps1`, `uninstall.ps1`, `connect-cloud.ps1`, `common.ps1`) — именно их вызывают задачи Планировщика |
| Планировщик: задача **billS HUB** | триггер «При запуске системы», от `NT AUTHORITY\SYSTEM`, без лимита времени, перезапуск при сбое каждую минуту (999 раз), одна копия, не останавливается на батарее |
| Планировщик: задача **billS Backup** | ежедневно в 03:30 → `bin\backup.ps1` |
| Брандмауэр: правило **billS HUB (LAN)** | входящий TCP 4310 только для профилей «Частная» и «Доменная» сеть |

Имена задач, службы и правила брандмауэра (`billS HUB`, `billS Backup`, `billS-HUB`) — технические идентификаторы: они сохранены, чтобы обновление и удаление находили уже установленные копии.

Папку `C:\bills` и порт можно поменять параметрами `-Root` и `-Port` при установке.

## Требования

- Windows 10 (1809+) или Windows 11, права администратора.
- Node.js 24+ и git. Если их нет, `install.ps1` поставит их через `winget`; если winget отсутствует —
  скрипт скажет, откуда скачать MSI (https://nodejs.org/en/download, https://git-scm.com/download/win).
- Интернет нужен только для установки и обновления. Работа клуба от интернета не зависит.
- Желательно: ИБП и статический IP (или резервирование адреса в роутере), чтобы планшеты не теряли HUB.

## Установка

Главный путь — скачать репозиторий и запустить установщик самому:

```powershell
# PowerShell ОТ ИМЕНИ АДМИНИСТРАТОРА
git clone https://github.com/ansa-music/billS.git C:\Temp\billS     # или скачайте zip с GitHub и распакуйте
cd C:\Temp\billS\deploy\windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Параметры (все необязательны):

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Ref main -Root C:\bills -HubHost 0.0.0.0 -Port 4310 `
    [-RunAs "DOMAIN\user"] [-SecondDir E:\bills-backups] [-RcloneRemote gdrive:bills-backups] [-BackupKeepDays 30] [-BackupTime 03:30]
```

- `-Ref` — ветка, тег или commit, который нужно развернуть.
- `-HubHost 0.0.0.0` — HUB слушает все интерфейсы, чтобы планшеты в сети клуба могли подключиться. `127.0.0.1` — только этот ПК.
- `-RunAs` — запускать HUB не от SYSTEM, а от указанной учётной записи (пароль будет запрошен; у учётки должно быть право «Вход в качестве пакетного задания»).
- `-SecondDir`, `-RcloneRemote` — настройки второй копии бэкапа, записываются в задачу `billS Backup`.

Установщик идемпотентен: повторный запуск обновит код до `-Ref`, пересоздаст задачи и правило брандмауэра, но не тронет `.env` и базу.

В конце установщик печатает адрес для планшетов вида `http://192.168.1.50:4310/`, пути к базе и бэкапам и команды управления.

### Вариант одной строкой

```powershell
# PowerShell от администратора. Необязательно: $env:BILLS_REF='main'; $env:BILLS_ROOT='C:\bills'
irm https://raw.githubusercontent.com/ansa-music/billS/main/deploy/windows/bootstrap.ps1 | iex
```

`bootstrap.ps1` скачивает архив репозитория с GitHub во временную папку и запускает из него `install.ps1`.
Удобно, но вы выполняете скрипт, не глядя в него, — для первого раза лучше ручной путь выше.

### Проверка после установки

```powershell
C:\bills\bin\hub.ps1 status                 # задача, процессы, health, последний бэкап, LAN-адреса
Invoke-RestMethod http://127.0.0.1:4310/api/health
Get-Content C:\bills\logs\hub.log -Tail 50 -Wait
```

> **Экран зала.** Каждый релиз собирает `apps/web/dist` (`npm run build -w @bills/web`). Раздача собранного экрана самим HUB по адресу `http://<ip>:4310/` — отдельный пункт этапа 1; пока он не слит, планшеты открывают экран зала там, где он запущен (`npm run dev -w @bills/web`, порт 5173, прокси `/api` на HUB), а адрес `:4310` отвечает по `/api/*` и `/metrics`.

С планшета откройте `http://<IP ПК>:4310/`. Если не открывается: проверьте, что сеть на ПК помечена
как «Частная» (Параметры → Сеть и Интернет → свойства подключения), а не «Общедоступная» — правило брандмауэра
сознательно не действует в общедоступном профиле.

## Конфигурация (`C:\bills\app\.env`)

Шаблон — `hub.env.example`. Переменные читает Node через `--env-file-if-exists`:

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `HUB_HOST` | `0.0.0.0` | адрес прослушивания |
| `HUB_PORT` | `4310` | порт |
| `HUB_DB_PATH` | `C:\bills\data\hub.db` | база SQLite |
| `HUB_BACKUP_MARKER` | `C:\bills\data\last-backup.json` | маркер последнего бэкапа |
| `HUB_DEMO_TZ` | `Asia/Almaty` | часовой пояс демо-клуба |
| `HUB_SIM_LATENCY_MS` | `300` | задержка симулятора ламп |

После правки `.env` перезапустите HUB: `C:\bills\bin\hub.ps1 restart`. Если меняете порт — запустите
`install.ps1 -Port <новый>` ещё раз, чтобы переписать правило брандмауэра (`.env` он не перезапишет — порт в `.env` поменяйте руками).

## Управление HUB

```powershell
C:\bills\bin\hub.ps1 status
C:\bills\bin\hub.ps1 stop          # Stop-ScheduledTask + завершение оставшихся процессов node
C:\bills\bin\hub.ps1 start
C:\bills\bin\hub.ps1 restart
C:\bills\bin\hub.ps1 log           # хвост hub.log в реальном времени

# то же средствами Windows:
Start-ScheduledTask -TaskName 'billS HUB'
Stop-ScheduledTask  -TaskName 'billS HUB'
Get-ScheduledTaskInfo -TaskName 'billS HUB'
```

Как это работает: задача запускает `C:\bills\bin\run-hub.cmd`, который в бесконечном цикле стартует
`node --env-file-if-exists=C:\bills\app\.env apps\hub\src\main.ts >> C:\bills\logs\hub.log`. Если node упал — пауза 3 с и
новый запуск, не дожидаясь Планировщика. Если упала сама обёртка — Планировщик перезапустит задачу через минуту.
`Stop-ScheduledTask` завершает обёртку; `hub.ps1 stop` дополнительно убивает node, если он остался.

## Бэкапы

Задача `billS Backup` ежедневно в 03:30 запускает `backup.ps1`:

1. `node apps\hub\src\cli.ts backup C:\bills\backups` — консистентная копия базы (`VACUUM INTO`) **без остановки HUB**;
2. сжатие в `hub-ГГГГ-ММ-ДД_ЧЧ-мм-сс.zip`, исходный `.db` удаляется;
3. удаление архивов старше `-KeepDays` (30);
4. при `-SecondDir E:\bills-backups` — копия на второй диск/флешку (если диска нет — предупреждение, не ошибка);
5. при `-RcloneRemote remote:папка` и наличии `rclone.exe` в PATH — копия в облако (`rclone copy`).

```powershell
C:\bills\bin\backup.ps1                                  # вручную, прямо сейчас
C:\bills\bin\backup.ps1 -SecondDir E:\bills-backups      # с копией на флешку
Get-Content C:\bills\logs\backup.log -Tail 20
Start-ScheduledTask -TaskName 'billS Backup'             # запустить задачу Планировщика
```

Коды выхода: 0 — успех, 1 — бэкап не сделан (это ошибка, разбирайтесь), 2 — бэкап сделан, но дополнительная копия не удалась.
Код виден в Планировщике как «Результат последнего запуска».

Одного диска мало: если умрёт SSD, пропадут и база, и бэкапы. Минимум — флешка/второй диск через `-SecondDir`,
лучше — облако через rclone (`rclone config` один раз, затем `install.ps1 -RcloneRemote имя:bills-backups`).

## Обновление и откат

```powershell
C:\bills\bin\update.ps1                 # до origin/main
C:\bills\bin\update.ps1 -Ref v1.4.0     # до тега или commit
```

`update.ps1`: бэкап → остановка HUB → `git fetch` + `checkout` → `npm ci` → сборка экрана зала → запуск → ожидание
`/api/health` до 60 с. Если HUB не поднялся — автоматически `git checkout <прежний commit>`, `npm ci`, запуск и повторная
проверка; скрипт сообщает об откате и завершается с кодом 1. Лог — `C:\bills\logs\update.log`.
Обновление занимает несколько минут — делайте его не в разгар смены (идущие игры HUB после рестарта восстанавливает).

Откат вручную на любую версию — это то же обновление: `update.ps1 -Ref <старый тег или sha>`.
Папка `C:\bills\app` управляется скриптами: локальные правки файлов репозитория при обновлении сбрасываются (`.env` не трогается).

## Восстановление из бэкапа

```powershell
C:\bills\bin\restore.ps1                                             # список последних бэкапов
C:\bills\bin\restore.ps1 -File C:\bills\backups\hub-2026-10-18_03-30-00.zip
C:\bills\bin\restore.ps1 -File hub-2026-10-18_03-30-00.zip -Yes      # без вопроса (имя из папки backups)
```

Скрипт распакует zip, проверит файл (`cli.ts check`), попросит ввести `YES`, остановит HUB, выполнит
`cli.ts restore <файл> --yes` (старая база сохраняется как `hub.db.before-restore-<штамп>`), запустит HUB и дождётся health.
Всё, что было создано в базе после момента бэкапа, пропадёт — восстанавливайте только осознанно.

## Логи

| Что | Где |
|---|---|
| HUB (stdout/stderr node, JSON-строки Fastify) | `C:\bills\logs\hub.log`, предыдущее поколение `hub.1.log` |
| установка / удаление | `C:\bills\logs\install.log` |
| бэкапы | `C:\bills\logs\backup.log` |
| обновления | `C:\bills\logs\update.log` |
| восстановления | `C:\bills\logs\restore.log` |
| история запусков задач | Планировщик заданий → Библиотека → `billS HUB` → вкладка «Журнал» (нужно включить «Включить журнал всех заданий» в меню «Действия») |

## Чтобы Windows не перезагружала HUB посреди смены

Скрипты системные настройки не меняют — это решение владельца ПК. Что нужно сделать руками:

1. **Период активности.** Параметры → Обновление и безопасность → Центр обновления Windows → *Изменить период активности*
   (Windows 11: Параметры → Центр обновления Windows → Дополнительные параметры → *Период активности*). Укажите рабочие часы
   клуба (максимум 18 часов подряд, например 12:00–06:00). В это окно Windows не перезагружается для установки обновлений.
2. **Запрет автоперезагрузки (Windows Pro/Enterprise).** `gpedit.msc` → Конфигурация компьютера → Административные шаблоны →
   Компоненты Windows → Центр обновления Windows:
   - «Не выполнять автоматическую перезагрузку при автоматической установке обновлений, если в системе работают пользователи» → *Включено*;
   - «Настройка автоматического обновления» → *Включено*, вариант **2** (уведомлять перед загрузкой) или **3** (загружать, уведомлять перед установкой);
   - при наличии — «Отключить автоматическую перезагрузку для обновлений в период активности» → *Включено*.
   После этого обновления ставьте сами, в выходной или утром, затем перезагружайте ПК: HUB поднимется автоматически.
3. **Windows Home** (нет gpedit): ограничьтесь периодом активности и «Приостановить обновления» на 1–5 недель перед важными периодами.
4. **Сон и питание.** Панель управления → Электропитание → схема «Высокая производительность»; «Переводить компьютер в спящий режим» → *Никогда*;
   для ноутбука — «Действие при закрытии крышки» → *Ничего не делать*. Иначе HUB уснёт вместе с ПК.
5. **Автовход не нужен.** Задача запускается от SYSTEM при старте системы — входить в Windows не требуется. Можно оставить ПК на экране входа.
6. **ИБП.** HUB должен пережить мигание света: достаточно ИБП на 600–1000 ВА для мини-ПК и роутера. Контроллер ламп —
   отдельная история (реле держат состояние, HUB после старта досылает команды), но роутер и HUB должны быть на ИБП,
   иначе планшеты теряют связь. Для ИБП с USB поставьте фирменную утилиту и настройте корректное выключение при 10–15 % заряда —
   SQLite в WAL-режиме переживает внезапное отключение, но лучше его не проверять.

## Подключение к облаку TS (кабинет владельца сети)

Облако и кабинет владельца в бесплатном режиме работают на Linux-мини-ПК главного клуба
(`deploy/linux`, `install.sh --with-cloud`). HUB на Windows в другом клубе подключается к нему так:

1. На главном мини-ПК владелец выдаёт ключ для этого клуба: `sudo bills cloud add-club --name "Клуб 2"` —
   команда печатает `HUB_ID=…` и `CLOUD_API_KEY=…`.
2. На этом ПК поставьте **Tailscale для Windows** — https://tailscale.com/download/windows — и войдите
   **тем же аккаунтом**, что и на главном мини-ПК. Адрес облака (`http://100.x.y.z:4320`) показывает
   на главном мини-ПК `sudo bills tailscale --status`.
3. PowerShell от администратора:

```powershell
C:\bills\bin\connect-cloud.ps1 -Url http://100.x.y.z:4320 -HubId <HUB_ID> -Key <CLOUD_API_KEY>
```

Скрипт проверяет `<Url>/api/health` (если облако не отвечает — предупреждает, но настройки всё равно
записывает), сохраняет копию `C:\bills\app\.env.bak`, записывает `CLOUD_URL`, `HUB_ID`, `CLOUD_API_KEY`
в `C:\bills\app\.env` и перезапускает HUB (задача Планировщика или служба NSSM). Лог —
`C:\bills\logs\connect-cloud.log`. Порт облака и HUB на роутере не пробрасываются.
Подробно, по шагам: [docs/FREE_SETUP_RU.md](../../docs/FREE_SETUP_RU.md).

## Безопасность сети

- HUB не имеет аутентификации на уровне сети и **не должен быть доступен из интернета**. Не пробрасывайте порт 4310 на роутере.
- Правило брандмауэра создаётся только для профилей «Частная» и «Доменная». Если Windows считает сеть «Общедоступной» — переключите тип сети, а не правило.
- Для доступа владельца извне используйте VPN (Tailscale — см. «Подключение к облаку TS» выше, или WireGuard), а не проброс порта.

## Удаление

```powershell
C:\bills\bin\uninstall.ps1        # убирает задачи Планировщика и правило брандмауэра
```

База, бэкапы, код и логи остаются в `C:\bills` — скрипт напоминает, где они. Удалить всё: `Remove-Item -Recurse -Force C:\bills`
(сначала скопируйте бэкапы). Node.js и git удаляются через «Приложения и возможности».

## Вариант с NSSM (настоящая служба Windows)

Если нужна именно служба (видна в `services.msc`, управляется `sc`/`Get-Service`, зависимости, аккаунт службы) —
используйте [NSSM](https://nssm.cc/) (Non-Sucking Service Manager). Это одиночный `nssm.exe`, установить можно `winget install NSSM.NSSM`
или скопировать в `C:\bills\bin\`.

Почему не `sc.exe create ... binPath= node.exe`: служба Windows обязана общаться с диспетчером служб (SCM) — вызвать
`StartServiceCtrlDispatcher` и отвечать на команды стоп/пауза. `node.exe` этого не делает, поэтому SCM ждёт 30 с и убивает процесс
с ошибкой 1053 («служба не ответила на запрос запуска»). NSSM берёт общение с SCM на себя и запускает node как дочерний процесс.

```powershell
# PowerShell от администратора. Сначала остановите и отключите задачу Планировщика:
C:\bills\bin\hub.ps1 stop
Disable-ScheduledTask -TaskName 'billS HUB'

nssm install billS-HUB "C:\Program Files\nodejs\node.exe" --env-file-if-exists=C:\bills\app\.env apps\hub\src\main.ts
nssm set billS-HUB AppDirectory C:\bills\app
nssm set billS-HUB DisplayName "billS HUB"
nssm set billS-HUB Description "TS HUB — сервер клуба"
nssm set billS-HUB Start SERVICE_AUTO_START
nssm set billS-HUB AppStdout C:\bills\logs\hub.log
nssm set billS-HUB AppStderr C:\bills\logs\hub.log
nssm set billS-HUB AppRotateFiles 1
nssm set billS-HUB AppRotateOnline 1
nssm set billS-HUB AppRotateBytes 20971520
nssm set billS-HUB AppExit Default Restart
nssm set billS-HUB AppRestartDelay 3000
nssm set billS-HUB AppStopMethodConsole 5000
nssm start billS-HUB
```

Скрипты `update.ps1`, `restore.ps1`, `hub.ps1` сами замечают службу `billS-HUB` и останавливают/запускают её вместо задачи
Планировщика. `install.ps1` при наличии службы регистрирует задачу `billS HUB` отключённой. Бэкапы по-прежнему делает задача `billS Backup`.

Убрать службу: `nssm stop billS-HUB; nssm remove billS-HUB confirm`, затем `Enable-ScheduledTask -TaskName 'billS HUB'`
и `Start-ScheduledTask -TaskName 'billS HUB'`.

## Если что-то не так

| Симптом | Что смотреть |
|---|---|
| Планшеты не видят HUB | `hub.ps1 status`; тип сети «Частная»; `Test-NetConnection <IP> -Port 4310` с другого ПК; `HUB_HOST=0.0.0.0` в `.env` |
| HUB постоянно перезапускается | `Get-Content C:\bills\logs\hub.log -Tail 100` — обычно `EADDRINUSE` (порт занят старым процессом → `hub.ps1 stop`, затем `start`) или ошибка базы |
| Задача в состоянии «Готово», а процесса нет | `Get-ScheduledTaskInfo -TaskName 'billS HUB'` → `LastTaskResult`; код `0x1` обычно значит, что `run-hub.cmd` не нашёл `main.ts` (см. первую строку `hub.log`) |
| `/api/health` → `lastBackupAt` старый | `Get-ScheduledTaskInfo -TaskName 'billS Backup'`, `backup.log`; задача пропущена, если ПК был выключен в 03:30 (с `StartWhenAvailable` она выполнится при включении) |
| Нет места на диске | `freeDiskBytes` в health; `C:\bills\backups` и `hub.1.log`; уменьшите `-BackupKeepDays` |
| После обновления Windows HUB не стартует | `Get-ScheduledTask -TaskName 'billS HUB'` существует? Если нет — повторно `install.ps1` (задачи иногда теряются при крупных апгрейдах) |
