/**
 * The first-boot wizard page (GET /setup): one self-contained HTML document — inline CSS and JS,
 * no build step, no external requests — readable on a phone. Free of Node built-ins (see routes/setup.ts).
 */
import type { HubSetupLampDriver, HubSetupStatus } from '@bills/domain';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const LAMP_DRIVER_LABELS: Record<HubSetupLampDriver, string> = {
  simulator: 'Без контроллера (проверка)',
  'esp32-http': 'ESP32 по Wi-Fi',
  'modbus-tcp': 'Modbus TCP',
};

const STYLE = `
:root{color-scheme:light dark;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;
--accent:#2563eb;--line:color-mix(in srgb,CanvasText 22%,Canvas);--muted:color-mix(in srgb,CanvasText 62%,Canvas);--err:#dc2626;--ok:#16a34a}
*{box-sizing:border-box}
body{max-width:560px;margin:0 auto;padding:24px 16px 48px;background:Canvas;color:CanvasText;font-size:17px}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 6px}h2{font-size:1.15rem;margin:28px 0 6px}
p{margin:8px 0}.muted{color:var(--muted);font-size:.95rem}
label{display:block;font-weight:600;margin:14px 0 6px}
input,textarea{width:100%;font:inherit;font-size:16px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:Canvas;color:CanvasText}
textarea{min-height:104px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;word-break:break-all}
input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
.invalid{border-color:var(--err);outline-color:var(--err)}
details{margin-top:14px;border:1px solid var(--line);border-radius:10px;padding:0 14px 12px}
summary{cursor:pointer;padding:12px 0 0;font-weight:600}
.choice{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);border-radius:12px;padding:14px;margin:10px 0 0;font-weight:400;cursor:pointer}
.choice input{width:22px;height:22px;margin:2px 0 0;flex:none;accent-color:var(--accent)}
.choice b{display:block}.choice .muted{display:block}
.choice:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.sub{padding:0 0 4px 14px;border-left:3px solid var(--line);margin:8px 0 0 10px}
.btn{display:block;width:100%;margin-top:24px;padding:16px;border:0;border-radius:12px;background:var(--accent);color:#fff;font:inherit;font-weight:700;font-size:18px;cursor:pointer;text-align:center;text-decoration:none}
.btn.alt{background:transparent;color:inherit;border:1px solid currentColor;margin-top:12px}
.btn:disabled{opacity:.6;cursor:wait}
.alert{border:1px solid var(--err);color:var(--err);border-radius:10px;padding:12px 14px;margin:20px 0 0}
.peek{font-size:.95rem;margin:6px 0 0;word-break:break-word}.peek.ok{color:var(--ok)}.peek.bad{color:var(--err)}
.note{border-left:4px solid var(--accent);padding:10px 12px;margin:14px 0;background:color-mix(in srgb,var(--accent) 9%,Canvas);border-radius:6px}
code{word-break:break-all}
[hidden]{display:none!important}
`;

