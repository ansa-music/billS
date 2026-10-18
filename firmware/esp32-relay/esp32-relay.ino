/*
 * esp32-relay — контроллер ламп над бильярдными столами для billS.
 *
 * 8 реле + 8 датчиков тока, управление по HTTP (JSON) с локального HUB.
 * Платформа: ESP32 DevKit, Arduino-ESP32 core 3.x, ArduinoJson 7.
 *
 * ГЛАВНОЕ ПРАВИЛО: контроллер НИКОГДА не выключает реле сам.
 *   - пропала связь с HUB         → реле держат последнее состояние;
 *   - пропала сеть / Wi-Fi        → реле держат последнее состояние;
 *   - перезагрузка (питание, WDT) → состояние восстанавливается из NVS;
 *   - таймаутов «на всякий случай» нет и не должно быть.
 * Единственный способ сменить состояние реле — HTTP-команда от HUB.
 * Идёт игра, люди с киями — свет гаснет только по команде «Стоп».
 *
 * Все операции в loop() неблокирующие (конечные автоматы на millis()),
 * delay() в рабочем цикле не используется.
 *
 * HTTP API (порт 80, все ответы application/json):
 *   GET  /                      — страница для проверки с телефона (HTML)
 *   GET  /status                — состояние контроллера и всех каналов
 *   POST /relay/<ch>            — {"on":true|false} установить реле ch (1..8)
 *   POST /relay/<ch>/blink      — {"times":3,"onMs":400,"offMs":400} мигнуть
 *   Авторизация (если задан API_TOKEN): Authorization: Bearer <token>
 */

#include <Arduino.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <math.h>

#include "config.h"

#ifdef USE_ETHERNET
  #include <ETH.h>
#else
  #include <WiFi.h>
#endif

static_assert(sizeof(RELAY_PINS) / sizeof(RELAY_PINS[0]) == RELAY_COUNT, "RELAY_PINS: нужно RELAY_COUNT пинов");
static_assert(sizeof(CURRENT_PINS) / sizeof(CURRENT_PINS[0]) == RELAY_COUNT, "CURRENT_PINS: нужно RELAY_COUNT пинов");
static_assert(CURRENT_OFF_THRESHOLD_MA <= CURRENT_ON_THRESHOLD_MA, "порог выключения не выше порога включения");

// ============================================================================
// Состояние
// ============================================================================

// Логическое состояние реле — то, что задал HUB и что лежит в NVS.
static bool relayState[RELAY_COUNT];
// Физическое состояние выхода. Отличается от relayState только во время мигания.
static bool relayPhysical[RELAY_COUNT];

// Мигание — неблокирующий конечный автомат на канал.
struct BlinkJob {
  bool     active;
  uint8_t  stepsLeft;   // сколько переключений осталось
  uint32_t nextAt;      // millis(), когда переключать следующий раз
  uint16_t onMs;
  uint16_t offMs;
};
static BlinkJob blink[RELAY_COUNT];

// Измерение тока — накопители одного окна и последний результат.
struct CurrentChannel {
  uint32_t n;        // число выборок в окне
  int64_t  sum;      // сумма мВ
  uint64_t sumSq;    // сумма квадратов мВ
  int32_t  ma;       // последний RMS, мА; -1 — ещё нет данных / датчика нет
  bool     on;       // ток есть (с гистерезисом)
  uint16_t noiseMa;  // собственный шум канала, вычитается из показаний
};
static CurrentChannel current[RELAY_COUNT];
static uint32_t currentWindowStart = 0;

static Preferences prefs;          // NVS, пространство "relay"
static WebServer   server(HTTP_PORT);

#ifndef USE_ETHERNET
static uint32_t wifiLastAttempt = 0;
#endif

