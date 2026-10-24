/**
 * «Первые шаги»: which of the seven steps a venue has done. Pure; the page (Start.tsx) loads the
 * numbers from GET /owner/onboarding or, while the cloud has no such route, from the branch list,
 * staff and club reports (onboarding-load.ts). Tested in test/onboarding.test.ts.
 */
import type { BusinessType } from '@bills/domain';

export interface OnboardingClub {
  clubId: string;
  name: string;
  /** null — the cloud did not say (older cloud): treated as billiards for the tariffs step. */
  businessType: BusinessType | null;
  hubConnected: boolean;
  lastSeenAt: number | null;
  /** Active staff, the manager included. */
  staff: number;
  tariffs: number;
  shifts: number;
}

export interface OnboardingView {
  clubs: OnboardingClub[];
  /** 'fallback' — counted in the browser from older routes. */
  source: 'cloud' | 'fallback';
}

export const STEP_IDS = ['created', 'install', 'connect', 'login', 'staff', 'menu', 'shift'] as const;
export type StepId = (typeof STEP_IDS)[number];

/** What only the person can tell: «Уже стоит» on install, «Я вошёл» on the cash register login. */
export interface LocalMarks {
  installed: boolean;
  loggedIn: boolean;
}

export type StepsDone = Record<StepId, boolean>;

export function stepsDone(club: OnboardingClub, marks: LocalMarks): StepsDone {
  const cafe = club.businessType === 'cafe';
  return {
    created: true,
    install: marks.installed || club.hubConnected,
    connect: club.hubConnected,
    login: marks.loggedIn || club.shifts > 0,
    staff: club.staff > 1,
    // A coffee shop fills its menu in the cash register itself: done once the register is connected.
    menu: cafe ? club.hubConnected : club.tariffs > 0,
    shift: club.shifts > 0,
  };
}

/** The first step not done yet, null when all are. */
export function currentStep(done: StepsDone): StepId | null {
  return STEP_IDS.find((id) => !done[id]) ?? null;
}

export function doneCount(done: StepsDone): number {
  return STEP_IDS.filter((id) => done[id]).length;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** The route's answer, tolerant of missing fields; null when it is not the expected shape. */
export function parseOnboarding(raw: unknown): OnboardingClub[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const list = (raw as { clubs?: unknown }).clubs;
  if (!Array.isArray(list)) return null;
  const out: OnboardingClub[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const id = typeof c.clubId === 'string' ? c.clubId : typeof c.id === 'string' ? c.id : null;
    if (!id) continue;
    const lastSeenAt = typeof c.lastSeenAt === 'number' ? c.lastSeenAt : null;
    out.push({
      clubId: id,
      name: typeof c.name === 'string' ? c.name : '',
      businessType: c.businessType === 'cafe' || c.businessType === 'billiards' ? c.businessType : null,
      hubConnected: c.hubConnected === true || lastSeenAt !== null,
      lastSeenAt,
      staff: num(c.staff),
      tariffs: num(c.tariffs),
      shifts: num(c.shifts),
    });
  }
  return out;
}

/** The venue the checklist is about: the first one with something left, else the first. */
export function pickClub(clubs: OnboardingClub[], marksOf: (clubId: string) => LocalMarks, wanted?: string | null): OnboardingClub | null {
  if (wanted) {
    const w = clubs.find((c) => c.clubId === wanted);
    if (w) return w;
  }
  return clubs.find((c) => currentStep(stepsDone(c, marksOf(c.clubId))) !== null) ?? clubs[0] ?? null;
}

// --- marks and «Скрыть» in this browser ----------------------------------------------------

const MARKS = 'ts.start.marks';
const HIDDEN = 'ts.start.hidden';

function readJson(name: string): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(name) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(name: string, v: Record<string, unknown>): void {
  try {
    localStorage.setItem(name, JSON.stringify(v));
  } catch {
    // storage blocked: the step simply stays open
  }
}

export function readMarks(clubId: string): LocalMarks {
  const m = readJson(MARKS)[clubId] as Partial<LocalMarks> | undefined;
  return { installed: m?.installed === true, loggedIn: m?.loggedIn === true };
}

export function setMark(clubId: string, mark: keyof LocalMarks): void {
  const all = readJson(MARKS);
  all[clubId] = { ...readMarks(clubId), [mark]: true };
  writeJson(MARKS, all);
}

/** «Скрыть» is offered once every step is done; the card then stays away for this company. */
export function isChecklistHidden(companyId: string): boolean {
  return readJson(HIDDEN)[companyId] === true;
}

export function hideChecklist(companyId: string): void {
  writeJson(HIDDEN, { ...readJson(HIDDEN), [companyId]: true });
}

/** POST /owner/clubs/:clubId/hub-code: a new connection code; the previous one stops working. */
export interface HubCodeResponse {
  hubId: string;
  apiKey: string;
  cloudUrl: string;
  /** «TS1.…»; older clouds may leave it out — the cabinet then encodes it from the three values. */
  code?: string;
}
