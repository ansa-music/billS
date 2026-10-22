/**
 * First-boot wizard of a club HUB (`/setup`): what it saves and how the saved file joins the config.
 *
 * The mini-PC image ships the HUB installed but not connected to a cloud. The manager opens
 * http://<ip>:4310/setup (or http://hub.local:4310/setup) on a phone in the club network, pastes
 * the connection code from the cabinet (packages/domain/src/hub-setup.ts) or HUB_ID + key, and picks
 * the lamp controller. The HUB checks the key against the cloud, writes `setup.json` next to its
 * database (mode 0600: it holds the key) and asks main.ts to restart: the process exits with
 * SETUP_RESTART_EXIT_CODE and systemd (Restart=always) or the Windows task loop (run-hub.cmd) starts
 * it again within seconds, now with the cloud and the controller in effect. A restart is the reliable
 * way to apply both — the lamp driver and the sync worker are wired once at start, and the HUB
 * restores running games after a restart anyway (invariant 8).
 *
 * Precedence (`mergeSetupEnv`): hub.env wins where it is set, setup.json fills in the rest.
 *  - Cloud, as one unit: hub.env with its own HUB_ID and CLOUD_API_KEY wins entirely (that is what
 *    `bills connect-cloud` writes); otherwise setup.json's URL, HUB_ID and key — its URL also beats a
 *    bare CLOUD_URL preset, since the key was issued by that cloud.
 *  - Lamps: HUB_LAMP_DRIVER in hub.env decides the controller; otherwise setup.json's driver with the
 *    address/token given in the wizard (HUB_ESP32_HOST / HUB_ESP32_TOKEN / HUB_MODBUS_HOST still win).
 * Empty values in hub.env count as unset. The wizard is open only while no HUB_ID + key is in effect
 * (and HUB_SETUP is not `off`); to run it again, delete setup.json and restart the HUB.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HUB_SETUP_FILE_NAME, hubApiKeyProblem, hubIdProblem, normalizeCloudUrl, parseHubSetupCode } from '@bills/domain';
import type { HubSetupLampDriver, HubSetupRequest, HubSetupResponse, HubSetupStatus } from '@bills/domain';
import { dbPathOf, LAMP_DRIVERS, loadConfig } from './config.ts';
import type { HubConfig, LampDriverKind } from './config.ts';
import { HubError } from './errors.ts';
import type { SetupController } from './http/routes/setup.ts';
import { ChannelAddressError, parseHostPort } from './lamps/address.ts';

/** Exit code of the restart after the wizard saved; any non-zero code is restarted by systemd and run-hub.cmd. */
export const SETUP_RESTART_EXIT_CODE = 75;

const CHECK_TIMEOUT_MS = 10_000;
/** Far above any settings version: the cloud answers `changed: false` — a read-only check of the key. */
const CHECK_SINCE = 2_147_483_647;
const DEFAULT_RESTART_DELAY_MS = 1500;

export interface HubSetupLamps {
  driver: LampDriverKind;
  esp32Host?: string;
  esp32Token?: string;
  modbusHost?: string;
}

/** `setup.json` as the wizard writes it. */
export interface HubSetupFile {
  version: 1;
  savedAt: string;
  /** Whether the cloud accepted the key when it was saved (false: saved without internet). */
  checked: boolean;
  cloud: { url: string; hubId: string; apiKey: string };
  /** null: HUB_LAMP_DRIVER in hub.env decides the controller. */
  lamps: HubSetupLamps | null;
}

const set = (env: NodeJS.ProcessEnv, name: string): boolean => (env[name] ?? '').trim() !== '';

/** HUB_SETUP_FILE, or setup.json next to the database (/var/lib/bills/setup.json, C:\bills\data\setup.json). */
export function setupFilePath(env: NodeJS.ProcessEnv): string {
  return env.HUB_SETUP_FILE?.trim() || join(dirname(dbPathOf(env)), HUB_SETUP_FILE_NAME);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fileProblem(o: unknown): string | null {
  if (!isObject(o)) return 'не объект';
  if (o.version !== 1) return 'неизвестная версия';
  const c = o.cloud;
  if (!isObject(c)) return 'нет раздела cloud';
  if (typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url) || !normalizeCloudUrl(c.url)) return 'cloud.url';
  if (typeof c.hubId !== 'string' || hubIdProblem(c.hubId)) return 'cloud.hubId';
  if (typeof c.apiKey !== 'string' || hubApiKeyProblem(c.apiKey)) return 'cloud.apiKey';
  const l = o.lamps;
  if (l !== null && l !== undefined) {
    if (!isObject(l) || !LAMP_DRIVERS.includes(l.driver as LampDriverKind)) return 'lamps.driver';
    for (const k of ['esp32Host', 'esp32Token', 'modbusHost'] as const) {
      if (l[k] !== undefined && typeof l[k] !== 'string') return `lamps.${k}`;
    }
  }
  return null;
}

