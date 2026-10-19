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
| `CLOUD_FCM_SERVICE_ACCOUNT` / `CLOUD_FCM_SERVICE_ACCOUNT_JSON` | — | ключ сервисного аккаунта Firebase (путь к JSON или сам JSON); без него push выключены |
| `CLOUD_PUBLIC_URL` | из запроса | HTTPS-адрес облака для QR входа с телефона |
| `CLOUD_HUB_OFFLINE_MINUTES` | `10` | через сколько минут тишины HUB считается пропавшим (push `HUB_OFFLINE`) |
| `CLOUD_SHIFT_OPEN_HOURS` | `20` | через сколько часов открытая смена даёт push `SHIFT_NOT_CLOSED` |
| `CLOUD_PUSH_MAX_AGE_MINUTES` | `120` | тревоги, дошедшие до облака позже (HUB догоняет журнал), не пушатся |

Демо-сид создаёт компанию «Демо сеть», владельца `owner@demo.kz` / `demo1234`, клубы
«Клуб «Демо»» и «Клуб «Север»» (Asia/Almaty) и по одному HUB с фиксированными ключами —
`hub-demo-1` / `demo-hub-key-1` и `hub-demo-2` / `demo-hub-key-2`. Ключи печатаются в лог при
создании; их же можно сразу вписать в `.env` HUB (`CLOUD_URL`, `CLOUD_API_KEY`, `HUB_ID`).

Проверка: `npm test -w @bills/cloud` (node --test, SQLite в памяти) и `npx tsc -p apps/cloud`.

## Режимы базы

- **SQLite** (разработка, один клуб-два клуба): файл `CLOUD_DB_PATH`, WAL, внешние ключи
  включены. Так работает всё, что покрыто тестами.
- **PostgreSQL** (продакшен): `CLOUD_DATABASE_URL=postgres://user:pass@host:5432/bills`.
  Драйвер покрыт тестами на fake-клиенте (перевод плейсхолдеров, BEGIN/COMMIT/ROLLBACK,
  миграции без запрещённых конструкций). **На живой базе PostgreSQL режим не проверялся** —
  перед вводом в эксплуатацию прогоните миграции и тестовую синхронизацию с HUB на стенде.
  `BIGINT`/`NUMERIC` приходят из `pg` строками; `main.ts` настраивает парсер типов в `Number`.

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
| `GET /api/health` | `{ ok: true, now }` |

Типы — в `packages/domain/src/cloud.ts`.

## Телефон владельца: вход по ключу и push

Приложение `apps/mobile` (Capacitor) — тот же кабинет, но запросы идут на адрес облака из
настроек приложения с `Authorization: Bearer <токен сессии>` и `x-ts-app: 1`, без cookie.
Облако принимает владельца и по cookie, и по Bearer; при `x-ts-app: 1` ответы входа содержат
`token` и cookie не ставят. CORS отвечает только на источники WebView приложения
(`https://localhost`, `capacitor://localhost`, `http://localhost`).

| Метод и путь | Ответ |
|---|---|
| `POST /api/auth/key { key }` | вход по ключу `OWNER-…` → `CloudLoginResponse` (401 `INVALID_KEY`) |
| `GET /api/owner/keys` | `OwnerKeyView[]` — живые ключи владельца |
| `POST /api/owner/keys { label? }` | `CreateOwnerKeyResponse`: ключ (один раз) и текст QR `ts://login?cloud=…&key=…` |
| `DELETE /api/owner/keys/:id` | отозвать ключ |
| `POST /api/owner/devices { token, platform, name? }` | `DeviceView` — регистрация FCM-токена (повтор с тем же токеном обновляет запись) |
| `DELETE /api/owner/devices/:id` | убрать телефон (при выходе из приложения) |
| `GET /api/owner/push` | `PushSettingsView`: включены ли push на облаке, виды, правила, устройства |
| `PUT /api/owner/push/rules { rules }` | полный список правил → `PushSettingsView` |
| `POST /api/owner/push/test` | тестовый push на свои устройства → `TestPushResponse` |

Ключи владельца хранятся sha256-хэшем (`owner_keys`), как ключи HUB.

**Что пушится** (`src/push.ts`, типы — `packages/domain/src/push.ts`):
- тревоги HUB (`alert.raised`): свет без игры, игра без света, клуб на ИБП, батарея ИБП
  на исходе — включены по умолчанию; ИБП не отвечает, лампа не сработала, предоплаченная игра
  не началась, прочее — выключены по умолчанию;
- `HUB_OFFLINE` — HUB молчит дольше `CLOUD_HUB_OFFLINE_MINUTES` (один раз за эпизод; когда HUB
  снова на связи — push «HUB снова на связи», сторож перевзводится);
- `SHIFT_NOT_CLOSED` — кассовая смена открыта дольше `CLOUD_SHIFT_OPEN_HOURS` (один раз на смену).

**Кому:** всем владельцам компании клуба, у кого правило разрешает вид: правило для клуба
важнее правила «все клубы», то — важнее умолчания (`pushRuleAllows`).

**Как:** проекция и сторож (раз в минуту в `main.ts`) кладут уведомление в `push_queue` в той же
транзакции, что и событие; `dedupe_key` защищает от повторов при повторной доставке пачки.
После коммита `PushDispatcher.flush()` рассылает очередь через FCM HTTP v1: OAuth-токен
получается из ключа сервисного аккаунта (JWT RS256 через `node:crypto`, без SDK Google) и
кэшируется на час. Токен, о котором FCM отвечает `UNREGISTERED`/404, удаляет устройство.
Тревоги старше `CLOUD_PUSH_MAX_AGE_MINUTES` помечаются `STALE`. **Без ключа** — режим
«push выключены»: очередь помечается `DISABLED`, каждое уведомление пишется в лог, правила и
устройства сохраняются. Тесты (`test/push.test.ts`) гоняют настоящий `FcmSender` на фейковом
FCM с проверкой подписи JWT.

## Персональные данные и хостинг

В облаке хранятся персональные данные: почта и имена владельцев, имена сотрудников
(в журнале событий — кто открыл и остановил игру, в настройках — список персонала).
Закон Республики Казахстан «О персональных данных и их защите» требует хранить персональные
данные граждан РК на серверах, физически расположенных на территории Казахстана. Поэтому
облако TS и его базу данных нужно размещать у хостинг-провайдера с дата-центром в РК,
а не на зарубежных площадках; резервные копии — тоже внутри страны. Пароли хранятся только
в виде scrypt-хэшей, ключи HUB — в виде sha256-хэшей.