// Прототипы (Arduino IDE генерирует их сама, но явные надёжнее: функции со
// структурами в параметрах должны объявляться ПОСЛЕ определения структур).
static uint32_t blinkPhaseMs(const BlinkJob& job, bool lampOn);
static double currentRawMa(const CurrentChannel& c);
static void relayWritePin(int ch, bool on);
static void relaySet(int ch, bool on);
static void relayRestoreFromNvs();
static void blinkStart(int ch, int times, int onMs, int offMs);
static void blinkCancel(int ch);
static void blinkTick(uint32_t now);
static void currentSetup();
static void currentSampleAll();
static void currentFinishWindow();
static void currentTick(uint32_t now);
static void currentCalibrateNoise();
static bool netUp();
static String netIp();
static void netSetup();
static void netTick(uint32_t now);
static void ledTick(uint32_t now);
static void wdtSetup();
static bool authorized();
static void sendJson(int code, JsonDocument& doc);
static void sendError(int code, const char* message);
static void fillCurrent(JsonObject obj, int ch);
static void handleRoot();
static void handleStatus();
static void handleNotFound();
static void handleRelaySet(int ch);
static void handleRelayBlink(int ch);

// ============================================================================
// Реле
// ============================================================================

// Пишет физический уровень на пин с учётом RELAY_ACTIVE_LOW.
static void relayWritePin(int ch, bool on) {
  const bool activeLow = (RELAY_ACTIVE_LOW != 0);
  digitalWrite(RELAY_PINS[ch], (on != activeLow) ? HIGH : LOW);
  relayPhysical[ch] = on;
}

// Устанавливает логическое состояние реле по команде HUB: отменяет мигание,
// пишет на пин, сохраняет в NVS (только если состояние изменилось — NVS имеет
// ограниченный ресурс записи, а повтор команды должен быть идемпотентным).
static void relaySet(int ch, bool on) {
  blinkCancel(ch);
  const bool changed = (relayState[ch] != on);
  relayState[ch] = on;
  relayWritePin(ch, on);
  if (changed) {
    char key[4] = { 's', (char)('1' + ch), 0, 0 };
    prefs.putBool(key, on);
    Serial.printf("[relay] ch%d -> %s (сохранено)\n", ch + 1, on ? "ON" : "OFF");
  }
}

// Восстановление после подачи питания: читаем NVS и сразу выставляем выходы.
// Лампы над столами, где шла игра, загораются снова через доли секунды.
static void relayRestoreFromNvs() {
  for (int ch = 0; ch < RELAY_COUNT; ch++) {
    char key[4] = { 's', (char)('1' + ch), 0, 0 };
    relayState[ch] = prefs.getBool(key, false);
    pinMode(RELAY_PINS[ch], OUTPUT);
    relayWritePin(ch, relayState[ch]);
    blink[ch].active = false;
  }
  Serial.print("[relay] восстановлено из NVS:");
  for (int ch = 0; ch < RELAY_COUNT; ch++) Serial.printf(" %d", relayState[ch] ? 1 : 0);
  Serial.println();
}

// ============================================================================
// Мигание
// ============================================================================

// Длительность фазы: лампа горит onMs, не горит offMs.
static uint32_t blinkPhaseMs(const BlinkJob& job, bool lampOn) {
  return lampOn ? job.onMs : job.offMs;
}

// Запускает мигание. Базовое состояние — relayState (НЕ физическое: повторный
// blink во время мигания не должен «запомнить» промежуточную фазу). После
// times циклов реле возвращается в relayState. NVS не трогаем.
static void blinkStart(int ch, int times, int onMs, int offMs) {
  BlinkJob& job = blink[ch];
  job.active = true;
  job.onMs = (uint16_t)onMs;
  job.offMs = (uint16_t)offMs;
  job.stepsLeft = (uint8_t)(times * 2 - 1);  // первое переключение делаем сразу
  const bool base = relayState[ch];
  relayWritePin(ch, !base);
  job.nextAt = millis() + blinkPhaseMs(job, !base);
}

// Отменяет мигание и возвращает реле в логическое состояние.
static void blinkCancel(int ch) {
  if (!blink[ch].active) return;
  blink[ch].active = false;
  relayWritePin(ch, relayState[ch]);
}

