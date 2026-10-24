import { useCallback, useEffect, useState } from 'react';
import type { HubSetupRequest, HubSetupResponse, HubSetupStatus, RosterPerson, RosterResponse } from '@bills/domain';
import { extractHubSetupCode } from '@bills/domain';
import { hubUrl } from '../api.ts';

/**
 * First start of a club: the HUB is not connected to the cabinet yet. The web app asks
 * GET /api/setup/status (LAN only, apps/hub http/routes/setup.ts) before the login page and,
 * while the wizard is open, shows «Подключите кассу к кабинету» (Connect.tsx) instead. Any other
 * answer — configured, demo, off, a 403 from outside the club network, an older HUB or the
 * in-browser demo without the route — means the normal login.
 */

/** The cabinet where a club registers and gets its connection code. */
export const CABINET_URL = 'https://ts-cabinet.pages.dev';
export const SIGNUP_URL = `${CABINET_URL}/#/signup`;

/** How long the login waits for the setup check before showing itself anyway. */
const CHECK_TIMEOUT_MS = 4000;

/** GET /api/setup/status; null when the HUB does not offer the wizard to this screen (or is unreachable). */
export async function fetchSetupStatus(timeoutMs = CHECK_TIMEOUT_MS): Promise<HubSetupStatus | null> {
  try {
    const res = await fetch(hubUrl('/api/setup/status'), { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<HubSetupStatus>;
    return typeof body.state === 'string' ? (body as HubSetupStatus) : null;
  } catch {
    return null;
  }
}

export type SetupGate = 'checking' | 'connect' | 'login';

/**
 * Whether the screen should show the connect page. Asked once per page load while nobody is
 * signed in (`active`); `dismiss` goes on to the login (after connecting, or «войти без подключения»).
 */
export function useSetupGate(active: boolean): { gate: SetupGate; dismiss: () => void } {
  const [gate, setGate] = useState<SetupGate>(active ? 'checking' : 'login');
  useEffect(() => {
    if (!active || gate !== 'checking') return;
    let alive = true;
    void fetchSetupStatus().then((st) => {
      if (alive) setGate(st?.open ? 'connect' : 'login');
    });
    return () => {
      alive = false;
    };
  }, [active, gate]);
  const dismiss = useCallback(() => setGate('login'), []);
  return { gate: active ? gate : 'login', dismiss };
}

/** A connection code that came in the address: `#code=TS1.…` (the cabinet's link) or `#/…?code=…`. */
export function codeFromLocation(hash: string = window.location.hash): string {
  if (!/[#?&]code=/i.test(hash)) return '';
  return extractHubSetupCode(hash);
}

/** An error of POST /api/setup with what the screen needs to explain it. */
export class SetupError extends Error {
  readonly code: string;
  readonly status: number;
  /** The cloud could not be reached: the HUB may save without the check. */
  readonly canSkip: boolean;
  readonly field: string | null;

  constructor(status: number, code: string, message: string, canSkip = false, field: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.canSkip = canSkip;
    this.field = field;
  }
}

/** POST /api/setup (same-origin JSON). Throws SetupError. */
export async function saveSetup(body: HubSetupRequest): Promise<HubSetupResponse> {
  let res: Response;
  try {
    res = await fetch(hubUrl('/api/setup'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SetupError(0, 'OFFLINE', 'Нет связи с программой TS на этом компьютере. Проверьте, что она запущена, и попробуйте ещё раз.');
  }
  const json = (await res.json().catch(() => null)) as
    | (HubSetupResponse & { error?: undefined })
    | { error?: { code?: string; message?: string; canSkip?: boolean; field?: string } }
    | null;
  if (res.ok && json && !json.error) return json as HubSetupResponse;
  const e = json?.error ?? {};
  throw new SetupError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? `Ошибка ${res.status}`, e.canSkip === true, e.field ?? null);
}

/**
 * Plain words for what went wrong while connecting; the HUB's own text where it already is
 * plain (a broken code, a lamp board address).
 */
export function setupErrorText(err: SetupError): string {
  switch (err.code) {
    case 'CLOUD_UNREACHABLE':
      return 'Не получилось связаться с кабинетом. Проверьте, что этот компьютер подключён к интернету (кабель от роутера или Wi-Fi), и нажмите «Подключить» ещё раз.';
    case 'CLOUD_KEY_INVALID':
      return 'Кабинет не узнал этот код. Скопируйте код в кабинете ещё раз. Если вы нажимали «Новый код», нужен самый последний.';
    case 'CLOUD_HUB_MISMATCH':
      return 'Код скопирован не полностью или от другого заведения. Скопируйте его в кабинете ещё раз целиком.';
    case 'CLOUD_NOT_TS':
      return 'Код ведёт не в кабинет TS. Скопируйте код подключения в кабинете ещё раз.';
    case 'SETUP_LAN_ONLY':
      return 'Подключить кассу можно только из сети заведения: подключите это устройство к Wi-Fi заведения и откройте страницу снова.';
    case 'SETUP_DISABLED':
      return 'Подключение к кабинету выключено на этом компьютере. Обратитесь в поддержку TS.';
    case 'SETUP_BUSY':
      return 'Подождите — касса уже подключается.';
    default:
      return err.message;
  }
}

/** Polls the HUB after saving: true once it came back connected (it restarts to apply the code). */
export async function waitUntilConnected(signal: AbortSignal, timeoutMs = 90_000, everyMs = 1500): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < until) {
    await new Promise((r) => setTimeout(r, everyMs));
    if (signal.aborted) break;
    const st = await fetchSetupStatus(3000);
    if (st && st.state === 'configured') return true;
  }
  return false;
}

/**
 * GET /api/auth/roster: people to pick on «Кто на смене?» — empty when switched off or nobody has
 * a six-digit key yet, also on an older HUB without the route (404); null when the HUB is unreachable.
 */
export async function fetchRoster(): Promise<RosterPerson[] | null> {
  try {
    const res = await fetch(hubUrl('/api/auth/roster'), { cache: 'no-store' });
    if (!res.ok) return res.status === 404 ? [] : null;
    const body = (await res.json()) as Partial<RosterResponse>;
    return Array.isArray(body.people) ? body.people : [];
  } catch {
    return null;
  }
}
