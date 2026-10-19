# @bills/cloud — облако TS

Сервер сети клубов: принимает журнал событий от HUB каждого клуба, хранит настройки
(тарифы, столы) по версиям и отдаёт владельцу сводку по всем клубам компании.
Fastify 5, Node 24, TypeScript без сборки (`node src/main.ts`).

## Архитектура

```
HUB клуба A ──POST /sync/events──▶ ┌─────────────┐ ◀── cookie ── кабинет владельца
HUB клуба B ──POST /sync/snapshot─▶ │   облако    │      (apps/cloud-web, /api/owner/*)
            ◀─GET /sync/settings── └─────────────┘
                                     │
                              SQLite | PostgreSQL
```

- **Вверх (HUB → облако).** HUB шлёт пачки строк своего `outbox` (`SyncEventsRequest`).
  Каждое событие сохраняется в сырой журнал `events` с ключом `(hub_id, outbox_id)` —
  повторная доставка той же пачки безвредна: дубликат пропускается и проекция для него
  не применяется повторно. Вставка события и проекция — одна транзакция.
- **Проекция** (`src/projection.ts`) превращает события в читаемые таблицы:
  `sessions` (игры, включая паузы `PAUSED`, перенос стола, отмену с подтверждением
  управляющего, счёт и время оплаты), `checks` (счета: OPEN/PAID/VOID, скидка, оплачено,
  возвращено), `payments` (строка на каждую часть оплаты и на каждый возврат,
  `id = hub:outbox[:part]`), `shifts` и `cash_movements` (кассовые смены с Z-отчётом,
  внесения/изъятия), `power_outages` (отключения света по ИБП), `alerts` (тревоги)
  и `daily_stats` по локальным дням клуба. В `daily_stats` колонка `revenue` — это
  **начислено на «Стоп»** (в отчётах `billed`; отменённые игры вычитаются), а
  `paid_cash/card/qr/paid_total` и `refunded` — оплаты по дню платежа; в отчётах
  `revenue = paid_total − refunded`, `averageCheck = revenue / checksPaid`.
  Неизвестные топики остаются только в сыром журнале. Пропуски выдерживаются:
  `session.closed` или `check.paid` без предыдущих событий всё равно создают строку.
- **Смены и отключения в кабинете.** `ClubSummary.openShift/lastClosedShift` и
  `OwnerOverview.recentShifts` (закрытые за 7 дней по всем клубам) — `CloudShiftView`:
  у закрытой смены `net` берётся из Z-отчёта HUB, `sales/refunds` — из `payments`
  по смене, `checksPaid` — число оплаченных счетов смены, `deposits/withdrawals` —
  из `cash_movements`; у открытой смены `expectedCash/countedCash/difference` = null.
  `ClubDetails.shifts` и `ClubDetails.outages` — за 30 дней. `TableStats.revenue`
  остаётся начисленным по столу (загрузка стола), не оплаченным.
- **Настройки** (`src/sync.ts`, `src/settings.ts`). У клуба одна запись `club_settings`
  с версией. HUB присылает снимок своих настроек (`POST /sync/snapshot`); он принимается,
  если HUB на текущей версии облака, иначе 409 — HUB сначала должен забрать
  `GET /sync/settings?since=<его версия>`. Правка тарифов владельцем даёт версию +1,
  и ответ на следующую пачку событий (`settingsVersion`) говорит HUB, что пора забрать.
- **Отчёты** (`src/reports.ts`). Сегодня/неделя/месяц считаются из `daily_stats` по
  поясу каждого клуба; загрузка по часам и по столам режется на чтении из `sessions`
  по локальным часам (идущие игры — до «сейчас»).
- **Слой базы** (`src/db/`). Один интерфейс `SqlDriver` (`all`, `run`, `transaction`,
  `close`), SQL в коде с плейсхолдерами `?`. `sqlite.ts` — `node:sqlite` с async-мьютексом
  (одно соединение, транзакции по очереди). `postgres.ts` — поверх `pg.Pool`,
  переводит `?` → `$n` вне строковых литералов, транзакцию выполняет на выделенном клиенте.
  Миграции `src/migrations/NNN_name.sql` — портируемый SQL для обоих движков
  (TEXT-идентификаторы, BIGINT-время, INTEGER 0/1, JSON в TEXT, без AUTOINCREMENT/SERIAL/PRAGMA).
  `002_money.sql` пересобирает `sessions` (SQLite не меняет CHECK на месте: `sessions_v2` →
  копия → `DROP` → `RENAME`, индексы заново), добавляет денежные колонки в `daily_stats`
  и создаёт `checks`, `payments`, `shifts`, `cash_movements`, `power_outages`.

## Запуск

```sh
npm install
node --env-file-if-exists=.env apps/cloud/src/main.ts    # или: npm run dev -w @bills/cloud
```

Переменные окружения (все необязательны, см. `.env.example` в корне):

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `CLOUD_HOST` / `CLOUD_PORT` | `127.0.0.1` / `4320` | адрес сервера |
| `CLOUD_DB_PATH` | `apps/cloud/data/cloud.db` | файл SQLite |
| `CLOUD_DATABASE_URL` | — | строка подключения PostgreSQL; если задана, SQLite не используется |
| `CLOUD_DEMO_SEED` | `1` для SQLite, `0` для PostgreSQL | демо-сид на пустой базе |
| `CLOUD_SECURE_COOKIES` | `0` | ставить флаг `Secure` на cookie владельца (только за HTTPS) |
| `DATABASE_URL` | — | то же, что `CLOUD_DATABASE_URL` (так её называют Render и Supabase) |
| `CLOUD_DATABASE_SSL` | `1` для не-локальной базы | TLS к PostgreSQL без проверки CA (Supabase); `0` — выключить |
| `CLOUD_CORS_ORIGINS` | `https://*.web.app,https://*.firebaseapp.com` | кабинеты на других доменах; вход отдаёт токен в `X-Owner-Token`, дальше `Authorization: Bearer` (cookie через домены не ходят) |
| `PORT` | — | порт от хостинга (Render), если `CLOUD_PORT` не задан |

