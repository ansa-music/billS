/**
 * The admin API contract against a running `wrangler dev` (or a deployed Worker), the way the TS platform uses it:
 *
 *   node scripts/admin-check.mjs [base] <trial snapshot (base64 file)> <a staff key from that trial>
 *
 * - a move with an Idempotency-Key, sent twice (the first answer «lost»): one café, the same code;
 * - every staff key of the trial signs in there (six digits and long MGR-… keys);
 * - terms: permanent, then ended (read-only, TS's words), then active again;
 * - «Выдать новый код директора»: the new key works, the old one and its sessions stop;
 * - «Скачать копию» for TS (GET …/export): the browser trial's backup file;
 * - admin refuses browsers and wrong tokens; café API refuses unknown codes.
 *
 * base defaults to http://127.0.0.1:8790; the admin token to ADMIN_TOKEN or `local-admin`.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const base = /^https?:\/\//.test(args[0] ?? '') ? args.shift().replace(/\/+$/, '') : 'http://127.0.0.1:8790';
const [file, staffKey, longKey] = args;
const ADMIN = process.env.ADMIN_TOKEN ?? 'local-admin';
if (!file || !staffKey) {
  console.error('usage: node scripts/admin-check.mjs [base] <snapshot.b64> <staff key> [long key]');
  process.exit(2);
}

let failed = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

async function admin(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A file or nothing.
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(code, key) {
  const res = await fetch(`${base}/c/${code}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ts-device': 'admin-check-device' },
    body: JSON.stringify({ key, device: 'admin-check' }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function untilReady(answer) {
  let a = answer;
  for (let i = 0; i < 200 && a.json?.status === 'importing'; i++) a = await admin('POST', `/admin/cafes/${a.json.code}/import/continue`, {});
  return a;
}

const snapshot = readFileSync(file, 'utf8').trim();
const idem = `ts-trial-check-${Date.now()}`;

// 1. The move, twice with the same Idempotency-Key.
const first = await admin('POST', '/admin/cafes/import?steps=2', { snapshot }, { 'idempotency-key': idem });
check(first.status === 202 || first.status === 201, `import answers ${first.status} with a code (${first.json?.code})`);
const again = await admin('POST', '/admin/cafes/import', { snapshot }, { 'idempotency-key': idem });
check(again.json?.code === first.json?.code, `the same Idempotency-Key gives the same café (${again.status})`);
const done = await untilReady(again);
check(done.json?.status === 'ready', `the café is ready (${done.json?.rows} rows in ${done.json?.steps} steps)`);
const code = first.json.code;

// 2. Every staff key of the trial works there.
check((await login(code, staffKey)).status === 200, 'the trial’s six-digit key signs in');
if (longKey) check((await login(code, longKey)).status === 200, 'the trial’s long key signs in');

// 3. Terms.
let t = await admin('PUT', `/admin/cafes/${code}/terms`, { status: 'permanent', endsAt: null });
check(t.json?.license?.state === 'active' && t.json.license.readOnly === false, 'permanent: works, no end');
t = await admin('PUT', `/admin/cafes/${code}/terms`, { status: 'ended', endsAt: null, message: 'Пробный период закончился. Напишите TS.' });
check(t.json?.license?.readOnly === true && /Напишите TS/.test(t.json.license.message), 'ended: read-only with TS’s words');
const hello = await (await fetch(`${base}/c/${code}/api/cloud`)).json();
check(hello.readOnly === true, 'the screens see read-only');
t = await admin('PUT', `/admin/cafes/${code}/terms`, { status: 'active', endsAt: Date.now() + 30 * 86_400_000 });
check(t.json?.license?.readOnly === false && t.json.license.daysLeft === 30, 'active again: 30 days');
check((await admin('PUT', `/admin/cafes/${code}/terms`, { status: 'active', endsAt: null })).status === 400, 'active without endsAt is refused');

// 4. A new director key.
const session = await login(code, staffKey);
const dk = await admin('POST', `/admin/cafes/${code}/director-key`, {});
check(/^\d{6}$/.test(dk.json?.managerKey ?? ''), `director-key answers a new key for ${dk.json?.managerName}`);
check((await login(code, dk.json.managerKey)).status === 200, 'the new director key signs in');
const old = await login(code, staffKey);
check(old.status === 401 || old.status === 429, `the old director key stops (${old.status})`);
const me = await fetch(`${base}/c/${code}/api/auth/me`, { headers: { authorization: `Bearer ${session.json?.token}` } });
check(me.status === 401, `a session opened with the old key is closed (${me.status})`);

// 5. «Скачать копию» for TS.
let ex = await admin('GET', `/admin/cafes/${code}/export`);
for (let i = 0; i < 50 && ex.status === 202; i++) ex = await admin('GET', `/admin/cafes/${code}/export`);
check(ex.status === 200 && ex.json?.format === 'ts-trial-backup' && Buffer.from(ex.json.db, 'base64').subarray(0, 15).toString() === 'SQLite format 3', `export: the trial backup file (${ex.text.length} B, ${ex.headers.get('content-disposition')})`);

// 6. Guards.
check((await admin('GET', `/admin/cafes/${code}`, undefined, { 'sec-fetch-site': 'same-origin' })).status === 403, 'admin refuses a browser');
check((await fetch(`${base}/admin/cafes/${code}`, { headers: { authorization: 'Bearer wrong' } })).status === 401, 'admin refuses a wrong token');
check((await fetch(`${base}/c/ABCDEFGHJKMN/api/cloud`)).status === 404, 'an unknown café is 404');
check((await fetch(`${base}/c/${code}/api/state`, { method: 'POST', body: 'x'.repeat(300 * 1024) })).status === 413, 'a body over 256 KB is 413');

console.log(failed ? `\n${failed} check(s) failed` : `\nall checks passed (café ${code})`);
process.exitCode = failed ? 1 : 0;
