import type { Minor } from './money.ts';
import { roundToStep } from './money.ts';
import type { Weekday } from './time.ts';
import { isValidTimeZone, parseClock, previousWeekday, zonedParts } from './time.ts';

/**
 * A price window in local club time. The window belongs to the day it STARTS on:
 * "Fri 22:00–06:00" also covers Saturday 00:00–06:00.
 * `to` <= `from` means the window crosses midnight; "00:00"–"24:00" is the whole day.
 */
export interface TariffWindow {
  label: string;
  days: Weekday[];
  from: string;
  to: string;
  pricePerHour: Minor;
}

export interface TariffConfig {
  /** ISO 4217 code, e.g. "KZT". */
  currency: string;
  /** Price when no window matches. */
  basePricePerHour: Minor;
  /** First matching window wins. */
  windows: TariffWindow[];
  /** Played time is rounded up to this many minutes (1 = per minute). */
  stepMinutes: number;
  /** Billed time is never less than this. */
  minimumMinutes: number;
  /** Games shorter than this are free (mistaken open, cancel). 0 disables it. */
  freeMinutes: number;
  /** Final amount is rounded to a multiple of this many minor units (e.g. 1000 = 10 ₸). */
  roundingMinor: Minor;
}

export interface ChargeSegment {
  from: number;
  to: number;
  label: string;
  pricePerHour: Minor;
}

export interface ChargeResult {
  playedSeconds: number;
  billedSeconds: number;
  amount: Minor;
  segments: ChargeSegment[];
}

const BASE_LABEL = 'Базовый';

interface CompiledWindow {
  window: TariffWindow;
  from: number;
  to: number;
  crossesMidnight: boolean;
}

function compile(windows: TariffWindow[]): CompiledWindow[] {
  return windows.map((window) => {
    const from = parseClock(window.from);
    let to = parseClock(window.to);
    if (to === 0) to = 1440;
    return { window, from: from % 1440, to, crossesMidnight: to <= from };
  });
}

function windowAt(windows: CompiledWindow[], weekday: Weekday, minute: number): TariffWindow | undefined {
  for (const w of windows) {
    if (!w.crossesMidnight) {
      if (w.window.days.includes(weekday) && minute >= w.from && minute < w.to) return w.window;
    } else if (
      (w.window.days.includes(weekday) && minute >= w.from) ||
      (w.window.days.includes(previousWeekday(weekday)) && minute < w.to)
    ) {
      return w.window;
    }
  }
  return undefined;
}

function boundaryMinutes(windows: CompiledWindow[]): number[] {
  const edges = new Set<number>([0]);
  for (const w of windows) {
    edges.add(w.from % 1440);
    edges.add(w.to % 1440);
  }
  return [...edges];
}

/** The rate in force at an instant: shown to staff next to a running game. */
export function priceAt(
  epochMs: number,
  tariff: TariffConfig,
  timeZone: string,
): { label: string; pricePerHour: Minor } {
  const p = zonedParts(epochMs, timeZone);
  const w = windowAt(compile(tariff.windows), p.weekday, p.minuteOfDay);
  return { label: w?.label ?? BASE_LABEL, pricePerHour: w?.pricePerHour ?? tariff.basePricePerHour };
}

/** Billable seconds after free minutes, minimum and step rounding. */
export function billableSeconds(playedSeconds: number, tariff: TariffConfig): number {
  if (playedSeconds <= 0) return 0;
  if (tariff.freeMinutes > 0 && playedSeconds < tariff.freeMinutes * 60) return 0;
  const step = tariff.stepMinutes * 60;
  const rounded = Math.ceil(playedSeconds / step) * step;
  return Math.max(rounded, tariff.minimumMinutes * 60);
}

/**
 * Price of a game from `startMs` to `endMs` (epoch ms) in the club's time zone.
 * Billable time (after rounding and minimum) is priced as if the game continued
 * until start + billable time, so rounded minutes use the rate in force at that moment.
 */
export function calculateCharge(startMs: number, endMs: number, tariff: TariffConfig, timeZone: string): ChargeResult {
  if (endMs < startMs) throw new Error('Game end is before its start');
  const playedSeconds = Math.floor((endMs - startMs) / 1000);
  const billedSeconds = billableSeconds(playedSeconds, tariff);
  if (billedSeconds === 0) return { playedSeconds, billedSeconds, amount: 0, segments: [] };

  const windows = compile(tariff.windows);
  const edges = boundaryMinutes(windows);
  const billedEnd = startMs + billedSeconds * 1000;
  const segments: ChargeSegment[] = [];
  let weighted = 0; // Σ seconds × price per hour

  let t = startMs;
  while (t < billedEnd) {
    const p = zonedParts(t, timeZone);
    const w = windowAt(windows, p.weekday, p.minuteOfDay);
    const label = w?.label ?? BASE_LABEL;
    const price = w?.pricePerHour ?? tariff.basePricePerHour;

    let ahead = 1440;
    for (const e of edges) {
      const d = (e - p.minuteOfDay + 1440) % 1440;
      if (d > 0 && d < ahead) ahead = d;
    }
    let next = t + ahead * 60_000 - p.second * 1000 - p.millisecond;
    // DST: local minutes and real minutes can diverge across a clock change.
    const target = (p.minuteOfDay + ahead) % 1440;
    let diff = target - zonedParts(next, timeZone).minuteOfDay;
    if (diff >= 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    if (diff !== 0 && next + diff * 60_000 > t) next += diff * 60_000;

    const to = Math.min(next, billedEnd);
    const last = segments.at(-1);
    if (last && last.label === label && last.pricePerHour === price) last.to = to;
    else segments.push({ from: t, to, label, pricePerHour: price });
    weighted += ((to - t) / 1000) * price;
    t = to;
  }

  return {
    playedSeconds,
    billedSeconds,
    amount: roundToStep(weighted / 3600, tariff.roundingMinor),
    segments,
  };
}

export function validateTariff(tariff: TariffConfig, timeZone?: string): string[] {
  const errors: string[] = [];
  const isNonNegInt = (n: number) => Number.isInteger(n) && n >= 0;
  if (!/^[A-Z]{3}$/.test(tariff.currency)) errors.push('currency must be an ISO 4217 code');
  if (!isNonNegInt(tariff.basePricePerHour)) errors.push('basePricePerHour must be a non-negative integer');
  if (!Number.isInteger(tariff.stepMinutes) || tariff.stepMinutes < 1) errors.push('stepMinutes must be >= 1');
  if (!isNonNegInt(tariff.minimumMinutes)) errors.push('minimumMinutes must be a non-negative integer');
  if (!isNonNegInt(tariff.freeMinutes)) errors.push('freeMinutes must be a non-negative integer');
  if (!Number.isInteger(tariff.roundingMinor) || tariff.roundingMinor < 1) errors.push('roundingMinor must be >= 1');
  if (timeZone !== undefined && !isValidTimeZone(timeZone)) errors.push(`unknown time zone ${timeZone}`);
  tariff.windows.forEach((w, i) => {
    if (w.days.length === 0 || w.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      errors.push(`windows[${i}].days must be weekdays 1..7`);
    }
    for (const key of ['from', 'to'] as const) {
      try {
        parseClock(w[key]);
      } catch (e) {
        errors.push(`windows[${i}].${key}: ${(e as Error).message}`);
      }
    }
    if (!isNonNegInt(w.pricePerHour)) errors.push(`windows[${i}].pricePerHour must be a non-negative integer`);
  });
  return errors;
}
