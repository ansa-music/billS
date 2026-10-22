import assert from 'node:assert/strict';
import test from 'node:test';
import {
  b64urlEncode,
  encodeHubSetupCode,
  HUB_SETUP_CODE_MESSAGES,
  hubCloudUrl,
  hubSetupUrl,
  isLocalOnlyCloudUrl,
  parseHubSetupCode,
  hubApiKeyProblem,
  hubIdProblem,
} from '../src/index.ts';

const KEY = 'q2V9sJ0xY7c3pV8tM1rB6nK4wZ5aL0dH9fG2jE7uR3i'; // 43 chars, like generateHubKey()
const SUPABASE = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1';

const sample = { hubId: 'hub-ts-na-abaya-x7k2', apiKey: KEY, cloudUrl: SUPABASE };

function raw(json: unknown, prefix = 'TS1.'): string {
  return prefix + b64urlEncode(new TextEncoder().encode(JSON.stringify(json)));
}

test('connection code: round trip, versioned prefix, URL-safe and short enough for a QR', () => {
  const code = encodeHubSetupCode(sample);
  assert.match(code, /^TS1\.[A-Za-z0-9_-]+$/);
  assert.ok(code.length < 220, `code is ${code.length} chars`);
  assert.deepEqual(parseHubSetupCode(code), { ok: true, value: sample });
  // The cloud address is normalised on the way in: no trailing slash.
  const slash = encodeHubSetupCode({ ...sample, cloudUrl: `${SUPABASE}/` });
  assert.deepEqual(parseHubSetupCode(slash), { ok: true, value: sample });
});

test('connection code: surrounding whitespace, line breaks, a full setup link, lower-case prefix', () => {
  const code = encodeHubSetupCode(sample);
  const ok = { ok: true, value: sample };
  assert.deepEqual(parseHubSetupCode(`  ${code}\n`), ok);
  assert.deepEqual(parseHubSetupCode(`${code.slice(0, 40)}\n  ${code.slice(40)}`), ok);
  assert.deepEqual(parseHubSetupCode(hubSetupUrl(code)), ok);
  assert.deepEqual(parseHubSetupCode(`http://192.168.1.20:4310/setup?code=${code}`), ok);
  assert.deepEqual(parseHubSetupCode(`http://hub.local:4310/setup#code=${encodeURIComponent(code)}`), ok);
  assert.deepEqual(parseHubSetupCode(`ts1.${code.slice(4)}`), ok);
});

test('connection code: garbage is rejected with a clear Russian message', () => {
  const problem = (text: string) => {
    const r = parseHubSetupCode(text);
    assert.equal(r.ok, false, text);
    return r.ok ? null : r;
  };
  assert.equal(problem('')!.problem, 'empty');
  assert.equal(problem('   \n')!.problem, 'empty');
  assert.equal(problem('hello world')!.problem, 'not_a_code');
  assert.equal(problem('HUB_ID=hub-1\nCLOUD_API_KEY=abc')!.problem, 'not_a_code');
  assert.equal(problem('https://example.com/setup')!.problem, 'not_a_code');
  assert.equal(problem('TS2.eyJ9')!.problem, 'newer_version');
  // Cut short, a typo that breaks base64/JSON, valid JSON without the fields, bad field values.
  const code = encodeHubSetupCode(sample);
  assert.equal(problem(code.slice(0, 30))!.problem, 'damaged');
  assert.equal(problem('TS1.@@@')!.problem, 'damaged');
  assert.equal(problem('TS1.')!.problem, 'damaged');
  assert.equal(problem(raw({ h: 'hub-1', k: KEY }))!.problem, 'damaged');
  assert.equal(problem(raw({ h: 'hub 1', k: KEY, u: SUPABASE }))!.problem, 'damaged');
  assert.equal(problem(raw({ h: 'hub-1', k: 'short', u: SUPABASE }))!.problem, 'damaged');
  assert.equal(problem(raw({ h: 'hub-1', k: KEY, u: 'ftp://x' }))!.problem, 'damaged');
  assert.equal(problem(raw([1, 2]))!.problem, 'damaged');
  // Invalid UTF-8 inside is damage, not a silently mangled id.
  assert.equal(problem(`TS1.${b64urlEncode(new Uint8Array([0xff, 0xfe, 0x7b]))}`)!.problem, 'damaged');
  for (const message of Object.values(HUB_SETUP_CODE_MESSAGES)) assert.match(message, /[а-я]/);
  assert.equal(problem('nonsense')!.message, HUB_SETUP_CODE_MESSAGES.not_a_code);
});

