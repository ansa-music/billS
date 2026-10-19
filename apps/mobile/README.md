# @bills/mobile — приложение владельца TS (Android, iPhone)

Фаза 3 из [docs/APP_PLAN_RU.md](../../docs/APP_PLAN_RU.md): кабинет владельца `apps/cloud-web`,
собранный внутрь приложения на [Capacitor 8](https://capacitorjs.com), плюс то, чего браузер
на телефоне не даёт: push о тревогах клуба, вход по QR, хранение входа на телефоне.

```
apps/mobile
├── src/main.tsx          нативная оболочка: NativeBridge для кабинета (Preferences, камера, FCM)
├── index.html            точка входа vite → www/
├── capacitor.config.ts   appId kz.ts.owner, имя «TS», CapacitorHttp, заставка
├── scripts/android.mjs   сборка: vite build → cap sync android → gradle
├── scripts/icons.mjs     иконки и заставка «TS» (без зависимостей)
├── android/              проект Android Studio (в git; build/ и local.properties — нет)
└── ios/                  проект Xcode (SPM), собирается только на Mac
```

Кабинет не знает про Capacitor: всё нативное — за интерфейсом `NativeBridge`
(`apps/cloud-web/src/platform.ts`), который `src/main.tsx` регистрирует до первого рендера.

## Как работает

- **Адрес облака** вводится на экране входа (или приходит в QR) и хранится на телефоне.
  Запросы идут через нативный HTTP (`CapacitorHttp`) на этот адрес с
  `Authorization: Bearer <токен>` и `x-ts-app: 1` — без cookie и без CORS.
- **Вход:** почта и пароль или ключ владельца `OWNER-…`. Ключ создаётся в кабинете
  (страница «Телефон и уведомления» → «Создать ключ для телефона») и показывается QR вида
  `ts://login?cloud=<адрес>&key=<ключ>`; кнопка «Сканировать QR» на телефоне заполняет и адрес,
  и ключ. Токен сессии (30 дней) хранится в `@capacitor/preferences` — в песочнице приложения,
  резервное копирование Android выключено (`allowBackup=false`).
- **Push:** после входа приложение просит разрешение на уведомления, получает FCM-токен
  (`@capacitor-firebase/messaging`, Android и iOS) и регистрирует его в облаке
  (`POST /api/owner/devices`); при выходе устройство удаляется. Канал Android — `alerts`
  («Тревоги клуба», высокая важность). Тап по уведомлению открывает клуб (`#/clubs/<id>`).
  Что и кому присылать — правила в кабинете; серверная часть — `apps/cloud/README.md`.
- **Release** ходит в облако только по HTTPS; debug разрешает `http://` (тестовое облако в
  локальной сети) — `android/app/src/debug/res/xml/network_security_config.xml`.

## Сборка Android (debug APK)

Нужны Node 24, JDK 21 и Android SDK (platform 36, build-tools 36). На Windows:

```bash
winget install --id Microsoft.OpenJDK.21 -e --source winget
```

Android SDK без Android Studio: распаковать
[command-line tools](https://developer.android.com/studio#command-line-tools-only) в
`%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest` и поставить пакеты
`platform-tools`, `platforms;android-36`, `build-tools;36.0.0` через `sdkmanager`.

```bash
npm run build:android-debug -w @bills/mobile
```

Скрипт сам находит JDK 21 и SDK (или берёт `JAVA_HOME` / `ANDROID_HOME`), собирает кабинет в
`www/`, делает `cap sync android` и `gradlew assembleDebug`. Результат:
`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` — ставится на телефон с
включённой «установкой из неизвестных источников» или `adb install -r app-debug.apk`.

**Push в сборке появятся только с `android/app/google-services.json`** (из консоли Firebase,
не в git). Без него приложение работает, а на странице «Телефон и уведомления» пишет, что
push недоступны в этой сборке. На облаке нужен ключ сервисного аккаунта того же проекта
Firebase (`CLOUD_FCM_SERVICE_ACCOUNT`).

Release (`.aab` для Google Play): `npm run build:android-release -w @bills/mobile` с
`android/keystore.properties` — см. [docs/MOBILE_RELEASE_RU.md](../../docs/MOBILE_RELEASE_RU.md).

## iOS

Проект `ios/` создан (`cap add ios`, Swift Package Manager), настроены `AppDelegate`
(передача APNs-токена плагину), `Info.plist` (камера, фоновые push), иконка и заставка.
Собрать можно только на Mac с Xcode: `npx cap sync ios`, открыть `ios/App/App.xcodeproj`,
добавить `GoogleService-Info.plist`, включить Push Notifications в Signing & Capabilities.
Подробно — в чек-листе публикации.

## Разработка

- `npm run dev -w @bills/mobile` — оболочка в браузере (порт 5190); нативные плагины там
  работают в веб-режиме, удобно только для вёрстки. Кабинет целиком удобнее смотреть через
  `npm run dev:cloud-web`.
- После правок кабинета или оболочки: `npm run sync -w @bills/mobile` (vite build + cap sync).
- Иконки: `npm run icons -w @bills/mobile`.

## Что ещё не сделано

- Вход по отпечатку / Face ID и хранение токена в Keystore/Keychain (сейчас — Preferences).
- Показ push, пришедшего при открытом приложении (Android не показывает его сам; кабинет
  и так обновляет данные каждые несколько секунд).
- Виджет «сегодня» на экране телефона.
