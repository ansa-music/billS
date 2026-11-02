/**
 * Makes a trial coffee shop's snapshot the way the browser trial would upload it to Supabase
 * (`trials.snapshot`: base64 of the whole SQLite file): the real HUB code under Node, a café set up by
 * setupTrialClub like the welcome screen does, a shift and a few counter orders at different stages.
 *
 *   node scripts/make-trial-snapshot.ts <out.b64> [manager key] [days] [orders a day]
 *
 * Defaults: 3 days × 8 orders (~0.8 MB). A busy two weeks — `… 583104 14 150` — makes the 3–6 MB café the
 * chunked import is measured with (README.md).
 *
 * The browser makes the file with sql.js `db.export()`; here it is node:sqlite `VACUUM INTO` — the same
 * SQLite file format and the same migrations.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../hub/src/clock.ts';
import { openDb } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SimulatorLampDriver } from '../../hub/src/lamps/simulator.ts';
import { setupTrialClub } from '../../hub/src/trial.ts';

const out = process.argv[2];
const key = process.argv[3] ?? '583104';
const days = Number(process.argv[4] ?? 3);
const perDay = Number(process.argv[5] ?? 8);
if (!out || !(days >= 1) || !(perDay >= 1)) {
  console.error('usage: node scripts/make-trial-snapshot.ts <out.b64> [manager key] [days] [orders a day]');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'ts-trial-'));
const start = Date.now() - days * 24 * 3600_000;
const clock = new ManualClock(start);
const db = openDb(join(dir, 'trial.db'), start);
const hub = new Hub({ db, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 0 }), guardIntervalMs: 0 });
setupTrialClub(hub, { venue: 'Кофейня «Тюльпан»', managerName: 'Мадина', key, timezone: 'Asia/Almaty', withMenu: true, now: start });

const actor = 'Мадина';
const catalog = hub.bar.catalog();
// Items with a piece count (cakes) run out over a long run: drinks only.
const products = catalog.products.filter((p) => p.isActive && p.stock === null);
let made = 0;
const step = Math.max(1, Math.floor((12 * 60) / perDay));
for (let day = 0; day < days; day++) {
  clock.set(start + day * 24 * 3600_000 + 8 * 3600_000);
  const shift = hub.shifts.open({ openingFloat: 2_000_00, actor });
  let cash = 2_000_00;
  for (let i = 0; i < perDay; i++) {
    clock.advance(step * 60_000);
    const p = products[(day * perDay + i) % products.length]!;
    const options = p.options.filter((g) => g.required && g.choices.length).map((g) => g.choices[0]!.id);
    const price = p.price + p.options.filter((g) => g.required && g.choices.length).reduce((n, g) => n + g.choices[0]!.priceDelta, 0);
    const res = hub.counter.create({
      items: [{ productId: p.id, qty: 1, ...(options.length ? { options } : {}) }],
      service: i % 2 ? 'HERE' : 'TAKEAWAY',
      guestName: ['Аня', 'Ерлан', 'Дина', 'Тимур'][i % 4],
      payment: { parts: [{ method: i % 3 ? 'CARD' : 'CASH', amount: price }] },
      actor,
    }) as unknown as { order?: { id: string }; id?: string };
    const id = res.order?.id ?? res.id!;
    // The last day leaves a few orders at the bar.
    const last = day === days - 1;
    const stages = !last || i < perDay - 3 ? (['PREPARING', 'READY', 'ISSUED'] as const) : i === perDay - 3 ? (['PREPARING'] as const) : ([] as const);
    for (const stage of stages) hub.counter.stage({ orderId: id, stage, actor });
    if (i % 3 === 0) cash += price;
    made++;
  }
  // Every day but the last ends with the shift closed; the last one is still open.
  if (day < days - 1) {
    clock.advance(30 * 60_000);
    hub.shifts.close({ shiftId: shift.id, countedCash: cash, actor });
  }
}

// A long key too (MGR-…), as a director who also signs in from the cabinet has: it must keep working after a move.
const director = (hub.db.prepare("SELECT id FROM staff WHERE roles LIKE '%manager%' LIMIT 1").get() as { id: string }).id;
const longKey = hub.auth.issueKey({ staffId: director, label: 'ПК директора', actor: { id: director, name: actor, role: 'manager', roles: ['manager'] } }).key;

const file = join(dir, 'snapshot.db');
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
hub.close();
db.close();
const bytes = readFileSync(file);
writeFileSync(out, bytes.toString('base64'));
rmSync(dir, { recursive: true, force: true });
console.log(`trial snapshot: ${made} orders, ${bytes.length} bytes (${Math.round((bytes.length * 4) / 3)} base64) → ${out}; director key ${key}, long key ${longKey}`);
