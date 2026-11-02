/**
 * The director's code of the browser trial, for the platform owner (packages/domain/src/trial-codes.ts):
 *  - which code works now: the one the page made at the start (TrialInfo.managerKey) while it still signs the
 *    director in; else the newest code the page saw issued to the director in «Сотрудники» (adopted as
 *    «Код директора»); else none — «код мог быть изменён в кассе» (stale). Checked against the in-page HUB's
 *    access_keys exactly as a sign-in would be (not revoked, not expired, the person active, a manager);
 *  - TS's new code (`directorKeyNext` in a report's answer): installed for the director, every other key of the
 *    director revoked, so only the new one works — or refused when another person of the café has those digits.
 * Never logs a code; codes go to the cloud only inside the report's body (trial-cloud.ts).
 */
import type { DirectorKeyCheck, TrialReportCodes } from '@bills/domain';
import { directorKeyDecision, isDirectorKey, rememberSeenKey } from '@bills/domain';
import { keyHashOf } from '@ts-hub/auth.ts';
import type { Hub } from '@ts-hub/hub.ts';
import type { DatabaseSync } from './shims/sqlite.ts';
import type { TrialInfo } from './trial-store.ts';

/** The label of a code TS issued remotely («Выдать новый код директора»), as «Сотрудники» lists it. */
const TS_KEY_LABEL = 'Код от TS';
const ISSUE_PATH = /^\/api\/staff\/([^/?]+)\/keys\/?(?:\?|$)/;

interface StaffRow {
  id: string;
  name: string;
  role: string;
  roles: string;
  is_active: number;
}

function rolesOf(row: Pick<StaffRow, 'role' | 'roles'>): string[] {
  try {
    const parsed: unknown = JSON.parse(row.roles);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed.map(String);
  } catch {
    // the single role below
  }
  return [row.role];
}

export interface TrialDirector {
  /** The director part of the report's codes, after adopting a working code / marking it stale (saved). */
  codes(): Pick<TrialReportCodes, 'directorKey' | 'directorKeyStale'>;
  /** Looks again (a staff change: a key issued or revoked). */
  check(): void;
  /** The page's own request went through the HUB: a key issued to the director is remembered. */
  noted(req: { method?: string | undefined; url: string }, res: { statusCode: number; body: string }): void;
  /** TS's new director's code: installed (every other key of the director revoked), or refused. */
  install(key: string): 'installed' | 'refused';
}

