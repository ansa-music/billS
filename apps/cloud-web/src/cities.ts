/**
 * «Город» instead of a time zone, «Валюта» by name instead of a code: the signup form and the
 * new-venue form show cities, the cloud gets the time zone. All of Kazakhstan has lived on
 * UTC+5 since March 2024; the zones still differ by name, and tzdata keeps them right.
 */

export interface City {
  /** Stable id for the select's value. */
  id: string;
  /** What the person sees. */
  name: string;
  /** The time zone the cloud and the cash register use. */
  timezone: string;
  /** The usual money of that country. */
  currency: CurrencyCode;
  country: 'KZ' | 'KG' | 'UZ' | 'RU';
}

export type CurrencyCode = 'KZT' | 'RUB' | 'UZS' | 'KGS' | 'USD';

export const CURRENCIES: ReadonlyArray<{ code: CurrencyCode; name: string }> = [
  { code: 'KZT', name: 'Тенге (₸)' },
  { code: 'RUB', name: 'Рубли (₽)' },
  { code: 'UZS', name: 'Сумы (сўм)' },
  { code: 'KGS', name: 'Сомы (сом)' },
  { code: 'USD', name: 'Доллары ($)' },
];

export const COUNTRY_NAME: Record<City['country'], string> = {
  KZ: 'Казахстан',
  KG: 'Кыргызстан',
  UZ: 'Узбекистан',
  RU: 'Россия',
};

export const CITIES: readonly City[] = [
  { id: 'almaty', name: 'Алматы', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'astana', name: 'Астана', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'shymkent', name: 'Шымкент', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'karaganda', name: 'Караганда', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'aktobe', name: 'Актобе', timezone: 'Asia/Aqtobe', currency: 'KZT', country: 'KZ' },
  { id: 'taraz', name: 'Тараз', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'pavlodar', name: 'Павлодар', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'oskemen', name: 'Усть-Каменогорск', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'semey', name: 'Семей', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'atyrau', name: 'Атырау', timezone: 'Asia/Atyrau', currency: 'KZT', country: 'KZ' },
  { id: 'kostanay', name: 'Костанай', timezone: 'Asia/Qostanay', currency: 'KZT', country: 'KZ' },
  { id: 'kyzylorda', name: 'Кызылорда', timezone: 'Asia/Qyzylorda', currency: 'KZT', country: 'KZ' },
  { id: 'oral', name: 'Уральск', timezone: 'Asia/Oral', currency: 'KZT', country: 'KZ' },
  { id: 'petropavl', name: 'Петропавловск', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'aktau', name: 'Актау', timezone: 'Asia/Aqtau', currency: 'KZT', country: 'KZ' },
  { id: 'turkistan', name: 'Туркестан', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'taldykorgan', name: 'Талдыкорган', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'kokshetau', name: 'Кокшетау', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'ekibastuz', name: 'Экибастуз', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'zhezkazgan', name: 'Жезказган', timezone: 'Asia/Almaty', currency: 'KZT', country: 'KZ' },
  { id: 'bishkek', name: 'Бишкек', timezone: 'Asia/Bishkek', currency: 'KGS', country: 'KG' },
  { id: 'osh', name: 'Ош', timezone: 'Asia/Bishkek', currency: 'KGS', country: 'KG' },
  { id: 'tashkent', name: 'Ташкент', timezone: 'Asia/Tashkent', currency: 'UZS', country: 'UZ' },
  { id: 'samarkand', name: 'Самарканд', timezone: 'Asia/Samarkand', currency: 'UZS', country: 'UZ' },
  { id: 'moscow', name: 'Москва', timezone: 'Europe/Moscow', currency: 'RUB', country: 'RU' },
  { id: 'yekaterinburg', name: 'Екатеринбург', timezone: 'Asia/Yekaterinburg', currency: 'RUB', country: 'RU' },
  { id: 'omsk', name: 'Омск', timezone: 'Asia/Omsk', currency: 'RUB', country: 'RU' },
  { id: 'novosibirsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk', currency: 'RUB', country: 'RU' },
];

export const DEFAULT_CITY_ID = 'almaty';

export function cityById(id: string): City {
  return CITIES.find((c) => c.id === id) ?? (CITIES[0] as City);
}

/** The time zone for the city picked in a form (unknown ids → Алматы). */
export function cityTimezone(id: string): string {
  return cityById(id).timezone;
}

/** The first city on that zone — to preselect the form or to name a venue's zone. */
export function cityByTimezone(timezone: string): City | null {
  return CITIES.find((c) => c.timezone === timezone) ?? null;
}

/** Cities grouped by country for an <optgroup> select, the country order as in CITIES. */
export function citiesByCountry(): Array<{ country: City['country']; label: string; cities: City[] }> {
  const groups: Array<{ country: City['country']; label: string; cities: City[] }> = [];
  for (const c of CITIES) {
    let g = groups.find((x) => x.country === c.country);
    if (!g) {
      g = { country: c.country, label: COUNTRY_NAME[c.country], cities: [] };
      groups.push(g);
    }
    g.cities.push(c);
  }
  return groups;
}

/** «UTC+5» for a zone right now; null when the runtime does not know it. */
export function utcOffsetLabel(timezone: string, at: number = Date.now()): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /^GMT([+-]\d{1,2}(?::\d{2})?)?$/.exec(name);
    if (!m) return null;
    return m[1] && !/^[+-]0(?::00)?$/.test(m[1]) ? `UTC${m[1]}` : 'UTC';
  } catch {
    return null;
  }
}

/**
 * A venue's time in plain words for cards and lists: the city when the zone is one of ours
 * («Алматы»), otherwise the offset («UTC+3»), never the zone's code.
 */
export function zoneLabel(timezone: string): string {
  const city = cityByTimezone(timezone);
  if (city) return `время ${cityGenitive(city)}`;
  return utcOffsetLabel(timezone) ?? 'местное время';
}

const GENITIVE: Record<string, string> = {
  aktobe: 'Актобе',
  atyrau: 'Атырау',
  kostanay: 'Костаная',
  kyzylorda: 'Кызылорды',
  oral: 'Уральска',
  aktau: 'Актау',
  bishkek: 'Бишкека',
  tashkent: 'Ташкента',
  samarkand: 'Самарканда',
  moscow: 'Москвы',
  yekaterinburg: 'Екатеринбурга',
  omsk: 'Омска',
  novosibirsk: 'Новосибирска',
};

function cityGenitive(city: City): string {
  return GENITIVE[city.id] ?? city.name;
}

export function currencyName(code: string): string {
  return CURRENCIES.find((c) => c.code === code)?.name ?? code;
}
