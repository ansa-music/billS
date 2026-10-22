# @bills/mobile — приложение владельца TS (Android, iPhone)

Фаза 3 из [docs/APP_PLAN_RU.md](../../docs/APP_PLAN_RU.md): кабинет владельца `apps/cloud-web`,
собранный внутрь приложения на [Capacitor 8](https://capacitorjs.com), плюс то, чего браузер
на телефоне не даёт: вход по QR, хранение входа на телефоне. Тревоги клуба приходят на телефон
через бесплатное приложение [ntfy](https://ntfy.sh) — без Firebase и без Google-аккаунта.

```
apps/mobile
├── src/main.tsx          нативная оболочка: NativeBridge для кабинета (Preferences, камера)
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
- **Уведомления — через ntfy** (подробно — ниже). Своего push-сервиса у приложения нет:
  Firebase (FCM) убран, потому что ему нужны Google-проект и сервисный ключ. Что и кому
  присылать — правила в кабинете; серверная часть — `apps/cloud/src/push.ts`.
- **Release** ходит в облако только по HTTPS; debug разрешает `http://` (тестовое облако в
  локальной сети) — `android/app/src/debug/res/xml/network_security_config.xml`.

## Сборка под Supabase: уведомления через ntfy

Если при сборке заданы `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY` (переменные окружения или
`apps/mobile/.env`), приложение работает с Supabase, как кабинет на сайте:

- **вход** — по почте и паролю (Supabase Auth); адрес облака и ключи владельца не нужны;
- **push — через [ntfy](https://ntfy.sh)**: в WebView нет Web Push, поэтому на странице
  «Телефон и уведомления» кнопка «Получать уведомления через ntfy» создаёт секретную тему
  `https://ntfy.sh/ts-…` (или на своём сервере ntfy), регистрирует её как устройство `ntfy` и
  показывает кнопку «Подписаться в ntfy» (ссылка `ntfy://…` открывает приложение ntfy; если его
  нет, `android/app/src/main/java/kz/ts/owner/NtfyLinksPlugin.java` открывает страницу ntfy в
  магазине приложений).
  Владелец ставит бесплатное приложение ntfy (F-Droid — без Google, Google Play или App Store)
  и подписывается на тему. Уведомления приходят и при закрытом TS; нажатие открывает клуб в
  кабинете.

```bash
VITE_SUPABASE_URL=https://<ref>.supabase.co VITE_SUPABASE_ANON_KEY=<anon key> npm run build:android-debug -w @bills/mobile
```

Без `VITE_SUPABASE_*` собирается вариант для своего облака (адрес вводится в приложении). Своё
облако пока не принимает устройства ntfy, поэтому в этом варианте уведомлений на телефон нет —
тревоги видны в кабинете. Устройства `android`/`ios` из времён FCM остаются в списке с пометкой
«подключён по старой схеме», на них ничего не отправляется.

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

**Готовый APK без своего компьютера** собирает GitHub Actions (`.github/workflows/mobile.yml`):
метка `mobile-v1.2.3` → выпуск «TS для Android 1.2.3» с файлом `TS-1.2.3.apk`, ручной запуск →
пробный APK в артефактах. Как выпустить и как настроить ключ подписи — в
[docs/MOBILE_RELEASE_RU.md](../../docs/MOBILE_RELEASE_RU.md).

Release локально: `npm run build:android-apk -w @bills/mobile` (APK) или
`npm run build:android-release -w @bills/mobile` (`.aab` для Google Play). Ключ подписи —
переменные `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD` или `android/keystore.properties`; без них release подписывается
отладочным ключом. Версия — `TS_VERSION_NAME` / `TS_VERSION_CODE`, иначе из `package.json`
(versionCode = мажор·10000 + минор·100 + патч).

## iOS

Проект `ios/` создан (`cap add ios`, Swift Package Manager), настроены `Info.plist` (камера),
иконка и заставка. Push-возможности не нужны: уведомления приходят через приложение ntfy из
App Store. Собрать можно только на Mac с Xcode: `npx cap sync ios`, открыть
`ios/App/App.xcodeproj`. Подробно — в чек-листе публикации.

## Разработка

- `npm run dev -w @bills/mobile` — оболочка в браузере (порт 5190); нативные плагины там
  работают в веб-режиме, удобно только для вёрстки. Кабинет целиком удобнее смотреть через
  `npm run dev:cloud-web`.
- После правок кабинета или оболочки: `npm run sync -w @bills/mobile` (vite build + cap sync).
- Иконки: `npm run icons -w @bills/mobile`.

## Что ещё не сделано

- Вход по отпечатку / Face ID и хранение токена в Keystore/Keychain (сейчас — Preferences).
- Нажатие на уведомление ntfy открывает клуб в браузере, а не в приложении TS (для этого нужны
  App Links: файл `assetlinks.json` на сайте кабинета и intent-filter в манифесте).
- Своё облако (apps/cloud) пока не принимает устройства `ntfy`/`webpush`.
- Виджет «сегодня» на экране телефона.
