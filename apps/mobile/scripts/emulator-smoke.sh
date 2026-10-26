#!/usr/bin/env bash
# Проверка APK на эмуляторе Android (вызывается из .github/workflows/mobile.yml, job emulator-smoke):
#   bash apps/mobile/scripts/emulator-smoke.sh <TS-x.y.z.apk> [папка для отчёта]
# Эмулятор уже запущен (adb видит одно устройство). Необязательные переменные окружения:
#   PREV_APK   — APK прошлого выпуска: сначала проверяется обновление поверх него;
#   SAME_CERT  — true, если у PREV_APK тот же сертификат подписи, что у нового APK;
#   IS_RELEASE — true для сборки по метке mobile-v*: откат версии тогда — ошибка, а не предупреждение.
# Шаги: (обновление поверх прошлого выпуска) → чистая установка → запуск → через 20 с процесс жив,
# нет FATAL EXCEPTION/ANR → в WebView виден стартовый экран кабинета («Начать бесплатно» или «Войти»).
# В папку отчёта кладутся screen.png, ui.xml, logcat.txt, errors.txt, install.txt.
set -uo pipefail
export LC_ALL=C.UTF-8

APK=${1:?укажите путь к APK}
OUT=${2:-emulator-report}
PKG=kz.ts.owner
ACTIVITY="$PKG/.MainActivity"
START_TEXT='Начать бесплатно|Войти'
mkdir -p "$OUT"
failed=0

fail() { echo "::error::$*"; failed=1; }
warn() { echo "::warning::$*"; }
summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$*" >> "$GITHUB_STEP_SUMMARY"; return 0; }

[ -f "$APK" ] || { echo "::error::Нет файла $APK"; exit 1; }
adb wait-for-device
adb shell getprop ro.build.version.release | tr -d '\r' | sed 's/^/Android на эмуляторе: /'
summary "### Эмулятор Android $(adb shell getprop ro.build.version.release | tr -d '\r') (API $(adb shell getprop ro.build.version.sdk | tr -d '\r'))"

# 1. Update over the previous release: what an owner with the old app installed will get.
if [ -n "${PREV_APK:-}" ] && [ -f "$PREV_APK" ]; then
  adb uninstall "$PKG" > /dev/null 2>&1 || true
  if adb install "$PREV_APK" > "$OUT/install-prev.txt" 2>&1; then
    if adb install -r "$APK" > "$OUT/install-update.txt" 2>&1; then
      echo "Обновление поверх прошлого выпуска: ставится"
      summary "- Обновление поверх прошлого выпуска: ставится без удаления"
    else
      reason=$(grep -o 'INSTALL_FAILED_[A-Z_]*' "$OUT/install-update.txt" | head -1)
      cat "$OUT/install-update.txt"
      case "$reason" in
        INSTALL_FAILED_UPDATE_INCOMPATIBLE)
          if [ "${SAME_CERT:-}" = true ]; then
            fail "Подпись та же, но обновление поверх прошлого выпуска не ставится ($reason)"
          else
            warn "Прошлый выпуск подписан другим ключом: поверх него этот APK не встанет, владельцу нужно один раз удалить приложение (docs/MOBILE_RELEASE_RU.md, 0.2)"
            summary "- Обновление поверх прошлого выпуска: **другой ключ подписи — нужна переустановка**"
          fi
          ;;
        INSTALL_FAILED_VERSION_DOWNGRADE)
          if [ "${IS_RELEASE:-}" = true ]; then
            fail "versionCode меньше, чем у прошлого выпуска: телефон откажется обновлять. Версия метки должна быть больше прошлой"
          else
            warn "У пробной сборки versionCode меньше, чем у прошлого выпуска: поверх него она не встанет (для пробной это нормально)"
          fi
          ;;
        *) fail "Обновление поверх прошлого выпуска не ставится: ${reason:-см. install-update.txt}" ;;
      esac
    fi
  else
    warn "Прошлый выпуск не установился на эмулятор, проверка обновления пропущена"
    cat "$OUT/install-prev.txt"
  fi
fi

