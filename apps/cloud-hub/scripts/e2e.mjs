/**
 * End-to-end check of the cloud HUB against a running `wrangler dev` (or a deployed Worker):
 *
 *   node scripts/e2e.mjs [base] new                → a new café; two devices sign in (director at the till, a
 *                                                    barista with her own key); the till takes a paid counter
 *                                                    order; the barista's WebSocket hears it; the order is on
 *                                                    the barista's list. Prints timings and Cloudflare cost.
 *   node scripts/e2e.mjs [base] check <code> <key> → after a restart: sign in again, the orders are still there.
 *   node scripts/e2e.mjs [base] import <file>      → a trial café moves in (base64 SQLite file), sign in with a
 *                                                    key from the trial, read its menu and orders.
 *   node scripts/e2e.mjs [base] load <code> <key> [n] → n paid orders in a row: cost per order.
 *
 * base defaults to http://127.0.0.1:8790; the admin token to ADMIN_TOKEN or `local-admin`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const base = /^https?:\/\//.test(args[0] ?? '') ? args.shift().replace(/\/+$/, '') : 'http://127.0.0.1:8790';
const mode = args.shift() ?? 'new';
const ADMIN = process.env.ADMIN_TOKEN ?? 'local-admin';

const costs = [];

async function call(method, path, { token, body, admin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers.authorization = `Bearer ${ADMIN}`;
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
  const t0 = performance.now();
  const res = await fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const ms = performance.now() - t0;
  const text = await res.text();
  const cost = res.headers.get('x-ts-cost');
  if (cost) costs.push({ method, path: path.replace(/^\/c\/[^/]+/, ''), ms: Math.round(ms), cost, bytes: text.length });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const api = (code) => (method, path, opts) => call(method, `/c/${code}${path}`, opts);

function openEvents(code, name) {
  const url = `${base.replace(/^http/, 'ws')}/c/${code}/api/events`;
  const ws = new WebSocket(url);
  const heard = [];
  const waiters = [];
  ws.addEventListener('message', (m) => {
    if (m.data === 'pong') return;
    const msg = JSON.parse(m.data);
    const at = performance.now();
    heard.push({ at, msg });
    for (const w of waiters.splice(0)) w({ at, msg });
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error(`${name}: WebSocket failed ${e.message ?? ''}`)));
  });
  return {
    ws,
    opened,
    next: (pred, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${name}: no event in ${timeoutMs} ms`)), timeoutMs);
        const check = (ev) => {
          if (pred(ev.msg)) {
            clearTimeout(t);
            resolve(ev);
          } else waiters.push(check);
        };
        waiters.push(check);
      }),
    ping: () =>
      new Promise((resolve) => {
        const t0 = performance.now();
        ws.addEventListener('message', function on(m) {
          if (m.data === 'pong') {
            ws.removeEventListener('message', on);
            resolve(performance.now() - t0);
          }
        });
        ws.send('ping');
      }),
  };
}

function pickLine(catalog, i = 0) {
  // Drinks without a stock count never run out, however many orders a load run takes.
  const free = catalog.products.filter((p) => p.isActive && p.stock === null);
  const product = free.length ? free[i % free.length] : catalog.products.find((p) => p.isActive && p.stock > 0);
  if (!product) throw new Error('no product in the menu');
  const options = [];
  let price = product.price;
  for (const g of product.options) {
    if (!g.required || !g.choices.length) continue;
    options.push(g.choices[0].id);
    price += g.choices[0].priceDelta;
  }
  return { line: { productId: product.id, qty: 1, ...(options.length ? { options } : {}) }, price, name: product.name };
}

async function login(code, key, device) {
  const res = await call('POST', `/c/${code}/api/auth/login`, { body: { key, device } });
  return res.token;
}

async function ensureShift(c, token) {
  const state = await c('GET', '/api/state', { token });
  if (state.shift?.id) return state.shift.id;
  const shift = await c('POST', '/api/shifts/open', { token, body: { openingFloat: 0 } });
  return shift.id;
}

async function takeOrder(c, token, catalog, guestName, i = 0) {
  const { line, price } = pickLine(catalog, i);
  return c('POST', '/api/counter/orders', {
    token,
    body: { items: [line], service: 'TAKEAWAY', guestName, payment: { parts: [{ method: 'CASH', amount: price }] } },
  });
}

function printCosts(title) {
  console.log(`\n${title}`);
  for (const c of costs.splice(0)) console.log(`  ${c.method.padEnd(4)} ${c.path.padEnd(28)} ${String(c.ms).padStart(4)} ms  ${c.cost}  ${c.bytes} B`);
}

async function modeNew() {
  const cafe = await call('POST', '/admin/cafes', { admin: true, body: { venue: 'Кофейня «Облако»', managerName: 'Айгерим', withMenu: true } });
  console.log(`café ${cafe.codeShown} (${cafe.code}), director key ${cafe.managerKey}`);
  const c = api(cafe.code);

  // Device A — the till, signed in as the director.
  const tokenA = await login(cafe.code, cafe.managerKey, 'Касса (ПК)');
  const staff = await c('POST', '/api/staff', { token: tokenA, body: { name: 'Дана', roles: ['bartender'] } });
  const issued = await c('POST', `/api/staff/${staff.id}/keys`, { token: tokenA, body: {} });
  // Device B — the barista's tablet, her own key.
  const tokenB = await login(cafe.code, issued.key, 'Планшет бариста');
  const me = await c('GET', '/api/auth/me', { token: tokenB });
  console.log(`device B signed in as ${me.staff.name} (${me.staff.roles.join(',')}), barista key ${issued.key}`);
  printCosts('setup');

  const barista = openEvents(cafe.code, 'barista');
  const till = openEvents(cafe.code, 'till');
  await Promise.all([barista.opened, till.opened]);
  const pingMs = await barista.ping();
  console.log(`\nboth devices on WebSocket; ping→pong (auto-response) ${pingMs.toFixed(0)} ms`);

  const catalog = await c('GET', '/api/bar/catalog', { token: tokenA });
  await ensureShift(c, tokenA);
  const before = await c('GET', '/api/counter/orders', { token: tokenB });
  printCosts('till: menu, shift, barista list before');

  const heard = barista.next((m) => m.t === 'changed' && m.e.kind === 'counter');
  const t0 = performance.now();
  const order = await takeOrder(c, tokenA, catalog, 'Аня');
  const tReply = performance.now();
  const ev = await heard;
  const list = await c('GET', '/api/counter/orders', { token: tokenB });
  const tList = performance.now();
  const found = (list.orders ?? list).find?.((o) => o.id === order.id || o.order?.id === order.id) ?? null;
  printCosts('order taken on the till, seen by the barista');
  console.log(`\norder №${order.number ?? order.order?.number ?? '?'} total ${order.total ?? order.order?.total ?? '?'}:`);
  console.log(`  till got its answer after          ${(tReply - t0).toFixed(0)} ms`);
  console.log(`  barista WebSocket heard 'counter'   ${(ev.at - t0).toFixed(0)} ms after the till sent it`);
  console.log(`  barista list has it                 ${(tList - t0).toFixed(0)} ms after (${found ? 'found' : 'NOT FOUND'}; before: ${countOrders(before)}, now: ${countOrders(list)})`);
  barista.ws.close();
  till.ws.close();

  const stats = await call('GET', `/admin/cafes/${cafe.code}`, { admin: true });
  console.log('\ncafé stats', JSON.stringify(stats));
  writeFileSync(new URL('../.e2e-cafe.json', import.meta.url), JSON.stringify({ code: cafe.code, managerKey: cafe.managerKey, baristaKey: issued.key, orderId: order.id ?? order.order?.id }, null, 2));
  if (!found) process.exitCode = 1;
}

function countOrders(list) {
  return (list.orders ?? list).length ?? '?';
}

async function modeCheck(code, key) {
  const c = api(code);
  const token = await login(code, key, 'После перезапуска');
  const list = await c('GET', '/api/counter/orders', { token });
  const state = await c('GET', '/api/state', { token });
  printCosts('after restart');
  console.log(`\ncafé «${state.club?.name}»: ${countOrders(list)} counter orders on the list, shift ${state.shift ? 'open' : 'closed'}`);
  for (const o of (list.orders ?? list).slice(0, 5)) console.log(`  №${o.number} ${o.stage} ${o.guestName ?? ''} ${o.total}`);
  const stats = await call('GET', `/admin/cafes/${code}`, { admin: true });
  console.log('café stats', JSON.stringify(stats));
}

async function modeImport(file, key) {
  const text = readFileSync(file, 'utf8').trim();
  const snapshot = text.startsWith('U1FMaXRl') ? text : readFileSync(file).toString('base64');
  const t0 = performance.now();
  const res = await call('POST', '/admin/cafes/import', { admin: true, body: { snapshot, newManagerKey: !key } });
  console.log(`imported in ${(performance.now() - t0).toFixed(0)} ms: ${JSON.stringify(res)}`);
  const signKey = key ?? res.managerKey;
  const c = api(res.code);
  const token = await login(res.code, signKey, 'Перенос из пробной');
  const catalog = await c('GET', '/api/bar/catalog', { token });
  const list = await c('GET', '/api/counter/orders', { token });
  const staff = await c('GET', '/api/staff', { token });
  printCosts('imported café');
  console.log(`\nmenu: ${catalog.products.length} products (${catalog.products.slice(0, 4).map((p) => p.name).join(', ')}…)`);
  console.log(`orders on the counter list: ${countOrders(list)}`);
  for (const o of (list.orders ?? list).slice(0, 5)) console.log(`  №${o.number} ${o.stage} ${o.guestName ?? ''} ${o.total}`);
  console.log(`staff: ${staff.staff.map((s) => s.name).join(', ')}`);
  writeFileSync(new URL('../.e2e-import.json', import.meta.url), JSON.stringify({ code: res.code, key: signKey }, null, 2));
}

async function modeLoad(code, key, n) {
  const c = api(code);
  const token = await login(code, key, 'Нагрузка');
  const catalog = await c('GET', '/api/bar/catalog', { token });
  await ensureShift(c, token);
  costs.splice(0);
  for (let i = 0; i < n; i++) {
    const order = await takeOrder(c, token, catalog, `Гость ${i + 1}`, i);
    const id = order.id ?? order.order?.id;
    await c('GET', '/api/state', { token });
    await c('GET', '/api/counter/orders', { token });
    for (const stage of ['PREPARING', 'READY', 'ISSUED']) await c('POST', `/api/counter/orders/${id}/stage`, { token, body: { stage } });
  }
  const sum = {};
  for (const x of costs) {
    const key2 = `${x.method} ${x.path.replace(/[0-9a-f-]{36}/, ':id')}`;
    const m = /rr=(\d+);rw=(\d+);st=(\d+)/.exec(x.cost);
    const s = (sum[key2] ??= { n: 0, rr: 0, rw: 0, st: 0, ms: 0 });
    s.n++;
    s.rr += Number(m[1]);
    s.rw += Number(m[2]);
    s.st += Number(m[3]);
    s.ms += x.ms;
  }
  console.log(`\n${n} orders (take + state + list + 3 stages each), average per call:`);
  for (const [k, s] of Object.entries(sum)) console.log(`  ${k.padEnd(40)} rows read ${(s.rr / s.n).toFixed(0).padStart(5)}  written ${(s.rw / s.n).toFixed(1).padStart(5)}  statements ${(s.st / s.n).toFixed(0).padStart(4)}  ${(s.ms / s.n).toFixed(0)} ms`);
  costs.splice(0);
  const stats = await call('GET', `/admin/cafes/${code}`, { admin: true });
  console.log('café stats', JSON.stringify(stats));
}

try {
  if (mode === 'new') await modeNew();
  else if (mode === 'check') await modeCheck(args[0], args[1]);
  else if (mode === 'import') await modeImport(args[0], args[1]);
  else if (mode === 'load') await modeLoad(args[0], args[1], Number(args[2] ?? 20));
  else throw new Error(`unknown mode ${mode}`);
} catch (err) {
  console.error('E2E FAILED:', err.message);
  process.exitCode = 1;
}
