import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OwnerView } from '@bills/domain';
import { hashPassword, parseCookies, serializeCookie, verifyPassword } from '../src/auth.ts';
import { cloud, login, ownerGet } from './helpers.ts';

test('owner logs in, sees herself, logs out and is 401 afterwards', async (t) => {
  const c = await cloud(t);

  const anonymous = await c.app.inject({ method: 'GET', url: '/api/auth/me' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'UNAUTHORIZED');

  const wrong = await c.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@demo.kz', password: 'nope' },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.code, 'INVALID_CREDENTIALS');

  const res = await c.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'Owner@Demo.kz', password: 'demo1234' },
  });
  assert.equal(res.statusCode, 200);
  const owner = res.json() as OwnerView;
  assert.equal(owner.email, 'owner@demo.kz');
  assert.equal(owner.company.name, 'Демо сеть');
  const setCookie = String(res.headers['set-cookie']);
  assert.match(setCookie, /^bills_owner=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);

  const cookie = await login(c);
  const me = await ownerGet<OwnerView>(c, cookie, '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.id, owner.id);

  const overview = await c.app.inject({ method: 'GET', url: '/api/owner/overview' });
  assert.equal(overview.statusCode, 401);

  const logout = await c.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
  assert.equal(logout.statusCode, 200);
  assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);

  const after = await ownerGet<{ error: { code: string } }>(c, cookie, '/api/auth/me');
  assert.equal(after.status, 401);
});

test('session expires after 30 days', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  c.clock.advance(29 * 24 * 60 * 60 * 1000);
  assert.equal((await ownerGet(c, cookie, '/api/auth/me')).status, 200);
  c.clock.advance(2 * 24 * 60 * 60 * 1000);
  assert.equal((await ownerGet(c, cookie, '/api/auth/me')).status, 401);
});

test('scrypt hashes verify and cookies round-trip', () => {
  const stored = hashPassword('demo1234');
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.ok(verifyPassword('demo1234', stored));
  assert.ok(!verifyPassword('demo12345', stored));
  assert.ok(!verifyPassword('demo1234', 'garbage'));

  const header = serializeCookie('bills_owner', 'abc', { maxAgeSeconds: 10 });
  assert.deepEqual(parseCookies(`${header.split(';')[0]}; other=1`), { bills_owner: 'abc', other: '1' });
  assert.deepEqual(parseCookies(undefined), {});
});