Демо-сид создаёт компанию «Демо сеть», владельца `owner@demo.kz` / `demo1234`, клубы
«Клуб «Демо»» и «Клуб «Север»» (Asia/Almaty) и по одному HUB с фиксированными ключами —
`hub-demo-1` / `demo-hub-key-1` и `hub-demo-2` / `demo-hub-key-2`. Ключи печатаются в лог при
создании; их же можно сразу вписать в `.env` HUB (`CLOUD_URL`, `CLOUD_API_KEY`, `HUB_ID`).

Проверка: `npm test -w @bills/cloud` (node --test, SQLite в памяти) и `npx tsc -p apps/cloud`.

## Режимы базы

- **SQLite** (разработка, один клуб-два клуба): файл `CLOUD_DB_PATH`, WAL, внешние ключи
  включены. Так работает всё, что покрыто тестами.
- **PostgreSQL** (продакшен): `CLOUD_DATABASE_URL=postgres://user:pass@host:5432/bills`.
  Диалект проверен на настоящем PostgreSQL: тесты гоняют драйвер через
  [PGlite](https://pglite.dev) — PostgreSQL 18 (парсер, планировщик, типы, `ON CONFLICT`,
  транзакции), собранный в WASM и запущенный в процессе, без сервера. Адаптер
  `test/pglite.ts` отдаёт PGlite как `pg.Pool` (одно соединение под мьютексом).
  - `test/pg-dialect.test.ts` всегда идёт на PGlite: миграции и сид (повторный запуск ничего
    не меняет), один и тот же поток HUB + кабинет владельца (смена, оплаты, скидки, возврат,
    предоплата, пауза, отключение питания, тревоги, Z-отчёт, снапшот, настройки, тарифы)
    на SQLite и на PostgreSQL — все HTTP-ответы совпадают; параллельные пачки двух HUB.
  - Весь набор тестов на PostgreSQL: `CLOUD_TEST_DB=pglite npm test -w @bills/cloud`
    (по умолчанию тесты идут на SQLite).

  Чего PGlite не покрывает: сетевой `pg.Pool` с несколькими соединениями (настоящая
  конкуренция транзакций), SSL, права пользователя БД. Перед вводом в эксплуатацию всё равно
  прогоните миграции и тестовую синхронизацию с HUB на стенде с живой базой.
  `BIGINT`/`NUMERIC` приходят из `pg` строками; `main.ts` настраивает парсер типов в `Number`
  (адаптер PGlite делает то же).

## HTTP

Ошибки — `{ error: { code, message } }`; сообщения на русском для людей.

HUB (`Authorization: Bearer <ключ>`; `hubId` в теле должен совпадать с HUB ключа, иначе 403 `HUB_MISMATCH`; неизвестный ключ — 401):

| Метод и путь | Тело → ответ |
|---|---|
| `POST /sync/events` | `SyncEventsRequest` → `SyncEventsResponse { lastAcceptedId, inserted, settingsVersion }` |
| `POST /sync/snapshot` | `SyncSnapshotRequest` → `SyncSnapshotResponse`; 409 `{ accepted:false, settingsVersion }`, если HUB отстал |
| `GET /sync/settings?since=N` | `SyncSettingsResponse` (`changed:false`, если `since >= version`) |

Владелец (cookie `bills_owner`: HttpOnly, SameSite=Lax, Path=/, 30 дней; без cookie — 401 `UNAUTHORIZED`; чужой клуб — 404 `CLUB_NOT_FOUND`):

| Метод и путь | Ответ |
|---|---|
| `POST /api/auth/login { email, password }` | `OwnerView` (неверно — 401 `INVALID_CREDENTIALS`) |
| `POST /api/auth/logout` | `{ ok: true }` |
| `GET /api/auth/me` | `OwnerView` |
| `GET /api/owner/overview` | `OwnerOverview` |
| `GET /api/owner/clubs/:id` | `ClubDetails` |
| `GET /api/owner/clubs/:id/sessions?day=YYYY-MM-DD` | `CloudSessionView[]` (по умолчанию — сегодня клуба) |
| `PUT /api/owner/clubs/:id/tariffs` | `UpdateTariffsRequest` → `UpdateTariffsResponse`; 400 `TARIFF_INVALID` |
| `GET /api/health` | `{ ok: true, now }`; с `?db=1` ещё читает таблицу (`companies`) — keep-alive для бесплатного Supabase |

Типы — в `packages/domain/src/cloud.ts`.

## Персональные данные и хостинг

В облаке хранятся персональные данные: почта и имена владельцев, имена сотрудников
(в журнале событий — кто открыл и остановил игру, в настройках — список персонала).
Закон Республики Казахстан «О персональных данных и их защите» требует хранить персональные
данные граждан РК на серверах, физически расположенных на территории Казахстана. Поэтому
облако TS и его базу данных нужно размещать у хостинг-провайдера с дата-центром в РК,
а не на зарубежных площадках; резервные копии — тоже внутри страны. Пароли хранятся только
в виде scrypt-хэшей, ключи HUB — в виде sha256-хэшей.
