#!/usr/bin/env node
/**
 * Облако TS — служебные команды (без зависимости от бинарника sqlite3).
 *
 *   node apps/cloud/src/cli.ts init --company "<название>" --email <e-mail> [--name "<имя>"] [--password <пароль>]
 *   node apps/cloud/src/cli.ts add-club --name "<название>" [--tz Asia/Almaty] [--currency KZT] [--company <id>]
 *   node apps/cloud/src/cli.ts new-hub-key --hub <id>
 *   node apps/cloud/src/cli.ts reset-password --email <e-mail> [--password <пароль>]
 *   node apps/cloud/src/cli.ts list [--json]
 *   node apps/cloud/src/cli.ts backup <папка|файл>
 *   node apps/cloud/src/cli.ts restore <файл> --yes
 *   node apps/cloud/src/cli.ts check [файл]
 *   node apps/cloud/src/cli.ts version [--json]
 *
 * База — из CLOUD_DB_PATH или CLOUD_DATABASE_URL (как у сервера). Если ни одна
 * не задана и в корне репозитория есть .env — он подхватывается.
 * Значения для скриптов печатаются отдельными строками `КЛЮЧ=значение`.
 * Коды выхода: 0 — успех, 1 — ошибка, 2 — неверное использование.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AdminError, addClub, initCompany, listAll, newHubKey, resetPassword } from './admin.ts';
import type { CloudConfig } from './config.ts';
import { loadConfig } from './config.ts';
import type { SqlDriver } from './db/driver.ts';
import { migrate } from './db/migrate.ts';
import { openDatabase } from './db/open.ts';
import { backupDatabase, integrityCheck, planRestore, restoreDatabase } from './ops.ts';

/** Repository root: apps/cloud/src/cli.ts → ../../../ */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const USAGE = `Использование: node apps/cloud/src/cli.ts <команда> (или npm run cli -w @bills/cloud -- <команда>)
  init --company "<название>" --email <e-mail> [--name "<имя>"] [--password <пароль>]
                                   создать компанию и владельца (без --password пароль генерируется)
  add-club --name "<название>" [--tz Asia/Almaty] [--currency KZT] [--company <id>]
                                   создать клуб и его HUB с новым ключом
  new-hub-key --hub <id>           перевыпустить ключ HUB (старый перестаёт работать)
  reset-password --email <e-mail> [--password <пароль>]
                                   сменить пароль владельца и завершить его сессии
  list [--json]                    компании, владельцы, клубы и HUB
  backup <папка|файл>              копия базы SQLite (папка → cloud-ГГГГ-ММ-ДД_чч-мм-сс.db)
  restore <файл> --yes             восстановить базу SQLite из копии (остановите облако!)
  check [файл]                     проверить целостность базы SQLite
  version [--json]                 версия облака
Переменные: CLOUD_DB_PATH (файл SQLite) или CLOUD_DATABASE_URL (PostgreSQL).`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  now: () => number;
}

const defaultIo: CliIo = {
  out: (l) => process.stdout.write(l + '\n'),
  err: (l) => process.stderr.write(l + '\n'),
  env: process.env,
  now: () => Date.now(),
};

/** Wrong arguments: exit code 2. */
class UsageError extends Error {}

const OPTIONS = {
  company: { type: 'string' },
  email: { type: 'string' },
  name: { type: 'string' },
  password: { type: 'string' },
  tz: { type: 'string' },
  currency: { type: 'string' },
  hub: { type: 'string' },
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
} as const;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

function fmtTime(at: number | null): string {
  return at === null ? 'ещё не выходил на связь' : new Date(at).toISOString();
}

function required(value: string | undefined, flag: string, hint: string): string {
  if (value === undefined || value.trim() === '') throw new UsageError(`Не указан ${flag} ${hint}`);
  return value;
}

export function versionInfo(env: NodeJS.ProcessEnv = process.env): { version: string; gitSha: string | null } {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
  return { version: pkg.version ?? '0.0.0', gitSha: readGitSha(env) };
}