static void blinkTick(uint32_t now) {
  for (int ch = 0; ch < RELAY_COUNT; ch++) {
    BlinkJob& job = blink[ch];
    if (!job.active) continue;
    if ((int32_t)(now - job.nextAt) < 0) continue;  // ещё не время (устойчиво к переполнению millis)
    const bool next = !relayPhysical[ch];
    relayWritePin(ch, next);
    if (job.stepsLeft > 0) job.stepsLeft--;
    if (job.stepsLeft == 0 && next == relayState[ch]) {
      job.active = false;  // вернулись в исходное состояние — готово
    } else {
      job.nextAt = now + blinkPhaseMs(job, next);
    }
  }
}

// ============================================================================
// Датчики тока
// ============================================================================
//
// Переменный ток измеряется как RMS по окну CURRENT_WINDOW_MS. Постоянное
// смещение датчика (≈2,5 В у ACS712, ≈1,65 В у модулей SCT-013) вычитается
// как среднее по этому же окну: RMS = sqrt(E[x²] − E[x]²). Поэтому дрейф
// смещения не влияет на результат. Собственный шум канала (noiseMa) измеряется
// при включении, пока реле выключено, и вычитается квадратурно.
//
// Выборки берутся по одной с каждого канала за проход loop() — без задержек.
// При типичной длительности прохода ~1 мс получается ~1 кГц на канал,
// то есть ~20 точек на период 50 Гц и ~100 точек в окне.

static void currentSetup() {
  analogReadResolution(12);
  for (int ch = 0; ch < RELAY_COUNT; ch++) {
    current[ch].n = 0;
    current[ch].sum = 0;
    current[ch].sumSq = 0;
    current[ch].ma = -1;
    current[ch].on = false;
    current[ch].noiseMa = CURRENT_NOISE_FLOOR_MA;
    if (CURRENT_PINS[ch] >= 0) {
      pinMode(CURRENT_PINS[ch], INPUT);
      analogSetPinAttenuation(CURRENT_PINS[ch], ADC_11db);  // диапазон до ~3,1 В
    }
  }
  currentWindowStart = millis();
}

static void currentSampleAll() {
  for (int ch = 0; ch < RELAY_COUNT; ch++) {
    if (CURRENT_PINS[ch] < 0) continue;
    const uint32_t mv = analogReadMilliVolts(CURRENT_PINS[ch]);
    CurrentChannel& c = current[ch];
    c.n++;
    c.sum += (int64_t)mv;
    c.sumSq += (uint64_t)mv * (uint64_t)mv;
  }
}

// RMS переменной составляющей в мА по накопителям канала, без вычитания шума.
static double currentRawMa(const CurrentChannel& c) {
  if (c.n < 8) return -1.0;
  const double mean = (double)c.sum / (double)c.n;
  double var = (double)c.sumSq / (double)c.n - mean * mean;
  if (var < 0) var = 0;
  const double rmsMv = sqrt(var);
  return rmsMv * 1000.0 / (double)CURRENT_SENSOR_MV_PER_A;
}

static void currentFinishWindow() {
  for (int ch = 0; ch < RELAY_COUNT; ch++) {
    CurrentChannel& c = current[ch];
    if (CURRENT_PINS[ch] < 0) continue;
    const double raw = currentRawMa(c);
    c.n = 0;
    c.sum = 0;
    c.sumSq = 0;
    if (raw < 0) continue;  // мало выборок (например, долгий HTTP-запрос) — оставляем прошлое значение
    const double noise = (double)c.noiseMa;
    const double ma = (raw > noise) ? sqrt(raw * raw - noise * noise) : 0.0;
    c.ma = (int32_t)lround(ma);
    if (c.ma >= CURRENT_ON_THRESHOLD_MA) c.on = true;
    else if (c.ma < CURRENT_OFF_THRESHOLD_MA) c.on = false;
  }
}

