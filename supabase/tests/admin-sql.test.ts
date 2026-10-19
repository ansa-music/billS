import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlFor } from '../../scripts/supabase-sql.ts';
import { createSupabaseDb } from './harness.ts';

test('scripts/supabase-sql.ts: demo, company and club SQL run in the SQL Editor as is', async () => {
  const s = await createSupabaseDb();
  try {
    await s.pg.exec(await sqlFor(['demo']));
    const company = await sqlFor(['company', '--company', 'Сеть «Тест»', '--email', 'Boss@Example.kz']);
    await s.pg.exec(company);
    const companyId = /COMPANY_ID=(\S+)/.exec(company)![1]!;
    const club = await sqlFor(['club', '--company', companyId, '--name', "Клуб O'Neil", '--tz', 'Asia/Aqtobe']);
    await s.pg.exec(club);
    const rows = await s.db.all<{ name: string; owners: number; clubs: number }>(
      `SELECT c.name, (SELECT COUNT(*) FROM owners o WHERE o.company_id = c.id) AS owners,
              (SELECT COUNT(*) FROM clubs k WHERE k.company_id = c.id) AS clubs FROM companies c ORDER BY c.name`,
    );
    assert.deepEqual(rows, [
      { name: 'Демо сеть', owners: 1, clubs: 2 },
      { name: 'Сеть «Тест»', owners: 1, clubs: 1 },
    ]);
    const owner = await s.db.all<{ email: string }>("SELECT email FROM owners WHERE company_id = ?", [companyId]);
    assert.equal(owner[0]!.email, 'boss@example.kz');
    assert.match(club, /CLOUD_API_KEY=\S{40,}/);
  } finally {
    await s.close();
  }
});
