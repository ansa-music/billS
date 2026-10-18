import { useCallback, useEffect, useState } from 'react';
import type { Action, AuthStaff, Role } from '@bills/domain';
import { can, isRole } from '@bills/domain';
import { UNAUTHORIZED_EVENT, command, loginWithKey, setAuthToken } from './api.ts';

/**
 * Who is signed in on this screen. A session comes from an access key
 * (POST /api/auth/login) and lives in localStorage `bills.auth`; its token
 * goes to the HUB as a Bearer header on every request (see api.ts). The name
 * is also copied to `bills.actor`, which the hall screen reads for its actor
 * field.
 */
export interface AuthSession {
  token: string;
  staff: AuthStaff;
  expiresAt: number;
}

const AUTH_KEY = 'bills.auth';
const ACTOR_KEY = 'bills.actor';
const DEVICE_KEY = 'bills.device';
/** Pre-key staff picker (removed); cleared on the next write so old tablets do not keep it around. */
const LEGACY_STAFF_KEY = 'bills.staff';
/** Fired on window whenever the session is written or cleared. */
export const AUTH_CHANGED_EVENT = 'bills:auth-changed';

function parseStaff(value: unknown): AuthStaff | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Partial<AuthStaff>;
  if (typeof s.id !== 'string' || typeof s.name !== 'string' || !isRole(s.role)) return null;
  return {
    id: s.id,
    name: s.name,
    role: s.role,
    clubId: typeof s.clubId === 'string' ? s.clubId : '',
    clubName: typeof s.clubName === 'string' ? s.clubName : '',
  };
}

export function readAuth(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<AuthSession>;
    const staff = parseStaff(a.staff);
    if (typeof a.token !== 'string' || !a.token || !staff) return null;
    // `expiresAt` slides on use, so a stale value is not a reason to drop the session: the HUB decides.
    return { token: a.token, staff, expiresAt: typeof a.expiresAt === 'number' ? a.expiresAt : 0 };
  } catch {
    return null;
  }
}

export function writeAuth(session: AuthSession | null): void {
  setAuthToken(session?.token ?? null);
  try {
    if (session) {
      localStorage.setItem(AUTH_KEY, JSON.stringify(session));
      localStorage.setItem(ACTOR_KEY, session.staff.name);
    } else {
      localStorage.removeItem(AUTH_KEY);
    }
    localStorage.removeItem(LEGACY_STAFF_KEY);
  } catch {
    // Storage may be blocked; the session then lives until the page is reloaded.
  }
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

export function clearAuth(): void {
  writeAuth(null);
}

export function authToken(): string | null {
  return readAuth()?.token ?? null;
}

// The token must be in api.ts before the first request; auth.ts is imported by main.tsx before anything renders.
setAuthToken(readAuth()?.token ?? null);

/** Name sent to the HUB as X-Actor (informational; the session names the actor). */
export function actorName(): string {
  const s = readAuth();
  if (s) return s.staff.name;
  try {
    return localStorage.getItem(ACTOR_KEY) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Free-text name of this tablet, remembered for the next login. */
export function readDevice(): string {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeDevice(device: string): void {
  try {
    if (device) localStorage.setItem(DEVICE_KEY, device);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    // Not remembered, nothing else breaks.
  }
}

/** Signs in with an access key and stores the session. Throws HubRequestError (401 KEY_INVALID) on a bad key. */
export async function login(key: string, device?: string): Promise<AuthStaff> {
  const body = device ? { key, device } : { key };
  const r = await loginWithKey(body);
  writeAuth({ token: r.token, staff: r.staff, expiresAt: r.expiresAt });
  return r.staff;
}

/** Tells the HUB to drop the session (best effort), then forgets it locally. */
export async function logout(): Promise<void> {
  const s = readAuth();
  if (s) {
    try {
      await command('/api/auth/logout', s.staff.name);
    } catch {
      // Offline or already expired: the local session goes away anyway.
    }
  }
  clearAuth();
}

export function useAuth(): {
  staff: AuthStaff | null;
  role: Role | null;
  can: (action: Action) => boolean;
  login: (key: string, device?: string) => Promise<AuthStaff>;
  logout: () => Promise<void>;
} {
  const [session, setSession] = useState<AuthSession | null>(readAuth);

  useEffect(() => {
    const sync = () => {
      const s = readAuth();
      setAuthToken(s?.token ?? null); // another tab may have signed in or out
      setSession(s);
    };
    const unauthorized = () => clearAuth();
    window.addEventListener(AUTH_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
      window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
    };
  }, []);

  const staff = session?.staff ?? null;
  const role = staff?.role ?? null;
  const allowed = useCallback((action: Action) => can(role, action), [role]);

  return { staff, role, can: allowed, login, logout };
}
