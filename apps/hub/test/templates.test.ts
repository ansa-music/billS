import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogView, ClubAdminView } from '@bills/domain';
import { run } from '../src/db.ts';
import { auditActions, Harness, post } from './helpers.ts';

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

test('«Заполнить примером»: standard and snooker tariffs, once, in the club currency', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  // The demo club already has them: rename to make room for the template.
  run(hub.db, "UPDATE tariffs SET name = 'Старый ' || name");
  run(hub.db, "UPDATE clubs SET currency = 'RUB'");

  const first = await post(hub, '/api/templates/apply', { kind: 'tariffs-standard' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { kind: 'tariffs-standard', tariffs: 2, categories: 0, products: 0 });
  const club = (await hub.app.inject({ method: 'GET', url: '/api/club' })).json() as ClubAdminView;
  const made = club.tariffs.filter((x) => x.name === 'Стандарт' || x.name === 'Снукер');
  assert.equal(made.length, 2);
  assert.ok(made.every((x) => x.config.currency === 'RUB'));
  assert.equal(auditActions(hub).filter((a) => a === 'tariff.created').length, 2);

  const again = await post(hub, '/api/templates/apply', { kind: 'tariffs-standard' });
  assert.equal(again.status, 200);
  assert.equal((again.body as unknown as { tariffs: number }).tariffs, 0);
});

test('«Заполнить примером»: cafe menu with options and bar menu fill an empty catalog', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  run(hub.db, 'DELETE FROM products');
  run(hub.db, 'DELETE FROM product_categories');

  const cafe = await post(hub, '/api/templates/apply', { kind: 'menu-cafe' });
  assert.equal(cafe.status, 200);
  const counts = cafe.body as unknown as { categories: number; products: number };
  assert.equal(counts.categories, 3);
  assert.ok(counts.products >= 10);
  const catalog = (await hub.app.inject({ method: 'GET', url: '/api/bar/catalog' })).json() as CatalogView;
  const latte = catalog.products.find((p) => p.name === 'Латте');
  assert.ok(latte, 'Латте is in the menu');
  assert.ok((latte as unknown as { options?: unknown[] }).options?.length, 'Латте keeps its options');

  const bar = await post(hub, '/api/templates/apply', { kind: 'menu-bar' });
  assert.equal(bar.status, 200);
  assert.ok((bar.body as unknown as { products: number }).products > 0);

  const twice = await post(hub, '/api/templates/apply', { kind: 'menu-cafe' });
  assert.deepEqual(twice.body, { kind: 'menu-cafe', tariffs: 0, categories: 0, products: 0 });
});

test('«Заполнить примером»: unknown template is refused', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const res = await post(hub, '/api/templates/apply', { kind: 'everything' });
  assert.equal(res.status, 400);
});
