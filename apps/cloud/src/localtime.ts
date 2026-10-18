/**
 * Calendar arithmetic in a club's time zone. Days are 'YYYY-MM-DD' strings of
 * the club's local calendar; instants are epoch ms.
 */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localParts(epochMs: number, timeZone: string): LocalParts {
  const out: LocalParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type === 'year') out.year = Number(p.value);
    else if (p.type === 'month') out.month = Number(p.value);
    else if (p.type === 'day') out.day = Number(p.value);
    else if (p.type === 'hour') out.hour = Number(p.value);
    else if (p.type === 'minute') out.minute = Number(p.value);
    else if (p.type === 'second') out.second = Number(p.value);
  }
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local calendar date of an instant. */
export function localDay(epochMs: number, timeZone: string): string {
  const p = localParts(epochMs, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local hour of day 0…23 of an instant. */
export function localHour(epochMs: number, timeZone: string): number {
  return localParts(epochMs, timeZone).hour;
}

function parseDay(day: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Invalid day "${day}", expected YYYY-MM-DD`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function isValidDay(day: string): boolean {
  try {
    const p = parseDay(day);
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
    return d.getUTCFullYear() === p.year && d.getUTCMonth() === p.month - 1 && d.getUTCDate() === p.day;
  } catch {
    return false;
  }
}

/** Calendar day ± n days (no time zone involved). */
export function addDays(day: string, n: number): string {
  const p = parseDay(day);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** First day of the month a day belongs to. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The instant local midnight of `day` happens in the time zone. */
export function dayStart(day: string, timeZone: string): number {
  const p = parseDay(day);
  let guess = Date.UTC(p.year, p.month - 1, p.day);
  // Two passes handle the zone offset and a DST change on that day.
  for (let i = 0; i < 2; i++) {
    const l = localParts(guess, timeZone);
    const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
    const diff = asUtc - Date.UTC(p.year, p.month - 1, p.day);
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

/** Next instant where a new local hour begins. */
export function nextHourStart(epochMs: number, timeZone: string): number {
  const p = localParts(epochMs, timeZone);
  const ms = ((epochMs % 1000) + 1000) % 1000;
  const remaining = (60 - p.minute) * 60_000 - p.second * 1000 - ms;
  return epochMs + Math.max(remaining, 1);
}

/** Splits [from, to) into pieces that each lie in one local hour. */
export function sliceByHour(
  from: number,
  to: number,
  timeZone: string,
  visit: (hour: number, ms: number) => void,
): void {
  let t = from;
  while (t < to) {
    const next = Math.min(nextHourStart(t, timeZone), to);
    visit(localHour(t, timeZone), next - t);
    t = next;
  }
}