static void currentTick(uint32_t now) {
  currentSampleAll();
  if (now - currentWindowStart >= CURRENT_WINDOW_MS) {
    currentFinishWindow();
    currentWindowStart = now;
  }
}

// Калибровка шума при включении (выполняется один раз в setup(), ~300 мс).
// Для каналов с выключенным реле измеряем RMS «пустой» линии и запоминаем в
// NVS. Для каналов, где реле уже включено (игра шла до пропадания питания),
// берём сохранённое ранее значение.
static void currentCalibrateNoise() {
#if CURRENT_AUTO_ZERO
  const uint32_t start = millis();
  while (millis() - start < 300) {
    currentSampleAll();
    delayMicroseconds(200);
  }
  for (int ch = 0; ch < RELAY_COUNT; ch++) {
    CurrentChannel& c = current[ch];
    if (CURRENT_PINS[ch] < 0) continue;
    char key[4] = { 'n', (char)('1' + ch), 0, 0 };
    if (!relayState[ch]) {
      const double raw = currentRawMa(c);
      if (raw >= 0) {
        uint16_t noise = (uint16_t)lround(raw);
        if (noise > 2000) noise = 2000;  // явно не шум — датчик не подключён или помеха
        c.noiseMa = noise;
        const uint16_t stored = prefs.getUShort(key, 0xFFFF);
        if (stored == 0xFFFF || abs((int)stored - (int)noise) > 5) prefs.putUShort(key, noise);
      }
    } else {
      c.noiseMa = prefs.getUShort(key, CURRENT_NOISE_FLOOR_MA);
    }
    c.n = 0;
    c.sum = 0;
    c.sumSq = 0;
  }
  Serial.print("[current] шум каналов, мА:");
  for (int ch = 0; ch < RELAY_COUNT; ch++) {
    if (CURRENT_PINS[ch] < 0) Serial.print(" -");
    else Serial.printf(" %u", (unsigned)current[ch].noiseMa);
  }
  Serial.println();
#endif
  currentWindowStart = millis();
}

// ============================================================================
// Сеть
// ============================================================================
//
// Потеря сети НИКАК не влияет на реле. Здесь только переподключение.

static bool netUp() {
#ifdef USE_ETHERNET
  return ETH.linkUp() && (uint32_t)ETH.localIP() != 0;
#else
  return WiFi.status() == WL_CONNECTED;
#endif
}

static String netIp() {
#ifdef USE_ETHERNET
  return ETH.localIP().toString();
#else
  return WiFi.localIP().toString();
#endif
}

static void netSetup() {
#ifdef USE_ETHERNET
  // Ethernet через W5500 по SPI (Arduino-ESP32 core 3.x).
  // Сигнатуру ETH.begin проверь по документации вашей версии core:
  //   ETH.begin(type, phy_addr, cs, irq, rst, spi_host, sck, miso, mosi)
  // Если статический IP не применился — перенеси ETH.config() после ETH.begin().
  ETH.setHostname(DEVICE_ID);
  #if !NET_USE_DHCP
  ETH.config(IPAddress(NET_IP), IPAddress(NET_GATEWAY), IPAddress(NET_SUBNET), IPAddress(NET_DNS));
  #endif
  const bool ok = ETH.begin(ETH_PHY_W5500, ETH_PHY_ADDR, ETH_SPI_CS, ETH_SPI_IRQ, ETH_SPI_RST,
                            ETH_SPI_HOST, ETH_SPI_SCK, ETH_SPI_MISO, ETH_SPI_MOSI);
  Serial.printf("[net] Ethernet W5500: %s\n", ok ? "старт" : "ОШИБКА инициализации");
#else
  WiFi.persistent(false);          // не писать SSID/пароль во флеш при каждом begin()
  WiFi.setHostname(DEVICE_ID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);            // без энергосбережения: быстрые ответы HUB
  WiFi.setAutoReconnect(true);
  #if !NET_USE_DHCP
  WiFi.config(IPAddress(NET_IP), IPAddress(NET_GATEWAY), IPAddress(NET_SUBNET), IPAddress(NET_DNS));
  #endif
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiLastAttempt = millis();
  Serial.printf("[net] Wi-Fi: подключение к \"%s\"\n", WIFI_SSID);
#endif
}

