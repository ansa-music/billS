/**
 * «У меня уже есть TS — войти»: the trial coffee shop moves its cash desk to another computer.
 * The café lives in one browser (packages/domain/src/trial.ts); the TS cloud keeps the latest SQLite
 * snapshot the cash desk sent. A move hands that snapshot and a NEW trial token to the new computer
 * and retires the old token, so there is only ever one cash desk.
 *
 *   cash desk (trial token)   POST /trial/report {…, needCode?}  → … + cafeCode? (issued once) + sendSnapshot?
 *                             POST /trial/code   {id}            → TrialCafeCode («Сменить код»)
 *                             rpc trial_desk_signal(id, token)   → 'ok' | 'snapshot' | 'moved' | 'unknown'
 *                                                                   (PostgREST, every 30 s: no Edge invocation)
 *   new computer (no auth)    POST /trial/move/start {code}      → TrialMoveStart (a move ticket, once)
 *   new computer (ticket)     GET  /trial/move                   → TrialMoveState
 *                             POST /trial/move/finish {acceptOlder?} → TrialMoveFinish (snapshot + new token)
 *   old token afterwards      /trial/report, /trial/terms        → 410 TRIAL_MOVED
 *
 * «Код кофейни» is the account-like secret the director types on the new computer: 12 characters of
 * Crockford base32 (60 random bits), shown as K7F3-92QX-M4P8. The cloud keeps only sha256 of it.
 * Pure rules shared by the cloud and the web.
 */
import type { TrialStatus, TrialTerms } from './trial.ts';

/** Crockford base32: no I, L, O, U — nothing to confuse when reading a code aloud or off a screen. */
export const CAFE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Characters of a café code (5 bits each: 60 bits). */
export const CAFE_CODE_LENGTH = 12;
/** Random bytes the cloud draws for one code (64 bits; the top 60 are used). */
export const CAFE_CODE_BYTES = 8;

export const TRIAL_MOVE = {
  /** The old cash desk counts as on line when it reported (or signalled) this recently. */
  onlineMs: 3 * 60_000,
  /** The new computer waits this long for the old cash desk's fresh snapshot (it signals every 30 s). */
  waitFreshMs: 75_000,
  /** …checking this often. */
  pollEveryMs: 3000,
  /** A move ticket works this long after the code was typed. */
  ticketMs: 15 * 60_000,
  /** A «send a fresh copy» request is answered within this time or forgotten. */
  wantedMs: 15 * 60_000,
  /** The cash desk asks «is a move waiting? was I moved?» this often (PostgREST, not an Edge Function). */
  signalEveryMs: 30_000,
  /** The cash desk sends a copy for a move at most this often (one that cannot be sent is not retried in a loop). */
  forcedSnapshotGapMs: 2 * 60_000,
  /** Random bytes of a move ticket (256 bits, base64url). */
  ticketBytes: 32,
} as const;

/** Rate limits of the move calls (per hour). */
export const TRIAL_MOVE_RATE = {
  /** Code attempts from one IP address, right or wrong. */
  startsPerIpHour: 30,
  /** Wrong codes from one IP address before 429. */
  wrongCodesPerIpHour: 10,
  /** Moves started for one trial (a right code). */
  startsPerTrialHour: 10,
  /** Checks of one ticket (every 3 s for 75 s is 25). */
  checksPerTicketHour: 120,
  /** Calls with an unknown ticket from one IP address. */
  badTicketsPerIpHour: 30,
  /** New café codes of one trial (issued or «Сменить код»). */
  codesPerTrialHour: 10,
} as const;

/**
 * When the cash desk sends its snapshot (only when the data changed — the fingerprint decides that).
 * Supabase Free: the copy is one row per trial, overwritten (no growth); uploads are ingress (free) and
 * ride on reports that go anyway, so the Edge invocations stay at ≤ one per 2 minutes per open cash desk.
 */
export const TRIAL_SNAPSHOT = {
  /** Quiet this long after the last change → a report with the copy (instead of waiting up to 30 minutes). */
  quietMs: 2 * 60_000,
  /** While changes keep coming, every regular report (5 minutes) carries a changed copy. */
  busyMs: 5 * 60_000,
  /** While a phone watches (TRIAL_WATCH.snapshotWatchedMs). */
  watchedMs: 60_000,
} as const;

