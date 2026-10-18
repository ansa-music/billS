import type { TariffConfig } from './tariff.ts';

/**
 * Pauses of a game. A pause is time the guests do not pay for: staff paused the
 * game (reason `pause`) or moved it to another table (reason `transfer`, the
 * time between the old lamp going off and the new one confirming ON).
 */
export type PauseReason = 'pause' | 'transfer';

export interface PauseSpan {
  from: number;
  /** null — still paused. */
  to: number | null;
  reason: PauseReason;
}

/** A span of time that is not billed; `to` is always resolved. */
export interface UnpaidSpan {
  from: number;
  to: number;
}

export type PauseLampMode = 'off' | 'blink';

export interface PauseLimits {
  /** How many times staff may pause one game. */
  maxPauses: number;
  /** Total unpaid pause time per game; a pause running over this is billed as play. */
  maxPauseMinutes: number;
  /** What the lamp does while paused. Transfers always switch the old lamp off. */
  lamp: PauseLampMode;
}

export const DEFAULT_PAUSE_LIMITS: PauseLimits = { maxPauses: 3, maxPauseMinutes: 30, lamp: 'off' };

/** Pause rules of a tariff, with defaults for tariffs saved before pauses existed. */
export function pauseLimits(tariff: Pick<TariffConfig, 'maxPauses' | 'maxPauseMinutes' | 'pauseLamp'>): PauseLimits {
  return {
    maxPauses: tariff.maxPauses ?? DEFAULT_PAUSE_LIMITS.maxPauses,
    maxPauseMinutes: tariff.maxPauseMinutes ?? DEFAULT_PAUSE_LIMITS.maxPauseMinutes,
    lamp: tariff.pauseLamp ?? DEFAULT_PAUSE_LIMITS.lamp,
  };
}

export interface PauseUsage {
  /** Staff pauses taken (transfers do not count). */
  count: number;
  /** Seconds spent in staff pauses so far; an open pause is counted until `now`. */
  seconds: number;
}

export function pauseUsage(pauses: readonly PauseSpan[], now: number): PauseUsage {
  let count = 0;
  let ms = 0;
  for (const p of pauses) {
    if (p.reason !== 'pause') continue;
    count++;
    ms += Math.max(0, (p.to ?? now) - p.from);
  }
  return { count, seconds: Math.floor(ms / 1000) };
}

/** Why a new pause is refused, or null when it is allowed. Messages are shown to staff. */
export function pauseRefusal(pauses: readonly PauseSpan[], tariff: TariffConfig, now: number): string | null {
  const limits = pauseLimits(tariff);
  const used = pauseUsage(pauses, now);
  if (used.count >= limits.maxPauses) {
    return `Лимит пауз исчерпан: по тарифу не больше ${limits.maxPauses} за игру`;
  }
  if (used.seconds >= limits.maxPauseMinutes * 60) {
    return `Лимит времени паузы исчерпан: по тарифу не больше ${limits.maxPauseMinutes} мин за игру`;
  }
  return null;
}

/**
 * The spans of a game that are not billed, up to `end`. Staff pauses share one
 * budget (`maxPauseMinutes`): once it is spent, the rest of a pause is billed as
 * if the game went on. Transfers are never billed. Open pauses end at `end`.
 */
export function unpaidSpans(pauses: readonly PauseSpan[], tariff: TariffConfig, end: number): UnpaidSpan[] {
  const budgetMs = pauseLimits(tariff).maxPauseMinutes * 60_000;
  let leftMs = budgetMs;
  const spans: UnpaidSpan[] = [];
  for (const p of [...pauses].sort((a, b) => a.from - b.from)) {
    const to = Math.min(p.to ?? end, end);
    if (to <= p.from) continue;
    if (p.reason === 'transfer') {
      spans.push({ from: p.from, to });
      continue;
    }
    const take = Math.min(to - p.from, leftMs);
    leftMs -= take;
    if (take > 0) spans.push({ from: p.from, to: p.from + take });
  }
  return spans;
}