static void netTick(uint32_t now) {
#ifdef USE_ETHERNET
  (void)now;  // W5500 переподключается драйвером сам (link up/down)
#else
  static bool wasUp = false;
  const bool up = netUp();
  if (up != wasUp) {
    wasUp = up;
    if (up) Serial.printf("[net] Wi-Fi подключён, IP %s\n", netIp().c_str());
    else Serial.println("[net] Wi-Fi потерян — реле не трогаем, переподключаемся");
  }
  if (!up && now - wifiLastAttempt >= WIFI_RECONNECT_MS) {
    wifiLastAttempt = now;
    WiFi.reconnect();  // неблокирующий запуск повторного подключения
  }
#endif
}

// Светодиод: горит — сеть есть, мигает — сети нет.
static void ledTick(uint32_t now) {
#if STATUS_LED_PIN >= 0
  static uint32_t lastToggle = 0;
  static bool blinkPhase = false;
  bool want;
  if (netUp()) {
    want = true;
  } else {
    if (now - lastToggle >= 300) {
      lastToggle = now;
      blinkPhase = !blinkPhase;
    }
    want = blinkPhase;
  }
  const bool activeLow = (STATUS_LED_ACTIVE_LOW != 0);
  digitalWrite(STATUS_LED_PIN, (want != activeLow) ? HIGH : LOW);
#else
  (void)now;
#endif
}

// ============================================================================
// Сторожевой таймер
// ============================================================================
//
// Только для перезагрузки при зависании программы. НЕ выключает реле: после
// перезагрузки состояние восстанавливается из NVS (см. relayRestoreFromNvs).

static void wdtSetup() {
#if WDT_TIMEOUT_S > 0
  esp_task_wdt_config_t cfg = {};
  cfg.timeout_ms = (uint32_t)WDT_TIMEOUT_S * 1000U;
  cfg.idle_core_mask = 0;      // следим только за задачей loop()
  cfg.trigger_panic = true;    // при срабатывании — перезагрузка
  if (esp_task_wdt_init(&cfg) != ESP_OK) {
    esp_task_wdt_reconfigure(&cfg);  // ядро Arduino уже включило TWDT — перенастраиваем
  }
  esp_task_wdt_add(NULL);
  Serial.printf("[wdt] таймаут %d с\n", WDT_TIMEOUT_S);
#endif
}

static inline void wdtFeed() {
#if WDT_TIMEOUT_S > 0
  esp_task_wdt_reset();
#endif
}

// ============================================================================
// HTTP
// ============================================================================

static bool authorized() {
  if (API_TOKEN[0] == '\0') return true;
  const String header = server.header("Authorization");
  if (header.startsWith("Bearer ") && header.substring(7) == API_TOKEN) return true;
  if (server.hasArg("token") && server.arg("token") == API_TOKEN) return true;
  return false;
}

static void sendJson(int code, JsonDocument& doc) {
  String out;
  serializeJson(doc, out);
  server.send(code, "application/json", out);
}

static void sendError(int code, const char* message) {
  JsonDocument doc;
  doc["ok"] = false;
  doc["error"] = message;
  if (code == 401) server.sendHeader("WWW-Authenticate", "Bearer");
  sendJson(code, doc);
}

// Поля currentOn / currentMa канала; null, если датчика нет или данных ещё нет.
static void fillCurrent(JsonObject obj, int ch) {
  if (CURRENT_PINS[ch] < 0 || current[ch].ma < 0) {
    obj["currentOn"] = nullptr;
    obj["currentMa"] = nullptr;
  } else {
    obj["currentOn"] = current[ch].on;
    obj["currentMa"] = current[ch].ma;
  }
}