export function trialDirector(deps: { db: DatabaseSync; hub: Hub; info: TrialInfo; persist(patch: Partial<TrialInfo>): unknown }): TrialDirector {
  const { db, hub, info } = deps;

  const hashesOf = (key: string): string[] => {
    const k = key.trim();
    if (!k) return [];
    return /^\d+$/.test(k) ? hub.auth.shortKeyHashes(k) : [keyHashOf(k, '')];
  };

  /** The key's row and its person, when the key exists here at all. */
  const keyRow = (key: string) => {
    for (const h of hashesOf(key)) {
      const row = db
        .prepare(
          `SELECT k.id AS key_id, k.staff_id, k.revoked_at, k.expires_at, s.name, s.role, s.roles, s.is_active
             FROM access_keys k JOIN staff s ON s.id = k.staff_id WHERE k.key_hash = ?`,
        )
        .get(h);
      if (row) return row as { key_id: string; staff_id: string; revoked_at: number | null; expires_at: number | null } & Omit<StaffRow, 'id'>;
    }
    return null;
  };

  /** Does this key sign the director in now (as login() would let it)? */
  const works = (key: string): boolean => {
    const row = keyRow(key);
    if (!row) return false;
    const now = Date.now();
    return row.revoked_at === null && (row.expires_at === null || row.expires_at > now) && row.is_active === 1 && rolesOf(row).includes('manager');
  };

  /** The director: the person whose code the page knows (if still an active manager), else the first active manager. */
  const directorId = (): string | null => {
    const known = info.managerKey ? keyRow(info.managerKey) : null;
    if (known && known.is_active === 1 && rolesOf(known).includes('manager')) return known.staff_id;
    const people = db.prepare('SELECT id, name, role, roles, is_active FROM staff WHERE is_active = 1 ORDER BY created_at, name').all() as unknown as StaffRow[];
    return people.find((p) => rolesOf(p).includes('manager'))?.id ?? null;
  };

  const decide = () => {
    const known: DirectorKeyCheck | null = info.managerKey ? { key: info.managerKey, works: works(info.managerKey) } : null;
    const seen = (info.directorKeysSeen ?? []).filter((k) => k !== info.managerKey).map((key) => ({ key, works: works(key) }));
    const d = directorKeyDecision(known, seen);
    const patch: Partial<TrialInfo> = {};
    if (d.keep && d.keep !== info.managerKey) {
      patch.managerKey = d.keep;
      patch.directorKeysSeen = (info.directorKeysSeen ?? []).filter((k) => k !== d.keep);
    }
    if (d.stale !== Boolean(info.directorKeyStale)) patch.directorKeyStale = d.stale || undefined;
    if (Object.keys(patch).length) void deps.persist(patch);
    return d.report;
  };

  const safely = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      console.warn('[trial] the director’s code could not be checked', err instanceof Error ? err.message : 'error');
      return fallback;
    }
  };

  return {
    codes: () => safely(decide, {}),
    check: () => void safely(decide, {}),
    noted(req, res) {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST' || res.statusCode !== 201) return;
      const m = ISSUE_PATH.exec(req.url);
      if (!m) return;
      safely(() => {
        const staffId = decodeURIComponent(m[1]!);
        if (staffId !== directorId()) return;
        const key = (JSON.parse(res.body) as { key?: unknown }).key;
        if (typeof key !== 'string' || !key) return;
        void deps.persist({ directorKeysSeen: rememberSeenKey(info.directorKeysSeen, key) });
        decide();
      }, undefined);
    },
    install(key) {
      return safely((): 'installed' | 'refused' => {
        if (!isDirectorKey(key)) return 'refused';
        const id = directorId();
        if (!id) return 'refused';
        const director = db.prepare('SELECT id, name, role, roles, is_active FROM staff WHERE id = ?').get(id) as unknown as StaffRow | undefined;
        if (!director) return 'refused';
        const roles = rolesOf(director);
        const actor = { id: director.id, name: director.name, role: roles.includes('manager') ? 'manager' : director.role, roles };
        const existing = keyRow(key);
        if (existing && existing.staff_id !== id) return 'refused';
        if (!existing) {
          // Six digits nobody here has (revoked keys count): the director's own fixed key.
          if (hub.auth.shortKeyTaken(key)) return 'refused';
          hub.auth.issueFixedKeys([{ roles, name: director.name, key }]);
          const issued = keyRow(key);
          if (!issued) return 'refused';
          if (issued.staff_id !== id) {
            // Another person with the same name got it: take it back and ask TS for other digits.
            hub.auth.revokeKey(issued.key_id, { id: issued.staff_id, name: issued.name, role: issued.role, roles: rolesOf(issued) });
            return 'refused';
          }
        } else if (existing.revoked_at !== null) {
          return 'refused';
        }
        const own = keyRow(key)!;
        db.prepare('UPDATE access_keys SET label = ? WHERE id = ?').run(TS_KEY_LABEL, own.key_id);
        // «Код директора» is the new code before the old ones go (a staff change re-checks at once).
        void deps.persist({ managerKey: key, directorKeyStale: undefined, directorKeyRefused: undefined });
        // Only the new code works now: every other key of the director (and its sessions) is revoked.
        const others = db.prepare('SELECT id FROM access_keys WHERE staff_id = ? AND revoked_at IS NULL AND id <> ?').all(id, own.key_id);
        for (const o of others) hub.auth.revokeKey(String(o.id), actor);
        return 'installed';
      }, 'refused');
    },
  };
}
