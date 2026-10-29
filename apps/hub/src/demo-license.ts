import type { LicensePayload } from '@bills/domain';
import { DEV_LICENSE_KEY, signLicense } from '@bills/domain';
import { randomUUID } from 'node:crypto';
import type { LicenseService } from './license.ts';

const DAY_MS = 86_400_000;

/**
 * The browser trial (apps/web, VITE_TRIAL=1): the same self-signed license, but counted
 * from the day the trial started, so it runs out after `days` however often the page reloads.
 */
export interface TrialTerms {
  startedAt: number;
  days: number;
  companyName: string;
}

/**
 * Public demo: on every start the HUB signs itself a trial license with the dev
 * key (its private half is in the repo — only a HUB that accepts the dev key
 * trusts it) — "a client on a 7-day trial, 2 branches, every module" — so the
 * manager sees what a license looks like. If this runtime cannot sign (an old
 * browser without Ed25519 in WebCrypto), licenses are switched off instead of
 * leaving the demo read-only. Returns whether a license was installed.
 */
export async function installDemoLicense(license: LicenseService, now: number, trial?: TrialTerms): Promise<boolean> {
  if (!license.enforced) return false;
  try {
    const payload: LicensePayload = {
      v: 1,
      id: randomUUID(),
      companyId: trial ? 'trial-company' : 'demo-company',
      companyName: trial?.companyName ?? 'Демо компания',
      plan: 'trial',
      issuedAt: now,
      validFrom: trial?.startedAt ?? now,
      validUntil: (trial?.startedAt ?? now) + (trial?.days ?? 7) * DAY_MS,
      maxClubs: trial ? 1 : 2,
      maxTables: null,
      maxStaff: null,
      modules: { bar: true, cloud: true, hardware: true },
      hubIds: [license.hubId],
      blocked: false,
    };
    const text = await signLicense(payload, DEV_LICENSE_KEY.privateKey, DEV_LICENSE_KEY.kid);
    await license.install(text, 'cloud', 'demo');
    return true;
  } catch {
    license.disable();
    return false;
  }
}

/** Public keys a demo HUB checks licenses with: the dev key only. */
export const DEMO_LICENSE_KEYS: Readonly<Record<string, string>> = { [DEV_LICENSE_KEY.kid]: DEV_LICENSE_KEY.publicKey };