test('connection code: extra fields from a later v1 are ignored', () => {
  assert.deepEqual(parseHubSetupCode(raw({ h: 'hub-1', k: KEY, u: 'http://192.168.1.10:4320', n: 'Клуб на Абая' })), {
    ok: true,
    value: { hubId: 'hub-1', apiKey: KEY, cloudUrl: 'http://192.168.1.10:4320' },
  });
});

test('connection code: the cabinet cannot encode broken values', () => {
  assert.throws(() => encodeHubSetupCode({ ...sample, hubId: '' }));
  assert.throws(() => encodeHubSetupCode({ ...sample, apiKey: 'with space inside' }));
  assert.throws(() => encodeHubSetupCode({ ...sample, cloudUrl: 'ftp://cloud' }));
});

test('HUB_ID and key checks for manual entry', () => {
  assert.equal(hubIdProblem('hub-demo-1'), null);
  assert.equal(hubIdProblem(`hub-${'0'.repeat(36)}`), null);
  assert.match(hubIdProblem('')!, /HUB_ID/);
  assert.match(hubIdProblem('hub demo')!, /HUB_ID/);
  assert.equal(hubApiKeyProblem(KEY), null);
  assert.equal(hubApiKeyProblem('demo-hub-key-1'), null);
  assert.match(hubApiKeyProblem('')!, /ключ/i);
  assert.match(hubApiKeyProblem('abc def ghi jkl')!, /ключ/i);
  assert.match(hubApiKeyProblem('abc')!, /ключ/i);
});

test('setup link: the code travels in the fragment, defaults to hub.local:4310', () => {
  assert.equal(hubSetupUrl('TS1.abc'), 'http://hub.local:4310/setup#code=TS1.abc');
  assert.equal(hubSetupUrl('TS1.abc', '192.168.1.20'), 'http://192.168.1.20:4310/setup#code=TS1.abc');
  assert.equal(hubSetupUrl('TS1.abc', 'fe80::1', 8080), 'http://[fe80::1]:8080/setup#code=TS1.abc');
});

test('which CLOUD_URL the cabinet puts into the code', () => {
  // Supabase: the `sync` Edge Function lives under /functions/v1.
  assert.equal(hubCloudUrl({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co' }), SUPABASE);
  assert.equal(hubCloudUrl({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co/' }), SUPABASE);
  assert.equal(hubCloudUrl({ supabaseUrl: SUPABASE }), SUPABASE);
  // Self-hosted apps/cloud: the address the cabinet is served from.
  assert.equal(hubCloudUrl({ cloudOrigin: 'http://100.101.102.103:4320' }), 'http://100.101.102.103:4320');
  assert.equal(hubCloudUrl({ supabaseUrl: '', cloudOrigin: 'https://cloud.ts.kz/' }), 'https://cloud.ts.kz');
  assert.equal(hubCloudUrl({}), null);
  assert.equal(isLocalOnlyCloudUrl('http://localhost:4320'), true);
  assert.equal(isLocalOnlyCloudUrl('http://127.0.0.1:4320'), true);
  assert.equal(isLocalOnlyCloudUrl('http://[::1]:4320'), true);
  assert.equal(isLocalOnlyCloudUrl('http://100.101.102.103:4320'), false);
  assert.equal(isLocalOnlyCloudUrl(SUPABASE), false);
});
