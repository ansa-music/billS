/**
 * «У меня уже есть TS — войти» in the page (VITE_TRIAL=1); the contract is packages/domain/src/trial-move.ts.
 *
 * The new computer: the café code → POST /trial/move/start → (waits for the old desk's fresh copy) →
 * POST /trial/move/finish → the café is saved in this browser as THE trial (same cloud id, a new token) and
 * the page reloads into it; the person signs in with their own code (the copy carries the staff and keys).
 *
 * The cash desk (deskMove, started by trial-cloud.ts): asks for a café code on its reports until it has one,
 * shows it to the director, sends a fresh copy when a move asks (the report's answer or the 30-second signal
 * through PostgREST — no Edge Function invocation), and when its token was retired by a move («Касса
 * перенесена на другой компьютер», 410 or the signal 'moved') stops reporting and locks itself read-only.
 * Light (no HUB): the welcome screen and the trial details import it.
 */
import type { TrialCafeCode, TrialMoveFinish, TrialMoveStart, TrialMoveState, TrialReportMoveAnswer, TrialReportMoveFields } from '@bills/domain';
import { isDeskSignal, normalizeCafeCode, TRIAL_MOVE, trialWaiting } from '@bills/domain';
import type { TrialInfo, TrialRecord } from './trial-store.ts';
import { currentTrial, saveTrial } from './trial-store.ts';

const BASE = String(import.meta.env.VITE_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '');
/** The trial functions ('' = no cloud in this build). The same address trial-cloud.ts reports to. */
const TRIAL_URL = BASE ? `${BASE}/functions/v1/trial` : '';
const ANON_KEY = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
/** The cash desk's cheap signal (PostgREST RPC with the public anon key); '' without the key. */
const SIGNAL_URL = BASE && ANON_KEY ? `${BASE}/rest/v1/rpc/trial_desk_signal` : '';

/** Can this build move a cash desk at all (it has the TS cloud)? */
export const MOVE_AVAILABLE = Boolean(TRIAL_URL);

const TIMEOUT_MS = 20_000;
/** The finish brings the whole café (up to 6 MB, 8 MB of base64). */
const FINISH_TIMEOUT_MS = 120_000;

/** A call that reached the cloud and was refused, or did not reach it (status 0, code OFFLINE). */
export class MoveHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A refused answer as a MoveHttpError (its JSON `{error:{code,message}}` when there is one). */
export async function httpError(path: string, res: Response): Promise<MoveHttpError> {
  let code = 'HTTP';
  let message = `trial ${path}: HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    // Not JSON: the status says enough.
  }
  return new MoveHttpError(res.status, code, message);
}

async function call<T>(path: string, init: { method: 'GET' | 'POST'; token?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
  if (!TRIAL_URL) throw new MoveHttpError(0, 'NO_CLOUD', 'В этой сборке нет связи с TS');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${TRIAL_URL}${path}`, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw await httpError(path, res);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof MoveHttpError) throw err;
    throw new MoveHttpError(0, 'OFFLINE', 'Нет связи с TS');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The new computer

/** The typed café code goes in the body (never in the address). */
export const moveStartCall = (code: string): Promise<TrialMoveStart> => call('/move/start', { method: 'POST', body: { code } });
export const moveCheckCall = (ticket: string): Promise<TrialMoveState> => call('/move', { method: 'GET', token: ticket });
export const moveFinishCall = (ticket: string, acceptOlder: boolean): Promise<TrialMoveFinish> =>
  call('/move/finish', { method: 'POST', token: ticket, body: acceptOlder ? { acceptOlder: true } : {}, timeoutMs: FINISH_TIMEOUT_MS });

let haltSaver: (() => void) | null = null;

/** boot.ts: how to stop the running coffee shop from saving (before a moved-in one replaces it). */
export function registerTrialSaverHalt(fn: () => void): void {
  haltSaver = fn;
}

/**
 * The moved café becomes this browser's trial: the copy, the same cloud trial (id, start, terms), the new
 * token, the café code that was typed. No director's code in clear (unless this computer was the café's cash
 * desk before): everyone signs in with the code they had (boot.ts issues none for a moved-in café). A running
 * coffee shop here (moving back onto an old desk) stops
 * saving first, so it cannot overwrite the new record before the reload.
 */
