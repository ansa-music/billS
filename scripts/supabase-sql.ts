#!/usr/bin/env node
/**
 * SQL for the Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run):
 * the platform creates companies, owners, clubs and HUB keys without connecting to the database.
 * The same code as the self-hosted cloud CLI (apps/cloud/src/admin.ts, seed.ts) writes the rows;
 * here they are printed as one transaction instead of being executed.
 *
 *   node scripts/supabase-sql.ts demo
 *   node scripts/supabase-sql.ts company --company "<название>" --email <e-mail> [--name "<имя>"]
 *   node scripts/supabase-sql.ts club --company <id компании> --name "<название>" [--tz Asia/Almaty] [--currency KZT]
 *
 * The owner signs in through Supabase Auth: create the Auth user with the same e-mail
 * (Authentication → Users → Add user); it is linked to the owner by e-mail.
 */
import type { SqlDriver } from '../apps/cloud/src/db/driver.ts';
import { addClub, initCompany } from '../apps/cloud/src/admin.ts';
import { DEMO_HUBS, DEMO_OWNER, seedDemo } from '../apps/cloud/src/seed.ts';

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Fills `?` placeholders outside string literals. */
export function inline(sql: string, params: unknown[] = []): string {
  let i = 0;
  let inString = false;
  let out = '';
  for (const ch of sql) {
    if (ch === "'") inString = !inString;
    out += ch === '?' && !inString ? literal(params[i++]) : ch;
  }
  return out;
}

/** A SqlDriver that records writes; reads answer from `answer` (an empty database by default). */
export function recordingDriver(answer: (sql: string) => unknown[] = () => []): { db: SqlDriver; statements: string[] } {
  const statements: string[] = [];
  const db: SqlDriver = {
    async all<T>(sql: string): Promise<T[]> {
      return answer(sql) as T[];
    },
    async run(sql: string, params?: unknown[]): Promise<number> {
      statements.push(`${inline(sql.replace(/\s+/g, ' ').trim(), params)};`);
      return 1;
    },
    transaction: (fn) => fn(db),
    async close() {},
  };
  return { db, statements };
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The script's output for argv as text (exported for tests). */
export async function sqlFor(argv: string[]): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const code = await main(argv);
    if (code !== 0) throw new Error(`exit ${code}`);
  } finally {
    console.log = log;
  }
  return lines.join('\n');
}

function print(statements: string[], notes: string[]): void {
  console.log(['BEGIN;', ...statements, 'COMMIT;'].join('\n'));
  console.log('');
  for (const n of notes) console.log(`-- ${n}`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const now = Date.now();
  if (command === 'demo') {
    const { db, statements } = recordingDriver();
    await seedDemo(db, now);
    print(statements, [
      `Демо-сеть: создайте в Supabase Auth пользователя ${DEMO_OWNER.email} (Authentication → Users → Add user).`,
      ...DEMO_HUBS.map((h) => `${h.club}: HUB_ID=${h.id} CLOUD_API_KEY=${h.key}`),
    ]);
    return 0;
  }
  if (command === 'company') {
    const { db, statements } = recordingDriver();
    const r = await initCompany(db, now, { company: arg(args, 'company') ?? '', email: arg(args, 'email') ?? '', name: arg(args, 'name') });
    print(statements, [
      `COMPANY_ID=${r.companyId}`,
      `Создайте в Supabase Auth пользователя ${r.email} (Authentication → Users → Add user или Send invitation).`,
      'Пароль владельца хранит Supabase Auth; password_hash в owners нужен только самостоятельному облаку apps/cloud.',
    ]);
    return 0;
  }
  if (command === 'club') {
    const companyId = arg(args, 'company');
    if (!companyId) throw new Error('Укажите --company <id компании> (COMPANY_ID из команды company)');
    const { db, statements } = recordingDriver((sql) => (/FROM companies/.test(sql) ? [{ id: companyId, name: '' }] : []));
    const r = await addClub(db, now, { name: arg(args, 'name') ?? '', timezone: arg(args, 'tz'), currency: arg(args, 'currency'), companyId });
    print(statements, [
      `CLUB_ID=${r.clubId}`,
      'В .env HUB клуба (ключ показан один раз, в базе только его хэш):',
      'CLOUD_URL=https://<ID проекта>.supabase.co/functions/v1',
      `HUB_ID=${r.hubId}`,
      `CLOUD_API_KEY=${r.apiKey}`,
    ]);
    return 0;
  }
  console.error('Использование: node scripts/supabase-sql.ts demo | company --company "<название>" --email <e-mail> | club --company <id> --name "<название>"');
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
