import { useCallback, useEffect, useState } from 'react';
import type { Action, Role } from '@bills/domain';
import { can, isRole } from '@bills/domain';

/**
 * Who is using this screen. Until PIN login (stage 3) it is a pick from the
 * staff list, kept in localStorage. The name goes to the HUB as X-Actor —
 * the same key the hall screen uses for its actor field.
 */
export interface CurrentStaff {
  id: string;
  name: string;
  role: Role;
}

const STAFF_KEY = 'bills.staff';
const ACTOR_KEY = 'bills.actor';
const CHANGED = 'bills:staff-changed';

export function readStaff(): CurrentStaff | null {
  try {
    const raw = localStorage.getItem(STAFF_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<CurrentStaff>;
    if (typeof s.id !== 'string' || typeof s.name !== 'string' || !isRole(s.role)) return null;
    return { id: s.id, name: s.name, role: s.role };
  } catch {
    return null;
  }
}

export function writeStaff(staff: CurrentStaff | null): void {
  try {
    if (staff) {
      localStorage.setItem(STAFF_KEY, JSON.stringify(staff));
      localStorage.setItem(ACTOR_KEY, staff.name);
    } else {
      localStorage.removeItem(STAFF_KEY);
    }
  } catch {
    // Storage may be blocked; the choice just will not be remembered.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Name sent to the HUB as X-Actor. */
export function actorName(): string {
  const s = readStaff();
  if (s) return s.name;
  try {
    return localStorage.getItem(ACTOR_KEY) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function useAuth(): {
  staff: CurrentStaff | null;
  role: Role | null;
  can: (action: Action) => boolean;
  login: (staff: CurrentStaff) => void;
  logout: () => void;
} {
  const [staff, setStaff] = useState<CurrentStaff | null>(readStaff);

  useEffect(() => {
    const sync = () => setStaff(readStaff());
    window.addEventListener(CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const login = useCallback((s: CurrentStaff) => writeStaff(s), []);
  const logout = useCallback(() => writeStaff(null), []);
  const role = staff?.role ?? null;
  const allowed = useCallback((action: Action) => can(role, action), [role]);

  return { staff, role, can: allowed, login, logout };
}