export const TRIAL_MOVED_MESSAGE = 'Касса перенесена на другой компьютер. Здесь можно только смотреть данные.';
export const CAFE_CODE_WRONG_MESSAGE = 'Код кофейни не подходит. Проверьте буквы и цифры — код виден на кассе: «Пробная» → «Код кофейни».';
export const MOVE_SUPERSEDED_MESSAGE = 'Касса уже перенесена на другой компьютер. Если кассой должен стать этот — введите код кофейни ещё раз.';
export const MOVE_EXPIRED_MESSAGE = 'Время вышло. Введите код кофейни ещё раз.';
export const MOVE_NO_SNAPSHOT_MESSAGE =
  'Старый компьютер ещё не отправлял данные в TS. Откройте TS на нём с интернетом и подождите пару минут — или нажмите там «Перенести кассу на другой компьютер».';

/** POST /trial/move/start. */
export interface TrialMoveStartRequest {
  code: string;
}

/** The answer to a right code: a ticket for the next calls and what the cloud has. */
export interface TrialMoveStart {
  ticket: string;
  venue: string;
  /** The old cash desk is on line and was asked for a fresh copy at `requestedAt`: wait for it. */
  wait: boolean;
  requestedAt: number | null;
  /** The latest copy the cloud has (null: none yet — nothing to move). */
  snapshotAt: number | null;
  /** When the old cash desk was last heard from. */
  lastSeenAt: number | null;
}

/** GET /trial/move: has the fresh copy come? */
export interface TrialMoveState {
  venue: string;
  requestedAt: number | null;
  snapshotAt: number | null;
  lastSeenAt: number | null;
  /** The copy is newer than the request. */
  fresh: boolean;
  /** Another computer took the cash desk after this ticket was made: type the code again. */
  superseded: boolean;
}

/** POST /trial/move/finish: `acceptOlder` — take the copy even though it is older than the request. */
export interface TrialMoveFinishRequest {
  acceptOlder?: boolean;
}

/** The new cash desk: the same trial (id, start, terms), its new token and the café's data. */
export interface TrialMoveFinish extends TrialTerms {
  id: string;
  token: string;
  venue: string;
  managerName: string;
  startedAt: number;
  /** base64 SQLite. */
  snapshot: string;
  snapshotAt: number;
}

/** POST /trial/code (and the report's answer once): the café code in clear, shown on the cash desk. */
export interface TrialCafeCode {
  cafeCode: string;
}

/** What the report carries for moving: «I have no café code yet». */
export interface TrialReportMoveFields {
  needCode?: true;
}

/** What the report's answer may add: a new café code (once), «send a fresh copy now». */
export interface TrialReportMoveAnswer {
  cafeCode?: string;
  sendSnapshot?: true;
}

/** The cash desk's signal (rpc trial_desk_signal). */
export type TrialDeskSignal = 'ok' | 'snapshot' | 'moved' | 'unknown';

export function isDeskSignal(v: unknown): v is TrialDeskSignal {
  return v === 'ok' || v === 'snapshot' || v === 'moved' || v === 'unknown';
}

// ---------------------------------------------------------------------------
// The café code

/** A café code from random bytes (CAFE_CODE_BYTES; the cloud draws them): 12 Crockford characters, 60 bits. */
export function cafeCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < CAFE_CODE_BYTES) throw new Error('cafe code: need 8 random bytes');
  let bits = 0n;
  for (let i = 0; i < CAFE_CODE_BYTES; i++) bits = (bits << 8n) | BigInt(bytes[i]!);
  bits >>= 4n; // 64 → 60 bits
  let out = '';
  for (let i = CAFE_CODE_LENGTH - 1; i >= 0; i--) out += CAFE_CODE_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

/** Look-alikes a person may type: O → 0, I and L → 1 (Crockford's own rule). */
const LOOK_ALIKE: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1' };
/** What people put between the groups (or by accident): spaces, dashes, dots, underscores. */
const SEPARATORS = /[\s\-‐-―−._]+/g;

