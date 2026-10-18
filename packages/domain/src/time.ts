/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface ZonedParts {
  weekday: Weekday;
  /** Minutes since local midnight, 0…1439. */
  minuteOfDay: number;
  second: number;
  millisecond: number;
}

const WEEKDAYS: Record<string, Weekday> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Local wall-clock parts of an instant in the given IANA time zone. */
export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  let weekday: Weekday | undefined;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = WEEKDAYS[p.value];
    else if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'minute') minute = Number(p.value);
    else if (p.type === 'second') second = Number(p.value);
  }
  if (!weekday) throw new Error(`Cannot resolve weekday for ${timeZone}`);
  return {
    weekday,
    minuteOfDay: hour * 60 + minute,
    second,
    millisecond: ((epochMs % 1000) + 1000) % 1000,
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Parses "HH:MM" (00:00…24:00) into minutes since midnight. */
export function parseClock(value: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid time "${value}", expected HH:MM`);
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59 || minutes > 1440) throw new Error(`Invalid time "${value}"`);
  return minutes;
}

export function previousWeekday(day: Weekday): Weekday {
  return (day === 1 ? 7 : day - 1) as Weekday;
}