# 2. Clean install, as on a new phone.
adb uninstall "$PKG" > /dev/null 2>&1 || true
if ! adb install -r "$APK" > "$OUT/install.txt" 2>&1 || ! grep -q Success "$OUT/install.txt"; then
  cat "$OUT/install.txt"
  echo "::error::APK не устанавливается: $(grep -o 'INSTALL_[A-Z_]*' "$OUT/install.txt" | head -1)"
  exit 1
fi
echo "Установка: Success"
adb shell dumpsys package "$PKG" | grep -E 'versionCode|versionName|targetSdk' | sed 's/^ */  /' | head -3

# 3. Launch. Unlock the screen and close a possible «System UI isn't responding» dialog of a fresh
# emulator first: either would cover the app in the screenshot and the UI dump.
adb shell input keyevent KEYCODE_WAKEUP > /dev/null 2>&1 || true
adb shell wm dismiss-keyguard > /dev/null 2>&1 || true
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS > /dev/null 2>&1 || true
adb logcat -c || true
adb shell am start -W -n "$ACTIVITY" | tee "$OUT/am-start.txt"
grep -q 'Status: ok' "$OUT/am-start.txt" || fail "am start не подтвердил запуск $ACTIVITY"
echo "Ждём 20 с…"
sleep 20

pid=$(adb shell pidof "$PKG" | tr -d '\r')
if [ -n "$pid" ]; then
  echo "Процесс жив, PID $pid"
else
  fail "Через 20 с после запуска процесса $PKG нет — приложение закрылось"
fi

# 4. The cabinet start screen inside the WebView. A release WebView has no devtools socket, so the
# accessibility tree is read with uiautomator; WebView fills it lazily, hence the retries.
found=""
for _ in $(seq 1 12); do
  adb shell rm -f /sdcard/ui.xml > /dev/null 2>&1
  if adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 && adb pull /sdcard/ui.xml "$OUT/ui.xml" > /dev/null 2>&1; then
    found=$(grep -oE "$START_TEXT" "$OUT/ui.xml" | head -1)
    [ -n "$found" ] && break
  fi
  sleep 5
done
adb exec-out screencap -p > "$OUT/screen.png" || warn "Снимок экрана не получился"
focus=$(adb shell dumpsys window | grep -m1 -E 'mCurrentFocus|mFocusedApp' | tr -d '\r')
echo "Окно в фокусе: $focus"
if [ -n "$found" ]; then
  echo "Стартовый экран кабинета: найдено «$found»"
  summary "- Стартовый экран кабинета: найдено «$found» (снимок — screen.png в артефактах)"
else
  fail "В WebView не видно стартового экрана кабинета («Начать бесплатно» / «Войти») — смотрите screen.png и ui.xml в артефактах"
  summary "- Стартовый экран кабинета: **не найден**"
fi

# 5. Logs: crashes of our process fail the job; errors are listed for a human.
adb logcat -d -v threadtime > "$OUT/logcat.txt" 2>&1 || true
grep -E 'AndroidRuntime|Capacitor|chromium|cr_' "$OUT/logcat.txt" | grep -E ' [EF] ' > "$OUT/errors.txt" || true
if [ -n "$pid" ]; then adb logcat -d -v threadtime --pid="$pid" '*:E' >> "$OUT/errors.txt" 2>/dev/null || true; fi
if grep -A4 'FATAL EXCEPTION' "$OUT/logcat.txt" | grep -q "Process: $PKG"; then
  grep -A30 'FATAL EXCEPTION' "$OUT/logcat.txt" | head -60
  fail "FATAL EXCEPTION в $PKG (logcat.txt в артефактах)"
fi
if grep -q "ANR in $PKG" "$OUT/logcat.txt"; then fail "ANR: $PKG не отвечает (logcat.txt в артефактах)"; fi
if [ -s "$OUT/errors.txt" ]; then
  echo "Ошибки в logcat ($(wc -l < "$OUT/errors.txt") строк, первые 40):"
  head -40 "$OUT/errors.txt"
else
  echo "Ошибок AndroidRuntime/Capacitor/chromium в logcat нет"
fi

if [ "$failed" -eq 0 ]; then
  summary "- Итог: **APK ставится и открывает кабинет**"
  echo "Проверка на эмуляторе пройдена"
else
  summary "- Итог: **есть ошибки** — см. журнал и артефакт emulator-report"
fi
exit "$failed"