/** The characters of a typed code that count: upper case, look-alikes fixed, separators dropped. */
function codeChars(input: string): string {
  return [...input.toUpperCase().replace(SEPARATORS, '')].map((c) => LOOK_ALIKE[c] ?? c).join('');
}

/**
 * A typed café code as the cloud checks it — `k7f3 92qx-m4p8` → `K7F392QXM4P8` — or null when it cannot
 * be one (wrong length, a letter outside the alphabet such as U).
 */
export function normalizeCafeCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const code = codeChars(input);
  if (code.length !== CAFE_CODE_LENGTH) return null;
  for (const c of code) if (!CAFE_CODE_ALPHABET.includes(c)) return null;
  return code;
}

/** `K7F392QXM4P8` → `K7F3-92QX-M4P8` (a normalised code; anything else is returned as it is). */
export function formatCafeCode(code: string): string {
  return code.length === CAFE_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` : code;
}

/**
 * The input field as the person types: kept characters only (look-alikes fixed, upper case), at most 12,
 * dashes after the 4th and 8th — `k7f392q` → `K7F3-92Q`.
 */
export function formatCafeCodeInput(raw: string): string {
  const chars = [...codeChars(raw)].filter((c) => CAFE_CODE_ALPHABET.includes(c)).slice(0, CAFE_CODE_LENGTH);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4).join(''));
  return groups.join('-');
}

/** What the cloud hashes (sha256) to store and find a code: a prefix keeps it apart from other hashes. */
export function cafeCodeHashInput(code: string): string {
  return `ts-cafe-code:${code}`;
}

// ---------------------------------------------------------------------------
// The cash desk's copies

/**
 * Is it time to send the copy (whether it changed is checked separately, by its fingerprint)?
 * While a phone watches: every minute. Otherwise: 2 minutes after the last change, or with the regular
 * report every 5 minutes while changes keep coming.
 */
export function trialSnapshotDueNow(now: number, s: { lastSnapshotAt: number | null | undefined; lastChangeAt: number | null | undefined; watched: boolean }): boolean {
  const last = s.lastSnapshotAt ?? 0;
  if (s.watched) return now - last >= TRIAL_SNAPSHOT.watchedMs;
  if (now - last >= TRIAL_SNAPSHOT.busyMs) return true;
  const change = s.lastChangeAt;
  return typeof change === 'number' && change > last && now - change >= TRIAL_SNAPSHOT.quietMs;
}

/** The copy came after the request (the old cash desk answered). */
export function moveSnapshotFresh(snapshotAt: number | null | undefined, requestedAt: number | null | undefined): boolean {
  return typeof snapshotAt === 'number' && typeof requestedAt === 'number' && snapshotAt >= requestedAt;
}

// ---------------------------------------------------------------------------
// The new computer's steps (TrialSignIn.tsx), as a pure state machine

export type MoveStep =
  /** Type the café code (with the last error, if any). */
  | { step: 'code'; error: string | null }
  /** The code went to the cloud. */
  | { step: 'checking' }
  /** The old cash desk is on line: waiting for its fresh copy until `until`. */
  | { step: 'waiting'; ticket: string; venue: string; requestedAt: number; snapshotAt: number | null; until: number }
  /** Only an older copy: the person decides (offline — the old computer is not on line; timeout — it did not answer). */
  | { step: 'older'; ticket: string; venue: string; snapshotAt: number; reason: 'offline' | 'timeout' }
  /** Nothing to move yet: the old computer never sent a copy. */
  | { step: 'empty'; venue: string }
  /** Taking the cash desk over (finish). */
  | { step: 'moving'; ticket: string; venue: string; acceptOlder: boolean }
  /** Saving the café in this browser. */
  | { step: 'done'; venue: string; snapshotAt: number };

export type MoveEvent =
  | { type: 'submit' }
  | { type: 'started'; answer: TrialMoveStart; now: number }
  | { type: 'polled'; state: TrialMoveState; now: number }
  | { type: 'tick'; now: number }
  /** «Не ждать»: take the older copy without waiting for the fresh one. */
  | { type: 'stopWaiting' }
  | { type: 'confirmOlder' }
  | { type: 'finished'; snapshotAt: number }
  /** A call was refused or did not reach the cloud: `code` from the cloud ('OFFLINE' when it did not answer). */
  | { type: 'failed'; code: string; message: string }
  | { type: 'back' };

export const MOVE_START: MoveStep = { step: 'code', error: null };

/** The next step of the move on the new computer. Events that do not fit the step change nothing. */
export function moveReducer(s: MoveStep, e: MoveEvent): MoveStep {
  switch (e.type) {
    case 'back':
      return MOVE_START;
    case 'submit':
      return s.step === 'code' ? { step: 'checking' } : s;
    case 'started': {
      if (s.step !== 'checking') return s;
      const a = e.answer;
      if (a.wait && a.requestedAt !== null) {
        if (moveSnapshotFresh(a.snapshotAt, a.requestedAt)) return { step: 'moving', ticket: a.ticket, venue: a.venue, acceptOlder: false };
        return { step: 'waiting', ticket: a.ticket, venue: a.venue, requestedAt: a.requestedAt, snapshotAt: a.snapshotAt, until: e.now + TRIAL_MOVE.waitFreshMs };
      }
      if (a.snapshotAt === null) return { step: 'empty', venue: a.venue };
      return { step: 'older', ticket: a.ticket, venue: a.venue, snapshotAt: a.snapshotAt, reason: 'offline' };
    }
    case 'polled': {
      if (s.step !== 'waiting') return s;
      const st = e.state;
      if (st.superseded) return { step: 'code', error: MOVE_SUPERSEDED_MESSAGE };
      if (st.fresh || moveSnapshotFresh(st.snapshotAt, s.requestedAt)) return { step: 'moving', ticket: s.ticket, venue: s.venue, acceptOlder: false };
      const next = { ...s, snapshotAt: st.snapshotAt };
      return e.now >= s.until ? timedOut(next) : next;
    }
    case 'tick':
      return s.step === 'waiting' && e.now >= s.until ? timedOut(s) : s;
    case 'stopWaiting':
      return s.step === 'waiting' ? timedOut(s) : s;
    case 'confirmOlder':
      return s.step === 'older' ? { step: 'moving', ticket: s.ticket, venue: s.venue, acceptOlder: true } : s;
    case 'finished':
      return s.step === 'moving' ? { step: 'done', venue: s.venue, snapshotAt: e.snapshotAt } : s;
    case 'failed': {
      if (s.step === 'done') return s;
      if (e.code === 'SNAPSHOT_NOT_FOUND' && s.step !== 'code' && s.step !== 'checking') return { step: 'empty', venue: 'venue' in s ? s.venue : '' };
      return { step: 'code', error: moveErrorText(e.code, e.message) };
    }
  }
}

function timedOut(s: Extract<MoveStep, { step: 'waiting' }>): MoveStep {
  if (s.snapshotAt === null) return { step: 'empty', venue: s.venue };
  return { step: 'older', ticket: s.ticket, venue: s.venue, snapshotAt: s.snapshotAt, reason: 'timeout' };
}

/** Plain words for a refused move call. */
export function moveErrorText(code: string, message: string): string {
  switch (code) {
    case 'CAFE_CODE_WRONG':
      return CAFE_CODE_WRONG_MESSAGE;
    case 'RATE_LIMITED':
      return 'Слишком много попыток. Подождите час и попробуйте снова.';
    case 'MOVE_SUPERSEDED':
      return MOVE_SUPERSEDED_MESSAGE;
    case 'MOVE_EXPIRED':
    case 'MOVE_TICKET_INVALID':
      return MOVE_EXPIRED_MESSAGE;
    case 'OFFLINE':
      return 'Нет связи с TS. Проверьте интернет и попробуйте ещё раз.';
    case 'NO_CLOUD':
      return 'В этой версии нет связи с TS. Перенесите данные через «Скачать копию» и «Восстановить из копии».';
    default:
      return message || 'Не получилось. Попробуйте ещё раз.';
  }
}

/** The terms a moved-in computer starts with (the same trial: same end and status). */
export function movedTerms(f: Pick<TrialMoveFinish, 'status' | 'endsAt' | 'message'>): { status: TrialStatus; endsAt: number; message: string | null } {
  return { status: f.status, endsAt: f.endsAt, message: f.message ?? null };
}