function readGitSha(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.CLOUD_GIT_SHA?.trim();
  if (fromEnv) return fromEnv.slice(0, 40);
  try {
    const out = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], {
      cwd: REPO_ROOT,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const sha = out.trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Opens the configured database, applies pending migrations, runs `fn`, closes the database. */
async function withDatabase<T>(config: CloudConfig, io: CliIo, fn: (db: SqlDriver) => Promise<T>): Promise<T> {
  const { db } = await openDatabase(config);
  try {
    const applied = await migrate(db, io.now());
    if (applied.length) io.err(`Миграции применены: ${applied.join(', ')}`);
    return await fn(db);
  } finally {
    await db.close();
  }
}

function sqliteOnly(config: CloudConfig, io: CliIo, command: string): boolean {
  if (!config.databaseUrl) return true;
  io.err(
    `Команда ${command} работает только с SQLite, а задан CLOUD_DATABASE_URL (PostgreSQL). ` +
      'Для PostgreSQL используйте pg_dump / pg_restore и средства хостинга.',
  );
  return false;
}

function parseCommandArgs(rest: string[]) {
  try {
    return parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** Runs one CLI command; resolves to the exit code. Exported for tests. */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const { values: opt, positionals: args } = parseCommandArgs(rest);
    const config = loadConfig(io.env);

    switch (command) {
      case 'version': {
        const info = versionInfo(io.env);
        io.out(opt.json ? JSON.stringify(info) : `TS облако ${info.version}${info.gitSha ? ` (git ${info.gitSha})` : ''}`);
        return 0;
      }

      case 'init': {
        const company = required(opt.company, '--company', '"<название компании>"');
        const email = required(opt.email, '--email', '<e-mail владельца>');
        const r = await withDatabase(config, io, (db) =>
          initCompany(db, io.now(), {
            company,
            email,
            ...(opt.name !== undefined ? { name: opt.name } : {}),
            ...(opt.password !== undefined ? { password: opt.password } : {}),
          }),
        );
        io.out(`Компания «${company.trim()}» создана, владелец ${r.email}.`);
        if (r.generatedPassword) io.out('Пароль сгенерирован — сохраните его, он больше не будет показан.');
        io.out(`COMPANY_ID=${r.companyId}`);
        io.out(`OWNER_EMAIL=${r.email}`);
        if (r.generatedPassword) io.out(`OWNER_PASSWORD=${r.generatedPassword}`);
        return 0;
      }

      case 'add-club': {
        const name = required(opt.name, '--name', '"<название клуба>"');
        const r = await withDatabase(config, io, (db) =>
          addClub(db, io.now(), {
            name,
            ...(opt.tz !== undefined ? { timezone: opt.tz } : {}),
            ...(opt.currency !== undefined ? { currency: opt.currency } : {}),
            ...(opt.company !== undefined ? { companyId: opt.company } : {}),
          }),
        );
        io.out(`Клуб «${name.trim()}» создан. Впишите HUB_ID и CLOUD_API_KEY в .env HUB этого клуба; ключ больше не будет показан.`);
        io.out(`CLUB_ID=${r.clubId}`);
        io.out(`HUB_ID=${r.hubId}`);
        io.out(`CLOUD_API_KEY=${r.apiKey}`);
        return 0;
      }

      case 'new-hub-key': {
        const hubId = required(opt.hub, '--hub', '<id HUB> (список — команда list)');
        const key = await withDatabase(config, io, (db) => newHubKey(db, hubId));
        io.out(`Новый ключ HUB ${hubId} выпущен, старый больше не действует. Обновите CLOUD_API_KEY в .env HUB.`);
        io.out(`CLOUD_API_KEY=${key}`);
        return 0;
      }

      case 'reset-password': {
        const email = required(opt.email, '--email', '<e-mail владельца>');
        const r = await withDatabase(config, io, (db) => resetPassword(db, email, opt.password));
        io.out(`Пароль владельца ${r.email} изменён, завершено сессий: ${r.sessionsRemoved}.`);
        if (r.generatedPassword) io.out(`OWNER_PASSWORD=${r.generatedPassword}`);
        return 0;
      }

      case 'list': {
        const companies = await withDatabase(config, io, (db) => listAll(db));
        if (opt.json) {
          io.out(JSON.stringify(companies, null, 2));
          return 0;
        }
        if (companies.length === 0) {
          io.out('Компаний нет. Начните с: init --company "<название>" --email <e-mail>');
          return 0;
        }
        for (const c of companies) {
          io.out(`Компания «${c.name}»  id=${c.id}`);
          for (const o of c.owners) io.out(`  владелец: ${o.email} (${o.name})`);
          if (c.clubs.length === 0) io.out('  клубов нет — добавьте: add-club --name "<название>"');
          for (const club of c.clubs) {
            io.out(`  клуб «${club.name}»  id=${club.id}  пояс=${club.timezone}  валюта=${club.currency}`);
            for (const h of club.hubs) io.out(`    HUB ${h.id}  последний контакт: ${fmtTime(h.lastSeenAt)}`);
          }
        }
        return 0;
      }

      case 'backup': {
        if (!sqliteOnly(config, io, 'backup')) return 1;
        const target = args[0];
        if (!target) throw new UsageError('Укажите папку или файл для копии.');
        const r = backupDatabase(config.dbPath, target, io.now());
        io.err(`Копия создана: ${r.path} (${fmtBytes(r.sizeBytes)}), целостность: ok`);
        io.out(r.path);
        return 0;
      }

      case 'check': {
        if (!args[0] && !sqliteOnly(config, io, 'check')) return 1;
        const report = integrityCheck(args[0] ?? config.dbPath);
        if (!report.ok) {
          io.err(`База повреждена или не читается: ${report.messages.join('; ')}`);
          return 1;
        }
        io.out(`Целостность: ok (${report.path}, ${fmtBytes(report.sizeBytes)}, схема ${report.schemaVersion ?? '—'})`);
        const n = report.counts;
        if (n) {
          io.out(`Компаний: ${n.companies}, владельцев: ${n.owners}, клубов: ${n.clubs}, HUB: ${n.hubs}, событий: ${n.events}`);
          io.out(`COMPANIES=${n.companies}`);
          io.out(`CLUBS=${n.clubs}`);
          io.out(`EVENTS=${n.events}`);
        } else {
          io.out('Это не база облака TS (нет schema_migrations).');
        }
        return 0;
      }

      case 'restore': {
        if (!sqliteOnly(config, io, 'restore')) return 1;
        const source = args[0];
        if (!source) throw new UsageError('Укажите файл копии.');
        if (!existsSync(source)) {
          io.err(`Файл не найден: ${source}`);
          return 1;
        }
        const plan = planRestore(source, config.dbPath, io.now());
        if (!opt.yes) {
          io.err('План восстановления (ничего не изменено, добавьте --yes для выполнения):');
          io.err(`  копия:         ${plan.source}`);
          io.err(`  база:          ${plan.target}`);
          io.err(`  текущая база → ${plan.keepPreviousAs ?? '(нет, база ещё не существует)'}`);
          io.err('ВАЖНО: облако должно быть остановлено перед восстановлением.');
          return 2;
        }
        const r = restoreDatabase(source, config.dbPath, io.now());
        io.err(`База восстановлена из ${r.source}`);
        if (r.keepPreviousAs) io.err(`Прежняя база сохранена как ${r.keepPreviousAs}`);
        io.err(`Версия схемы: ${r.schemaVersion}, клубов: ${r.counts?.clubs ?? 0}, событий: ${r.counts?.events ?? 0}, целостность: ok`);
        io.out(r.target);
        return 0;
      }

      case undefined:
      case '--help':
      case '-h':
      case 'help':
        io.out(USAGE);
        return command ? 0 : 2;

      default:
        io.err(`Неизвестная команда: ${command}\n` + USAGE);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n${USAGE}`);
      return 2;
    }
    if (err instanceof AdminError) {
      io.err(`Ошибка: ${err.message}`);
      return 1;
    }
    io.err(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function loadRootEnv(): void {
  if (process.env.CLOUD_DB_PATH || process.env.CLOUD_DATABASE_URL) return;
  const envFile = join(REPO_ROOT, '.env');
  if (!existsSync(envFile)) return;
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A broken .env must not stop a backup.
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  loadRootEnv();
  process.exitCode = await runCli(process.argv.slice(2));
}