/** The saved wizard answers; a missing file is `{ file: null, error: null }`, a broken one is reported, never thrown. */
export function readSetupFile(path: string): { file: HubSetupFile | null; error: string | null } {
  if (!existsSync(path)) return { file: null, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { file: null, error: `${path} (setup.json) не читается: ${(err as Error).message}` };
  }
  const problem = fileProblem(parsed);
  if (problem) return { file: null, error: `${path} (setup.json) повреждён: ${problem}` };
  const f = parsed as HubSetupFile;
  return { file: { ...f, lamps: f.lamps ?? null }, error: null };
}

/** Writes the file atomically (temp file + rename), readable by the HUB's own user only. */
export function writeSetupFile(path: string, file: HubSetupFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    // The mode of writeFileSync is masked by the umask and ignored for an existing file.
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The environment with setup.json filled in where hub.env leaves it empty (rules in the header). */
export function mergeSetupEnv(env: NodeJS.ProcessEnv, file: HubSetupFile | null): NodeJS.ProcessEnv {
  if (!file) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  if (!(set(env, 'HUB_ID') && set(env, 'CLOUD_API_KEY'))) {
    out.CLOUD_URL = file.cloud.url;
    out.HUB_ID = file.cloud.hubId;
    out.CLOUD_API_KEY = file.cloud.apiKey;
  }
  const lamps = file.lamps;
  if (lamps && !set(env, 'HUB_LAMP_DRIVER')) {
    out.HUB_LAMP_DRIVER = lamps.driver;
    if (lamps.esp32Host && !set(env, 'HUB_ESP32_HOST')) out.HUB_ESP32_HOST = lamps.esp32Host;
    if (lamps.esp32Token && !set(env, 'HUB_ESP32_TOKEN')) out.HUB_ESP32_TOKEN = lamps.esp32Token;
    if (lamps.modbusHost && !set(env, 'HUB_MODBUS_HOST')) out.HUB_MODBUS_HOST = lamps.modbusHost;
  }
  return out;
}

export interface LoadedHubConfig {
  config: HubConfig;
  setupPath: string;
  setupFile: HubSetupFile | null;
  /** setup.json exists but is broken: the HUB starts without it (standalone, wizard open). */
  setupError: string | null;
}

/** What main.ts runs with: hub.env (process env) plus the wizard's setup.json. */
export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): LoadedHubConfig {
  const setupPath = setupFilePath(env);
  const { file, error } = readSetupFile(setupPath);
  return { config: loadConfig(mergeSetupEnv(env, file)), setupPath, setupFile: file, setupError: error };
}

export interface SetupServiceOptions {
  /** Where to write setup.json (`setupFilePath`). */
  path: string;
  /** hub.env as given (without setup.json): what is preset there is not asked again. */
  env: NodeJS.ProcessEnv;
  /** The config in effect: decides whether the wizard is open. */
  config: HubConfig;
  fetch?: typeof fetch;
  checkTimeoutMs?: number;
  /** Pause between the answer and `onSaved`, so the page gets its reply before the HUB goes down. */
  restartDelayMs?: number;
  /** Called once after saving: main.ts restarts the HUB to apply the file. */
  onSaved?: (file: HubSetupFile) => void;
  /** Audit entry of the save (never the key). */
  audit?: (data: Record<string, unknown>) => void;
}

const LAMP_NAMES: Record<'esp32-http' | 'modbus-tcp', string> = { 'esp32-http': 'платы ESP32', 'modbus-tcp': 'модуля Modbus' };

function invalid(field: string, message: string): HubError {
  return new HubError(422, 'SETUP_INVALID', message, { field });
}

