# Установка интерфейса как приложения (PWA) — план и статус

Цель: сотрудник открывает адрес HUB в браузере планшета (Android / iPad) или ПК кассира (Windows), нажимает «Установить» — и дальше работает с иконки на весь экран, без магазинов приложений и без отдельной сборки под каждую платформу. Телефон не приоритет (работает, но не проверяется отдельно).

Как это устроено: HUB (`apps/hub`) раздаёт собранный интерфейс `apps/web/dist` через `@fastify/static` (`apps/hub/src/http/static.ts`). PWA — это тот же интерфейс плюс манифест, иконки и service worker, которые собираются вместе с ним (`npm run build`). Никакого отдельного сервера или сборки не нужно.

Статус по этапам ниже; в README — раздел «Установка на планшет и ПК (PWA)» для персонала.

---

## Этап A. Манифест и иконки — ✅ готово

- [x] `apps/web/public/manifest.webmanifest`: `name` / `short_name` «Billiard Control», `start_url` `/#/`, `display: standalone`, `lang: ru`, цвета темы и фона из токенов интерфейса (`--bg` тёмной темы), ярлыки (shortcuts) «Зал», «Счета», «Сводка».
- [x] Иконки из SVG «шар 8»: `icons/icon-192.png`, `icons/icon-512.png` (`purpose: any maskable`, рисунок в безопасной зоне), `icons/apple-touch-icon.png` (180), `icons/icon.svg`. Генерирует `scripts/icons.mjs` (`npm run icons`) чистым JS без зависимостей и без сети — PNG пишется вручную через `node:zlib`; результат закоммичен, сборка его не пересоздаёт.
- [x] Теги в `apps/web/index.html`: `<link rel="manifest">`, `apple-touch-icon`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `theme-color`, viewport без масштабирования (`viewport-fit=cover`).

## Этап B. Service worker и обновления — ✅ готово

- [x] `vite-plugin-pwa` в `apps/web/vite.config.ts`: прекэш сборки (`index.html`, `assets/*`, манифест, иконки), SPA-фолбэк на `index.html` для всего, кроме `/api/*`.
- [x] `/api/*` — `NetworkOnly`: ничего из API не кэшируется, в том числе `/api/events` (SSE) и `/api/dev/*`. Интерфейс без связи с HUB показывает свою плашку «Нет связи с HUB», как и раньше; данные из кэша не подменяются.
- [x] `clientsClaim: true`, `skipWaiting: false`: первый воркер берёт под контроль страницу, которая его зарегистрировала (иначе следующая сборка активируется молча и баннеру нечего переключать); каждая следующая — ждёт нажатия. Раз в час воркер сам спрашивает HUB о новой сборке (планшет открыт сутками).
- [x] `registerType: 'prompt'`: новая версия ставится в ожидание, оболочка показывает баннер «Доступна новая версия — обновить»; обновление только по нажатию (`skipWaiting` + перезагрузка). Принудительных обновлений нет — официант не потеряет открытое окно оплаты.
- [x] В dev-режиме (`npm run dev:web`) service worker не регистрируется — Vite проксирует `/api` сам.

## Этап C. Сеть: адрес HUB, заголовки, HTTPS — ✅ частично

- [x] HUB отдаёт `manifest.webmanifest` как `application/manifest+json`; `sw.js`, `workbox-*.js`, `index.html` и всё вне `assets/` — с `Cache-Control: no-cache` (браузер проверяет версию при каждом запуске); `assets/*` — год, `immutable`. Тест `apps/hub/test/static.test.ts`.
- [x] Вариант «`hub.local` + HTTP» описан в README: iPad ставит приложение по HTTP без ограничений; Chrome на Android и Windows считает `http://<ip>` небезопасным и без флага `chrome://flags/#unsafely-treat-insecure-origin-as-secure` не регистрирует service worker и не предлагает установку — флаг включается один раз на каждом устройстве.
- [ ] HTTPS с локальным центром сертификации (mkcert или свой CA, сертификат на `hub.local` и IP, корневой сертификат ставится на планшеты) — тогда установка в Chrome работает без флагов, а на iPad появляется Wake Lock. Отдельный шаг, когда понадобится.
- [ ] mDNS-имя `hub.local` на мини-ПК клуба (avahi в `deploy/linux`), чтобы адрес не зависел от IP.

## Этап D. Оболочка в режиме приложения — ✅ готово

- [x] В standalone-режиме (`display-mode: standalone` или `navigator.standalone` на iPad) кнопка «На весь экран» не показывается — окно и так без адресной строки.
- [x] Viewport без масштабирования, `overscroll-behavior: none` (нет «резинки» и pull-to-refresh на планшете), `touch-action: manipulation` (нет задержки двойного тапа).
- [x] Баннер «Установите приложение» по событию `beforeinstallprompt` (Chrome/Edge): показывается, пока приложение не установлено; «Позже» запоминается на устройстве (`localStorage`, `bills.pwa.install`), и баннер больше не возвращается.
- [x] Подсказка для iPad / iPhone в Safari (нет `beforeinstallprompt`): «Поделиться → На экран „Домой“», определяется по userAgent и `navigator.standalone`; тоже закрывается один раз.
- [x] Название устройства при входе по ключу (`bills.device`) хранится в `localStorage` — у установленного приложения своё хранилище, поэтому после установки ключ вводится заново один раз, а имя планшета подставляется из прошлого входа в том же окне.

## Этап E. Проверка и документация — ✅ готово

- [x] Конфигурация `pwa-check` в `.claude/launch.json`: HUB раздаёт собранный `dist` на своём порту и базе.
- [x] Ручная проверка в браузере (встроенный браузер, `http://localhost:4800/`): манифест отдаётся с нужным типом, `navigator.serviceWorker.getRegistrations()` возвращает одну активную регистрацию со scope `/`, страница контролируется воркером с первой загрузки, консоль без ошибок, `/api/events` (SSE) и `/api/state` проходят через воркер как обычные запросы. Баннер установки (по синтетическому `beforeinstallprompt`): [img/pwa-install-banner.jpg](img/pwa-install-banner.jpg), «Позже» запоминается. Обновление: правка `sw.js` → воркер в ожидании → баннер → «Обновить» → перезагрузка, вход сохранён.
- [x] `npm run audit:pwa` — Lighthouse через `npx @lhci/cli` без добавления тяжёлых зависимостей в репозиторий (нужен установленный Chrome). Отдельной категории «PWA» в Lighthouse 12+ нет: установимость проверяют в DevTools → Application → Manifest; ручной прогон описан в README.
- [x] README: раздел «Установка на планшет и ПК (PWA)».
