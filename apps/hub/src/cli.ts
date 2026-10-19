#!/usr/bin/env node
/**
 * TS HUB — служебные команды (без зависимости от бинарника sqlite3).
 *
 *   node apps/hub/src/cli.ts backup <папка|файл>   консистентная копия базы (можно при работающем HUB)
 *   node apps/hub/src/cli.ts restore <файл> --yes  заменить базу копией (HUB должен быть остановлен)
 *   node apps/hub/src/cli.ts check [файл]          PRAGMA integrity_check + счётчики
 *   node apps/hub/src/cli.ts version [--json]      версия и git-коммит
 *   node apps/hub/src/cli.ts ca init [...]         корневой сертификат клуба и сертификат HUB (HTTPS)
 *   node apps/hub/src/cli.ts ca show               что сейчас в папке сертификатов
 *
 * База берётся из HUB_DB_PATH (как у сервера). Если переменная не задана и в
 * корне репозитория есть .env — он подхватывается.
 * Коды выхода: 0 — успех, 1 — ошибка, 2 — неверное использование.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.ts';
import {
  backupDatabase,
  integrityCheck,
  listBackups,
  planRestore,
  restoreDatabase,
} from './ops.ts';
import { REPO_ROOT, versionInfo, versionString } from './version.ts';
import { describe, initCa, lanAddresses, tlsPaths } from './tls/ca.ts';
import type { CertInfo, TlsPaths } from './tls/ca.ts';
import { normalizeHostName } from './mdns.ts';

function describeLines(paths: TlsPaths, info: CertInfo): string[] {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [
    `  папка:           ${paths.dir}`,
    `  корневой:        ${info.caSubject} (до ${day(info.caValidTo)})`,
    `  отпечаток:       ${info.caFingerprint}`,
    `  сертификат HUB:  до ${day(info.serverValidTo)}; имена: ${info.dnsNames.join(', ') || '—'}; IP: ${info.ips.join(', ') || '—'}`,
  ];
}

const USAGE = `Использование:
  node apps/hub/src/cli.ts backup <папка|файл>    копия базы (папка → hub-ГГГГ-ММ-ДД_чч-мм-сс.db)
  node apps/hub/src/cli.ts restore <файл> --yes   восстановить базу из копии (остановите HUB!)
  node apps/hub/src/cli.ts check [файл]           проверить целостность базы
  node apps/hub/src/cli.ts version [--json]       версия HUB
  node apps/hub/src/cli.ts ca init [--dir=папка] [--ip=192.168.1.10,...] [--name=hub.local,...] [--label=Клуб] [--force] [--json]
                                                  создать корневой сертификат клуба (один раз) и сертификат HUB;
                                                  повторный запуск сохраняет корневой и перевыпускает сертификат HUB,
                                                  если сменился IP или срок подходит к концу
  node apps/hub/src/cli.ts ca show [--dir=папка] [--json]   показать сертификаты
Переменные: HUB_DB_PATH (путь к базе), HUB_BACKUP_MARKER (маркер последнего бэкапа),
  HUB_TLS_DIR (папка сертификатов, по умолчанию tls/ рядом с базой), HUB_MDNS_NAME (имя в сети, hub → hub.local).`;

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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

/** Runs one CLI command; returns the exit code. Exported for tests. */
export function runCli(argv: string[], io: CliIo = defaultIo): number {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--') && !a.includes('=')));
  const options = new Map(
    rest.filter((a) => a.startsWith('--') && a.includes('=')).map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]),
  );
  const list = (key: string) => options.get(key)?.split(',').map((v) => v.trim()).filter(Boolean);
  const args = rest.filter((a) => !a.startsWith('--'));
  const dbPath = loadConfig(io.env).dbPath;

  try {
    switch (command) {
      case 'version': {
        const info = versionInfo(io.env);
        io.out(flags.has('--json') ? JSON.stringify(info) : versionString(info));
        return 0;
      }

      case 'backup': {
        const target = args[0];
        if (!target) {
          io.err('Укажите папку или файл для копии.\n' + USAGE);
          return 2;
        }
        const r = backupDatabase(dbPath, target, { now: io.now() });
        io.err(`Копия создана: ${r.path} (${fmtBytes(r.sizeBytes)}), целостность: ok`);
        io.out(r.path);
        return 0;
      }

      case 'ca': {
        const config = loadConfig(io.env);
        const dir = options.get('dir') ?? config.tlsDir;
        const paths = tlsPaths(dir);
        const sub = args[0];
        if (sub === 'show') {
          if (!existsSync(paths.caCert) || !existsSync(paths.serverCert)) {
            io.err(`В ${dir} нет сертификатов — выполните \`ca init\``);
            return 1;
          }
          const info = describe(readFileSync(paths.caCert), readFileSync(paths.serverCert));
          io.out(flags.has('--json') ? JSON.stringify({ paths, info }) : describeLines(paths, info).join('\n'));
          return 0;
        }
        if (sub !== 'init') {
          io.err('Укажите `ca init` или `ca show`.\n' + USAGE);
          return 2;
        }
        const mdns = config.mdnsName ? normalizeHostName(config.mdnsName) : 'hub.local';
        const r = initCa({
          dir,
          dnsNames: list('name') ?? [mdns, 'localhost'],
          ips: list('ip') ?? [...lanAddresses(), '127.0.0.1'],
          label: options.get('label'),
          now: io.now(),
          forceServer: flags.has('--force'),
        });
        if (flags.has('--json')) {
          io.out(JSON.stringify(r));
          return 0;
        }
        io.err(r.caCreated ? 'Создан корневой сертификат клуба — его нужно установить на каждый планшет и ПК.' : 'Корневой сертификат уже есть — оставлен как был (планшеты его не теряют).');
        io.err(r.serverIssued ? `Сертификат HUB выпущен (${r.reason}).` : 'Сертификат HUB в порядке — не перевыпускался.');
        for (const l of describeLines(r.paths, r.info)) io.err(l);
        io.err('Для HTTPS добавьте в настройки HUB (/etc/bills/hub.env или .env) и перезапустите HUB:');
        io.out(`HUB_TLS_CERT=${r.paths.serverCert}`);
        io.out(`HUB_TLS_KEY=${r.paths.serverKey}`);
        io.out(`HUB_TLS_CA=${r.paths.caCert}`);
        return 0;
      }

      case 'check': {
        const path = args[0] ?? dbPath;
        const report = integrityCheck(path);
        io.out(JSON.stringify(report, null, 2));
        if (!report.ok) io.err(`База повреждена: ${report.messages.join('; ')}`);
        return report.ok ? 0 : 1;
      }

      case 'restore': {
        const source = args[0];
        if (!source) {
          const dir = io.env.BACKUP_DIR ?? join(REPO_ROOT, 'apps', 'hub', 'data', 'backups');
          const list = listBackups(dir);
          io.err(`Укажите файл копии. Последние копии в ${dir}:`);
          for (const b of list.slice(0, 10)) io.err(`  ${new Date(b.mtime).toISOString()}  ${fmtBytes(b.sizeBytes).padStart(9)}  ${b.path}`);
          if (list.length === 0) io.err('  (нет файлов)');
          return 2;
        }
        if (!existsSync(source)) {
          io.err(`Файл не найден: ${source}`);
          return 1;
        }
        const plan = planRestore(source, dbPath, io.now());
        if (!flags.has('--yes')) {
          io.err('План восстановления (ничего не изменено, добавьте --yes для выполнения):');
          io.err(`  копия:         ${plan.source}`);
          io.err(`  база:          ${plan.target}`);
          io.err(`  текущая база → ${plan.keepPreviousAs ?? '(нет, база ещё не существует)'}`);
          io.err('ВАЖНО: HUB должен быть остановлен перед восстановлением.');
          return 2;
        }
        const r = restoreDatabase(source, dbPath, io.now());
        io.err(`База восстановлена из ${r.source}`);
        if (r.keepPreviousAs) io.err(`Прежняя база сохранена как ${r.keepPreviousAs}`);
        io.err(`Версия схемы: ${r.schemaVersion}, игр идёт: ${r.counts?.sessionsLive ?? 0}, целостность: ok`);
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
    io.err(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function loadRootEnv(): void {
  if (process.env.HUB_DB_PATH) return;
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
  process.exitCode = runCli(process.argv.slice(2));
}
