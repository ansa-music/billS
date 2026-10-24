/**
 * Numbers for «Первые шаги»: GET /owner/onboarding, or — while the cloud has no such route — the
 * same counted in the browser from the venue list, staff and each venue's report.
 */
import type { BranchView, ClubDetails } from '@bills/domain';
import { CloudRequestError, fetchClub, fetchOnboarding, listBranches, listStaff } from './api.ts';
import type { OnboardingClub, OnboardingView } from './onboarding.ts';
import { parseOnboarding } from './onboarding.ts';
import { storedVenueType } from './signup.ts';

/** Venues counted one by one in the fallback: the checklist is about the first few. */
const FALLBACK_LIMIT = 5;

function lastSeen(b: BranchView): number | null {
  const seen = b.hubs.map((h) => h.lastSeenAt ?? 0).reduce((a, x) => Math.max(a, x), 0);
  return seen > 0 ? seen : null;
}

function activeTariffs(d: ClubDetails | null): number {
  if (!d) return 0;
  return d.settings.tariffs.filter((t) => (t as { active?: boolean }).active !== false).length;
}

function shiftCount(d: ClubDetails | null): number {
  if (!d) return 0;
  if (d.shifts.length > 0) return d.shifts.length;
  return d.club.openShift || d.club.lastClosedShift ? 1 : 0;
}

async function fallback(): Promise<OnboardingView> {
  const branches = await listBranches();
  const clubs = await Promise.all(
    branches.slice(0, FALLBACK_LIMIT).map(async (b): Promise<OnboardingClub> => {
      const [staff, details] = await Promise.all([
        listStaff(b.id).catch(() => null),
        fetchClub(b.id).catch(() => null),
      ]);
      const seen = lastSeen(b) ?? details?.club.hub?.lastSeenAt ?? null;
      return {
        clubId: b.id,
        name: b.name,
        businessType: storedVenueType(b.id),
        hubConnected: seen !== null,
        lastSeenAt: seen,
        staff: staff ? staff.filter((s) => s.isActive).length : 0,
        tariffs: activeTariffs(details),
        shifts: shiftCount(details),
      };
    }),
  );
  return { clubs, source: 'fallback' };
}

export async function loadOnboarding(): Promise<OnboardingView> {
  try {
    const clubs = parseOnboarding(await fetchOnboarding());
    if (clubs) {
      return {
        clubs: clubs.map((c) => ({ ...c, businessType: c.businessType ?? storedVenueType(c.clubId) })),
        source: 'cloud',
      };
    }
  } catch (e) {
    const err = e as CloudRequestError;
    // No connection or no session: the fallback would fail the same way.
    if (err.code === 'OFFLINE' || err.status === 401) throw e;
  }
  return fallback();
}