// GET /status
static void handleStatus() {
  if (!authorized()) { sendError(401, "unauthorized"); return; }
  JsonDocument doc;
  doc["ok"] = true;
  doc["id"] = DEVICE_ID;
  doc["fw"] = FW_VERSION;
  doc["uptimeMs"] = (uint64_t)(esp_timer_get_time() / 1000);
  doc["ip"] = netIp();
  JsonArray relays = doc["relays"].to<JsonArray>();
  for (int ch = 0; ch < RELAY_COUNT; ch++) {
    JsonObject o = relays.add<JsonObject>();
    o["ch"] = ch + 1;
    o["on"] = relayState[ch];
    fillCurrent(o, ch);
  }
  sendJson(200, doc);
}

// GET / — страница для электрика: проверить с телефона, что контроллер жив.
static void handleRoot() {
  if (!authorized()) { sendError(401, "unauthorized"); return; }
  const uint64_t upS = (uint64_t)(esp_timer_get_time() / 1000000);
  String html;
  html.reserve(1400);
  html += F("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width'>"
            "<meta http-equiv='refresh' content='2'><title>");
  html += DEVICE_ID;
  html += F("</title><style>body{font-family:sans-serif;margin:16px}td,th{padding:4px 10px;text-align:left}"
            ".on{color:#0a0;font-weight:bold}.off{color:#888}</style></head><body><h2>");
  html += DEVICE_ID;
  html += F("</h2><p>fw ");
  html += FW_VERSION;
  html += F(" &middot; ip ");
  html += netIp();
  html += F(" &middot; uptime ");
  html += String((unsigned long)(upS / 3600));
  html += F(" ч ");
  html += String((unsigned long)((upS / 60) % 60));
  html += F(" мин</p><table><tr><th>Реле</th><th>Состояние</th><th>Ток, мА</th></tr>");
  for (int ch = 0; ch < RELAY_COUNT; ch++) {
    html += F("<tr><td>");
    html += String(ch + 1);
    html += relayState[ch] ? F("</td><td class='on'>ВКЛ") : F("</td><td class='off'>выкл");
    if (blink[ch].active) html += F(" (мигает)");
    html += F("</td><td>");
    if (CURRENT_PINS[ch] < 0) html += F("нет датчика");
    else if (current[ch].ma < 0) html += F("&hellip;");
    else {
      html += String(current[ch].ma);
      html += current[ch].on ? F(" &#9679;") : F("");
    }
    html += F("</td></tr>");
  }
  html += F("</table><p><small>Реле меняются только по команде HUB.</small></p></body></html>");
  server.send(200, "text/html; charset=utf-8", html);
}

// POST /relay/<ch>  {"on":true}
static void handleRelaySet(int ch) {
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err || !doc["on"].is<bool>()) {
    sendError(400, "expected body {\"on\":true|false}");
    return;
  }
  const bool on = doc["on"].as<bool>();
  relaySet(ch, on);  // идемпотентно: повтор той же команды ничего не меняет

  JsonDocument res;
  res["ok"] = true;
  res["ch"] = ch + 1;
  res["state"] = relayPhysical[ch];
  if (CURRENT_PINS[ch] < 0 || current[ch].ma < 0) res["currentOn"] = nullptr;
  else res["currentOn"] = current[ch].on;  // показание обновится через ~CURRENT_WINDOW_MS
  sendJson(200, res);
}