function unreachable(message: string): HubError {
  return new HubError(502, 'CLOUD_UNREACHABLE', message, { canSkip: true });
}

/** Wizard logic behind the routes of http/routes/setup.ts. */
export class SetupService implements SetupController {
  readonly #path: string;
  readonly #config: HubConfig;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #restartDelayMs: number;
  readonly #onSaved: ((file: HubSetupFile) => void) | undefined;
  readonly #audit: ((data: Record<string, unknown>) => void) | undefined;
  readonly #cloudUrlPreset: string | null;
  readonly #lampsPreset: HubSetupLampDriver | null;
  #saved: HubSetupFile | null = null;
  #busy = false;

  constructor(options: SetupServiceOptions) {
    this.#path = options.path;
    this.#config = options.config;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    this.#restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.#onSaved = options.onSaved;
    this.#audit = options.audit;
    const url = options.env.CLOUD_URL?.trim().replace(/\/+$/, '');
    this.#cloudUrlPreset = url ? url : null;
    const driver = options.env.HUB_LAMP_DRIVER?.trim() as LampDriverKind | undefined;
    this.#lampsPreset = driver && LAMP_DRIVERS.includes(driver) ? driver : null;
  }

  status(): HubSetupStatus {
    const presets = { cloudUrlPreset: this.#cloudUrlPreset, lampsPreset: this.#lampsPreset };
    if (this.#config.demo) return { open: false, state: 'demo', hubId: null, ...presets };
    if (!this.#config.setupEnabled) return { open: false, state: 'off', hubId: this.#config.hubId || null, ...presets };
    if (this.#saved) return { open: false, state: 'saved', hubId: this.#saved.cloud.hubId, ...presets };
    if (this.#config.hubId && this.#config.cloudApiKey) return { open: false, state: 'configured', hubId: this.#config.hubId, ...presets };
    return { open: true, state: 'open', hubId: null, ...presets };
  }

  async save(req: HubSetupRequest, meta: { ip?: string } = {}): Promise<HubSetupResponse> {
    const st = this.status();
    if (st.state === 'demo') throw new HubError(410, 'SETUP_DISABLED', 'Это демо-HUB: мастер настройки в нём отключён');
    if (st.state === 'off') throw new HubError(410, 'SETUP_DISABLED', 'Мастер настройки выключен в настройках сервера (HUB_SETUP=off)');
    if (!st.open) throw new HubError(409, 'SETUP_DONE', 'HUB уже подключён к облаку — мастер настройки закрыт');
    if (this.#busy) throw new HubError(409, 'SETUP_BUSY', 'Подождите — настройки уже сохраняются');
    this.#busy = true;
    try {
      const cloud = this.#cloudOf(req);
      const lamps = this.#lampsPreset ? null : lampsOf(req.lamps);
      const checked = !req.skipCheck;
      if (checked) await this.#check(cloud.url, cloud.hubId, cloud.apiKey);
      const file: HubSetupFile = { version: 1, savedAt: new Date().toISOString(), checked, cloud, lamps };
      try {
        writeSetupFile(this.#path, file);
      } catch (err) {
        throw new HubError(500, 'SETUP_WRITE_FAILED', `Не удалось сохранить настройки на диск мини-ПК: ${(err as Error).message}`);
      }
      this.#saved = file;
      this.#audit?.({ hubId: cloud.hubId, cloudUrl: cloud.url, lampDriver: lamps?.driver ?? null, checked, ip: meta.ip ?? null });
      const onSaved = this.#onSaved;
      if (onSaved) setTimeout(() => onSaved(file), this.#restartDelayMs);
      return {
        ok: true,
        hubId: cloud.hubId,
        cloudUrl: cloud.url,
        checked,
        restartInMs: this.#restartDelayMs,
        warning: checked
          ? null
          : 'Связь с облаком не проверена: HUB подключится сам, как только у мини-ПК появится интернет. Если ключ окажется неверным, в кабинете филиал останется «HUB ещё не выходил на связь».',
      };
    } finally {
      this.#busy = false;
    }
  }

  #cloudOf(req: HubSetupRequest): HubSetupFile['cloud'] {
    const code = req.code?.trim();
    if (code) {
      const parsed = parseHubSetupCode(code);
      if (!parsed.ok) throw invalid('code', parsed.message);
      return { url: parsed.value.cloudUrl, hubId: parsed.value.hubId, apiKey: parsed.value.apiKey };
    }
    const hubId = (req.hubId ?? '').trim();
    const apiKey = (req.apiKey ?? '').trim();
    const idProblem = hubIdProblem(hubId);
    if (idProblem) throw invalid('hubId', idProblem);
    const keyProblem = hubApiKeyProblem(apiKey);
    if (keyProblem) throw invalid('apiKey', keyProblem);
    const typed = req.cloudUrl?.trim();
    const url = typed ? normalizeCloudUrl(typed) : this.#cloudUrlPreset;
    if (!url) {
      throw invalid(
        'cloudUrl',
        typed
          ? 'Адрес облака не подходит: он начинается с https:// (например https://<ID>.supabase.co/functions/v1)'
          : 'Укажите адрес облака (CLOUD_URL) — он показан в кабинете рядом с ключом. Проще вставить код подключения: в нём уже есть всё',
      );
    }
    return { url, hubId, apiKey };
  }

  /** Read-only call with the new key (GET /sync/settings, far-future `since`): apps/cloud and the Edge Function alike. */
  async #check(cloudUrl: string, hubId: string, apiKey: string): Promise<void> {
    const url = `${cloudUrl}/sync/settings?since=${CHECK_SINCE}&hubId=${encodeURIComponent(hubId)}`;
    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(url, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      text = await res.text();
    } catch {
      throw unreachable(
        'Нет связи с облаком. Проверьте, что мини-ПК подключён к интернету (кабель от роутера или Wi-Fi), и попробуйте ещё раз. Можно сохранить без проверки — HUB подключится сам, когда появится интернет.',
      );
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = isObject(json) && isObject(json.error) ? json.error.code : undefined;
    if (res.status === 401) {
      throw new HubError(
        422,
        'CLOUD_KEY_INVALID',
        'Облако не узнало этот HUB — ключ не подходит. Скопируйте код (или ключ) из кабинета ещё раз; если ключ выдавали заново, нужен новый.',
      );
    }
    if (res.status === 403 && code === 'HUB_MISMATCH') {
      throw new HubError(422, 'CLOUD_HUB_MISMATCH', 'Ключ выдан другому HUB — проверьте HUB_ID: он должен быть из той же записи в кабинете, что и ключ.');
    }
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      throw unreachable(`Облако сейчас не отвечает (ошибка ${res.status}). Попробуйте через минуту или сохраните без проверки — HUB подключится сам.`);
    }
    if (!res.ok || !isObject(json) || typeof json.version !== 'number') {
      throw new HubError(
        422,
        'CLOUD_NOT_TS',
        `По адресу ${cloudUrl} отвечает не облако TS. Проверьте адрес облака — проще всего вставить код подключения из кабинета.`,
      );
    }
  }
}

function lampsOf(input: HubSetupRequest['lamps']): HubSetupLamps {
  const driver = input?.driver ?? 'simulator';
  if (driver === 'simulator') return { driver };
  const field = driver === 'esp32-http' ? 'esp32Host' : 'modbusHost';
  const host = ((driver === 'esp32-http' ? input?.esp32Host : input?.modbusHost) ?? '').trim();
  const example = driver === 'esp32-http' ? '192.168.1.50' : '192.168.1.60';
  if (!host) throw invalid(field, `Укажите адрес ${LAMP_NAMES[driver]} в сети клуба, например ${example}`);
  try {
    parseHostPort(host, driver === 'esp32-http' ? 80 : 502);
  } catch (err) {
    if (!(err instanceof ChannelAddressError)) throw err;
    throw invalid(field, `Адрес «${host}» не подходит: нужен IP-адрес ${LAMP_NAMES[driver]}, например ${example} (можно с портом: ${example}:8080)`);
  }
  if (driver === 'modbus-tcp') return { driver, modbusHost: host };
  const token = (input?.esp32Token ?? '').trim();
  if (token && !/^[\x21-\x7e]{1,200}$/.test(token)) throw invalid('esp32Token', 'Токен платы — латинские буквы и цифры, без пробелов');
  return { driver, esp32Host: host, ...(token ? { esp32Token: token } : {}) };
}