export async function saveMovedTrial(f: TrialMoveFinish, typedCode: string, now = Date.now()): Promise<void> {
  haltSaver?.();
  const cafeCode = normalizeCafeCode(typedCode);
  // Back onto a computer that was this café's cash desk: it still knows the director's code.
  const here = currentTrial();
  const rec: TrialRecord = {
    db: fromBase64(f.snapshot),
    savedAt: now,
    startedAt: f.startedAt,
    venue: f.venue,
    managerName: f.managerName,
    managerKey: here?.cloudId === f.id ? here.managerKey : '',
    cloudId: f.id,
    cloudToken: f.token,
    endsAt: f.endsAt,
    status: f.status,
    ...(f.message ? { message: f.message } : {}),
    ...(cafeCode ? { cafeCode } : {}),
    movedIn: now,
    // The cloud already has this copy: the next goes after the first changes here.
    snapshotAt: now,
  };
  await saveTrial(rec);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// The cash desk

/** What the cash desk's licence should be: a desk that was moved away (or to the cloud) is read-only (as if ended). */
export function movedLicenseView(info: TrialInfo): TrialInfo {
  return info.movedAway !== undefined || info.cloud ? { ...info, status: 'ended' } : info;
}

/** This computer is no longer the cash desk (another one took it over). */
export function trialMovedAway(info: Pick<TrialInfo, 'movedAway'> | null | undefined): boolean {
  return typeof info?.movedAway === 'number';
}

/** How the forced copy went: sent, too big for the cloud (over 6 MB), or no answer. */
export type ForcedCopy = 'sent' | 'too-big' | 'failed';

export interface DeskMoveDeps {
  info: TrialInfo;
  persist(patch: Partial<TrialInfo>): void;
  /** A report right now that carries the copy even if it did not change. */
  reportWithCopy(): Promise<ForcedCopy>;
  /** Has this computer data the cloud's copy lacks (changed since the last copy went)? */
  unsynced(): boolean;
  /** This computer is no longer the cash desk: lock it read-only. */
  onMoved(): void;
  /**
   * The signal said this token was retired: was it a move to another computer ('moved': lock as such) or to the
   * TS cloud ('cloud': the caller already keeps the café's link and locks)? Without it: 'moved'.
   */
  whyMoved?(): Promise<'moved' | 'cloud'>;
}

export interface DeskMove {
  /** Moved away: no more reports, no signal. */
  readonly stopped: boolean;
  /** Extra fields of the next report. */
  fields(): TrialReportMoveFields;
  /** The report's answer: a café code (once), «send a fresh copy». */
  onAnswer(body: unknown): void;
  /** A refused call: true when it said «Касса перенесена» (and the desk is now locked). */
  onError(err: unknown): boolean;
  /** The café moved to the TS cloud: no more reports, no signal (trial-cloud.ts keeps the link and locks). */
  stop(): void;
}

/** What the trial details call on the running cash desk («Перенести кассу…», «Сменить код»). */
export interface DeskMoveApi {
  /** A fresh copy to the cloud right now. */
  sendCopyNow(): Promise<ForcedCopy>;
  /** A new café code (the old one stops working). */
  changeCode(): Promise<string>;
}

let api: DeskMoveApi | null = null;

export function deskMoveApi(): DeskMoveApi | null {
  return api;
}

/** A refused call that means «this token was retired by a move» (a MoveHttpError or trial-cloud.ts's TrialCloudError). */
export function isMovedError(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown } | null;
  return typeof e === 'object' && e !== null && e.status === 410 && e.code === 'TRIAL_MOVED';
}

/** The cash desk's side of moving (trial-cloud.ts starts it with the cloud link). */
export function deskMove(deps: DeskMoveDeps): DeskMove {
  const { info } = deps;
  let stopped = trialMovedAway(info) || Boolean(info.cloud);
  let lastForced = 0;
  let signalTimer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    stopped = true;
    clearInterval(signalTimer);
  };

  const moved = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(signalTimer);
    let unsynced = false;
    try {
      unsynced = deps.unsynced();
    } catch {
      unsynced = false;
    }
    deps.persist({ movedAway: Date.now(), movedUnsynced: unsynced });
    deps.onMoved();
  };

  /** A move waits for this desk's fresh copy: send it (not more often than every 2 minutes). */
  const sendFresh = () => {
    if (stopped || Date.now() - lastForced < TRIAL_MOVE.forcedSnapshotGapMs) return;
    lastForced = Date.now();
    void deps.reportWithCopy();
  };

  const signal = async () => {
    // A request waiting for TS has no copy and no café code yet: nothing to signal about.
    if (stopped || !info.cloudId || !info.cloudToken || !SIGNAL_URL || trialWaiting(info.status)) return;
    try {
      const res = await fetch(SIGNAL_URL, {
        method: 'POST',
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_id: info.cloudId, p_token: info.cloudToken }),
        cache: 'no-store',
      });
      if (!res.ok) return;
      const s: unknown = await res.json();
      if (!isDeskSignal(s)) return;
      if (s === 'snapshot') sendFresh();
      else if (s === 'moved') {
        const why = deps.whyMoved ? await deps.whyMoved().catch(() => 'moved' as const) : 'moved';
        if (why === 'cloud') stop();
        else moved();
      }
    } catch {
      // Off line: the next signal or report will tell.
    }
  };
  if (!stopped && SIGNAL_URL) signalTimer = setInterval(() => void signal(), TRIAL_MOVE.signalEveryMs);

  api = {
    sendCopyNow: async () => {
      if (stopped) return 'failed';
      lastForced = Date.now();
      return deps.reportWithCopy();
    },
    changeCode: async () => {
      if (!info.cloudId || !info.cloudToken) throw new MoveHttpError(0, 'OFFLINE', 'Касса ещё не связалась с TS');
      const r = await call<TrialCafeCode>('/code', { method: 'POST', token: info.cloudToken, body: { id: info.cloudId } });
      const code = normalizeCafeCode(r.cafeCode);
      if (!code) throw new MoveHttpError(0, 'BAD_ANSWER', 'Не получилось. Попробуйте ещё раз');
      deps.persist({ cafeCode: code });
      return code;
    },
  };

  return {
    get stopped() {
      return stopped;
    },
    fields: () => (info.cafeCode ? {} : { needCode: true }),
    onAnswer(body) {
      if (!body || typeof body !== 'object') return;
      const o = body as TrialReportMoveAnswer;
      const code = normalizeCafeCode(o.cafeCode);
      if (code) deps.persist({ cafeCode: code });
      if (o.sendSnapshot === true) sendFresh();
    },
    onError(err) {
      if (!isMovedError(err)) return false;
      moved();
      return true;
    },
    stop,
  };
}

/** The café code of the running cash desk (for the details dialog), or null. */
export function currentCafeCode(): string | null {
  return currentTrial()?.cafeCode ?? null;
}