// POST /relay/<ch>/blink  {"times":3,"onMs":400,"offMs":400} — все поля необязательны
static void handleRelayBlink(int ch) {
  int times = BLINK_DEFAULT_TIMES;
  int onMs = BLINK_DEFAULT_ON_MS;
  int offMs = BLINK_DEFAULT_OFF_MS;

  const String body = server.arg("plain");
  if (body.length() > 0) {
    JsonDocument doc;
    const DeserializationError err = deserializeJson(doc, body);
    if (err || !doc.is<JsonObject>()) { sendError(400, "invalid json"); return; }
    if (!doc["times"].isNull()) {
      if (!doc["times"].is<int>()) { sendError(400, "times must be integer"); return; }
      times = doc["times"].as<int>();
    }
    if (!doc["onMs"].isNull()) {
      if (!doc["onMs"].is<int>()) { sendError(400, "onMs must be integer"); return; }
      onMs = doc["onMs"].as<int>();
    }
    if (!doc["offMs"].isNull()) {
      if (!doc["offMs"].is<int>()) { sendError(400, "offMs must be integer"); return; }
      offMs = doc["offMs"].as<int>();
    }
  }
  times = constrain(times, BLINK_MIN_TIMES, BLINK_MAX_TIMES);
  onMs = constrain(onMs, BLINK_MIN_MS, BLINK_MAX_MS);
  offMs = constrain(offMs, BLINK_MIN_MS, BLINK_MAX_MS);

  blinkStart(ch, times, onMs, offMs);

  JsonDocument res;
  res["ok"] = true;
  res["ch"] = ch + 1;
  res["state"] = relayState[ch];  // состояние, в которое реле вернётся после мигания
  sendJson(200, res);
}

// Разбор путей с номером канала: /relay/<ch> и /relay/<ch>/blink.
static void handleNotFound() {
  if (!authorized()) { sendError(401, "unauthorized"); return; }

  String uri = server.uri();
  while (uri.length() > 1 && uri.endsWith("/")) uri.remove(uri.length() - 1);

  if (!uri.startsWith("/relay/")) { sendError(404, "not found"); return; }

  const String rest = uri.substring(7);
  const int slash = rest.indexOf('/');
  const String chStr = (slash < 0) ? rest : rest.substring(0, slash);
  const String tail = (slash < 0) ? String() : rest.substring(slash + 1);

  bool digits = chStr.length() > 0 && chStr.length() <= 2;
  for (unsigned i = 0; digits && i < chStr.length(); i++) digits = isDigit(chStr[i]);
  const int chNum = digits ? chStr.toInt() : 0;
  if (chNum < 1 || chNum > RELAY_COUNT) { sendError(404, "unknown channel"); return; }
  const int ch = chNum - 1;

  if (tail.length() == 0) {
    if (server.method() != HTTP_POST) { sendError(405, "method not allowed"); return; }
    handleRelaySet(ch);
  } else if (tail == "blink") {
    if (server.method() != HTTP_POST) { sendError(405, "method not allowed"); return; }
    handleRelayBlink(ch);
  } else {
    sendError(404, "not found");
  }
}

// ============================================================================
// setup / loop
// ============================================================================

void setup() {
  Serial.begin(115200);
  Serial.printf("\n%s fw %s\n", DEVICE_ID, FW_VERSION);

  // 1. Сначала реле — восстановить свет над столами, где шла игра.
  prefs.begin("relay", false);
  relayRestoreFromNvs();

  // 2. Светодиод статуса.
#if STATUS_LED_PIN >= 0
  pinMode(STATUS_LED_PIN, OUTPUT);
#endif

  // 3. Датчики тока и калибровка шума (реле уже в нужном состоянии).
  currentSetup();
  currentCalibrateNoise();

  // 4. Сеть (неблокирующий старт, подключение завершится в loop()).
  netSetup();

  // 5. HTTP-сервер. WebServer хранит только заголовки из collectHeaders().
  static const char* headerKeys[] = { "Authorization" };
  server.collectHeaders(headerKeys, 1);
  server.on("/", HTTP_GET, handleRoot);
  server.on("/status", HTTP_GET, handleStatus);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.printf("[http] порт %d, токен %s\n", HTTP_PORT, API_TOKEN[0] ? "включён" : "НЕ задан");

  // 6. Сторожевой таймер — последним, когда всё инициализировано.
  wdtSetup();
}

void loop() {
  const uint32_t now = millis();
  wdtFeed();
  netTick(now);
  ledTick(now);
  server.handleClient();
  blinkTick(now);
  currentTick(now);
}