function layout(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">${head}
<title>TS — ${esc(title)}</title>
<style>${STYLE}</style></head><body>
${body}
</body></html>`;
}

/** Shown to a request from outside the club LAN. */
export function setupBlockedPageHtml(message: string): string {
  return layout(
    'только из сети клуба',
    `<h1>Только из сети клуба</h1>
<p>${esc(message)}.</p>
<p class="muted">Это защита: подключить HUB к облаку можно только с телефона или компьютера, который стоит в том же Wi-Fi или подключён кабелем к тому же роутеру.</p>`,
  );
}

/** «Already set up», «restarting» or «demo» — no form. */
export function setupClosedPageHtml(st: HubSetupStatus): string {
  if (st.state === 'demo') {
    return layout('демо-HUB', `<h1>Демо-HUB</h1><p>Это демонстрационный HUB — мастер настройки в нём отключён.</p><a class="btn" href="/">Открыть TS</a>`);
  }
  if (st.state === 'off') {
    return layout(
      'мастер выключен',
      `<h1>Мастер настройки выключен</h1><p>На этом HUB мастер подключения к облаку выключен в настройках сервера (HUB_SETUP=off).</p><a class="btn" href="/">Открыть TS</a>
<p class="muted" style="margin-top:24px">Чтобы подключить HUB к облаку, обратитесь в поддержку TS.</p>`,
    );
  }
  if (st.state === 'saved') {
    return layout(
      'настройки сохранены',
      `<h1>Настройки сохранены</h1><p>HUB перезапускается и подключается к облаку — это займёт около минуты. Страница обновится сама.</p>`,
      '<meta http-equiv="refresh" content="10">',
    );
  }
  return layout(
    'HUB уже настроен',
    `<h1>HUB уже настроен</h1>
<p>Этот HUB подключён к облаку TS${st.hubId ? ` (HUB_ID: <code>${esc(st.hubId)}</code>)` : ''}. Мастер настройки закрыт.</p>
<a class="btn" href="/">Открыть TS</a>
<p class="muted" style="margin-top:24px">Нужно подключить HUB к другому филиалу или кабинет выдал новый ключ — обратитесь в поддержку TS.</p>
<p class="muted">Для установщика: подключение хранится в hub.env или в setup.json рядом с базой HUB. Удалите его и перезапустите HUB — мастер откроется снова.</p>`,
  );
}

/** Client side of the wizard. Kept as a raw string: no `${`, no backticks inside. */
const SCRIPT = String.raw`(function () {
  var S = JSON.parse(document.getElementById('setup-status').textContent);
  var $ = function (id) { return document.getElementById(id); };
  var form = $('f'), code = $('code'), peek = $('peek'), err = $('err'), go = $('go'), skip = $('skip');
  var GO_TEXT = go.textContent;

  // The cabinet's QR opens /setup#code=TS1.…: the fragment never reaches the server or its logs.
  var m = /[#&]code=([^&]*)/.exec(location.hash);
  if (m) {
    try { code.value = decodeURIComponent(m[1]); } catch (e) { code.value = m[1]; }
    // Keep the key out of the address bar and the browser history.
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (S.cloudUrlPreset) {
    $('cloud-row').hidden = true;
    var p = $('cloud-preset');
    p.hidden = false;
    p.textContent = 'Адрес облака уже задан в настройках сервера: ' + S.cloudUrlPreset;
  }

  // A preview only: the HUB checks the code again when it is sent.
  function decode(text) {
    var s = text.replace(/\s+/g, '');
    var l = /[#?&]code=([^&#]*)/i.exec(s);
    if (l) { s = l[1]; try { s = decodeURIComponent(s); } catch (e) {} }
    if (!s) return null;
    var dot = s.indexOf('.');
    var prefix = dot > 0 ? s.slice(0, dot) : '';
    if (/^ts\d+$/i.test(prefix) && !/^ts1$/i.test(prefix)) return { error: 'Код создан более новой версией TS — обновите HUB или введите HUB_ID и ключ вручную' };
    if (!/^ts1$/i.test(prefix)) return { error: 'Это не код подключения TS — он начинается с «TS1.»' };
    try {
      var b = s.slice(dot + 1).replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      var bin = atob(b), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var o = JSON.parse(new TextDecoder().decode(bytes));
      if (o && typeof o.h === 'string' && typeof o.k === 'string' && typeof o.u === 'string') return { hubId: o.h, host: new URL(o.u).host };
    } catch (e) {}
    return { error: 'Код повреждён или скопирован не полностью — скопируйте его из кабинета ещё раз' };
  }
  function showPeek() {
    var r = decode(code.value);
    peek.className = 'peek' + (r ? (r.error ? ' bad' : ' ok') : '');
    peek.textContent = r ? (r.error || ('Код распознан: HUB ' + r.hubId + ', облако ' + r.host)) : '';
  }
  code.addEventListener('input', showPeek);
  showPeek();

  function driver() {
    var c = document.querySelector('input[name=driver]:checked');
    return c ? c.value : null;
  }
  function syncDriver() {
    var d = driver();
    if ($('esp32-fields')) $('esp32-fields').hidden = d !== 'esp32-http';
    if ($('modbus-fields')) $('modbus-fields').hidden = d !== 'modbus-tcp';
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[name=driver]'), function (r) { r.addEventListener('change', syncDriver); });
  syncDriver();

  function body(skipCheck) {
    var b = {};
    var c = code.value.trim();
    if (c) b.code = c;
    else {
      b.hubId = $('hubId').value.trim();
      b.apiKey = $('apiKey').value.trim();
      var u = $('cloudUrl').value.trim();
      if (u) b.cloudUrl = u;
    }
    var d = driver();
    if (d) {
      b.lamps = { driver: d };
      if (d === 'esp32-http') {
        b.lamps.esp32Host = $('esp32Host').value.trim();
        var t = $('esp32Token').value.trim();
        if (t) b.lamps.esp32Token = t;
      }
      if (d === 'modbus-tcp') b.lamps.modbusHost = $('modbusHost').value.trim();
    }
    if (skipCheck) b.skipCheck = true;
    return b;
  }
  function clearError() {
    err.hidden = true;
    skip.hidden = true;
    Array.prototype.forEach.call(document.querySelectorAll('.invalid'), function (e) { e.classList.remove('invalid'); });
  }
  function showError(message, field, canSkip) {
    err.textContent = message;
    err.hidden = false;
    skip.hidden = !canSkip;
    var el = field ? $(field) : null;
    if (el) {
      if (field === 'hubId' || field === 'apiKey' || field === 'cloudUrl') $('manual').open = true;
      el.classList.add('invalid');
      el.focus();
    }
    err.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function send(skipCheck) {
    clearError();
    go.disabled = skip.disabled = true;
    go.textContent = skipCheck ? 'Сохраняем…' : 'Проверяем связь с облаком…';
    var restore = function () { go.disabled = skip.disabled = false; go.textContent = GO_TEXT; };
    fetch('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(skipCheck)) })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          restore();
          if (res.ok && data) return done(data);
          var e = (data && data.error) || {};
          if (e.code === 'SETUP_DONE' || e.code === 'SETUP_DISABLED') return location.reload();
          showError(e.message || ('HUB ответил ошибкой ' + res.status), e.field, e.canSkip);
        });
      }, function () {
        restore();
        showError('HUB не ответил. Проверьте, что телефон подключён к Wi-Fi клуба, и попробуйте ещё раз.');
      });
  }
  form.addEventListener('submit', function (ev) { ev.preventDefault(); send(false); });
  skip.addEventListener('click', function () { send(true); });

  // The HUB restarts to apply the settings: wait until it is back and connected.
  async function done(data) {
    $('form-view').hidden = true;
    $('done-view').hidden = false;
    window.scrollTo(0, 0);
    if (data.warning) { $('done-warn').hidden = false; $('done-warn').textContent = data.warning; }
    await sleep((data.restartInMs || 0) + 2000);
    var until = Date.now() + 120000;
    while (Date.now() < until) {
      try {
        var r = await fetch('/api/setup/status', { cache: 'no-store' });
        if (r.ok && (await r.json()).state === 'configured') {
          $('done-title').textContent = 'HUB подключён';
          $('done-text').textContent = 'HUB работает с облаком. Сотрудники, их ключи и лицензия придут из кабинета в течение минуты.';
          $('open-ts').hidden = false;
          return;
        }
      } catch (e) { /* restarting */ }
      await sleep(2000);
    }
    $('done-title').textContent = 'HUB долго не отвечает';
    $('done-text').textContent = 'Подождите пару минут и откройте адрес HUB ещё раз. Если не открывается — выключите и включите мини-ПК.';
    $('open-ts').hidden = false;
  }
})();`;

function lampChoice(driver: HubSetupLampDriver, hint: string, checked = false): string {
  return `<label class="choice"><input type="radio" name="driver" value="${driver}"${checked ? ' checked' : ''}><span><b>${esc(LAMP_DRIVER_LABELS[driver])}</b><span class="muted">${esc(hint)}</span></span></label>`;
}

const TEXT = 'autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"';

/** The wizard form, while the HUB is not connected to a cloud. */
export function setupPageHtml(st: HubSetupStatus): string {
  const lamps = st.lampsPreset
    ? `<p class="note">Контроллер ламп уже задан в настройках сервера (hub.env): <b>${esc(LAMP_DRIVER_LABELS[st.lampsPreset])}</b>. Здесь его выбирать не нужно.</p>`
    : `${lampChoice('simulator', 'Лампы не переключаются, всё остальное работает. Подходит, пока контроллер ещё не установлен.', true)}
${lampChoice('esp32-http', 'Плата реле в сети клуба (Wi-Fi или кабель).')}
<div class="sub" id="esp32-fields" hidden>
<label for="esp32Host">Адрес платы</label><input id="esp32Host" inputmode="url" placeholder="192.168.1.50" ${TEXT}>
<label for="esp32Token">Токен платы <span class="muted">(если задан в прошивке)</span></label><input id="esp32Token" ${TEXT}>
</div>
${lampChoice('modbus-tcp', 'Модуль реле с Modbus TCP по сети.')}
<div class="sub" id="modbus-fields" hidden>
<label for="modbusHost">Адрес модуля</label><input id="modbusHost" inputmode="url" placeholder="192.168.1.60 или 192.168.1.60:502" ${TEXT}>
</div>`;
  const status = JSON.stringify(st).replace(/</g, '\\u003c');
  return layout(
    'подключение HUB',
    `<main id="form-view">
<h1>Подключение HUB к облаку</h1>
<p class="muted">Этот мини-ПК — HUB клуба TS. Подключите его к кабинету: вставьте код подключения и выберите контроллер ламп. Это делается один раз.</p>
<form id="f" novalidate>
<h2>1. Код подключения</h2>
<label for="code">Код подключения</label>
<textarea id="code" name="code" placeholder="TS1.…" ${TEXT}></textarea>
<p id="peek" class="peek" aria-live="polite"></p>
<p class="muted">Код показан в кабинете управляющего, когда вы создаёте филиал (Филиалы → Новый филиал). Если вы открыли эту страницу по QR из кабинета — код уже вставлен.</p>
<details id="manual">
<summary>Нет кода — ввести HUB_ID и ключ вручную</summary>
<label for="hubId">HUB_ID</label><input id="hubId" placeholder="hub-…" ${TEXT}>
<label for="apiKey">Ключ HUB (CLOUD_API_KEY)</label><input id="apiKey" ${TEXT}>
<div id="cloud-row"><label for="cloudUrl">Адрес облака (CLOUD_URL)</label><input id="cloudUrl" type="url" inputmode="url" placeholder="https://…supabase.co/functions/v1" ${TEXT}></div>
<p id="cloud-preset" class="muted" hidden></p>
<p class="muted">Значения — в кабинете, там же, где код. Если заполнено поле «Код подключения», эти поля не нужны.</p>
</details>
<h2>2. Контроллер ламп</h2>
${lamps}
<div id="err" class="alert" role="alert" hidden></div>
<button id="skip" type="button" class="btn alt" hidden>Сохранить без проверки</button>
<button id="go" type="submit" class="btn">Проверить и подключить</button>
<p class="muted">Страница открывается только в сети клуба и закроется сама после настройки.</p>
</form>
</main>
<main id="done-view" hidden>
<h1 id="done-title">Настройки сохранены</h1>
<p id="done-text">HUB перезапускается и подключается к облаку — это займёт около минуты. Не закрывайте страницу.</p>
<p id="done-warn" class="note" hidden></p>
<a id="open-ts" class="btn" href="/" hidden>Открыть TS</a>
</main>
<script type="application/json" id="setup-status">${status}</script>
<script>${SCRIPT}</script>`,
  );
}
