/** Words and small rules of the owner's phone page (trial-view.ts, TrialViewPage.tsx); pure, tested in test/trial-view.test.ts. */
import type { TrialSummary } from '@bills/domain';
import { formatMoney } from '@bills/domain';

/** The page refreshes this often (the cash register reports every 5 minutes). */
export const VIEW_REFRESH_MS = 60_000;

/** `#/v/<token>` → token; null for other routes. */
export function viewTokenOf(hash: string): string | null {
  const m = /^#\/v\/([A-Za-z0-9_-]{16,100})\/?$/.exec(hash);
  return m ? m[1]! : null;
}

/** The cloud's refusal in the owner's words. */
export function viewErrorText(code: string, status: number): string {
  switch (code) {
    case 'VIEW_NOT_FOUND':
      return 'Ссылка не работает: её выключили или заменили новой. Новую ссылку можно взять на кассе: «Настройки» → «Облако и перенос».';
    case 'RATE_LIMITED':
      return 'Слишком часто. Обновите страницу через несколько минут.';
    case 'OFFLINE':
      return 'Нет связи с интернетом. Проверьте подключение.';
    case 'NOT_AVAILABLE':
      return 'Эта страница работает только в облаке TS.';
    default:
      return status >= 500 ? 'Сервер не ответил. Попробуйте через минуту.' : 'Не получилось загрузить цифры. Попробуйте ещё раз.';
  }
}

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}

/** «обновлено только что» / «обновлено 5 минут назад» / «обновлено 3 часа назад» / «обновлено 2 дня назад». */
export function updatedText(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'обновлено только что';
  if (minutes < 60) return `обновлено ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `обновлено ${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
  const days = Math.floor(hours / 24);
  return `обновлено ${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
}

/** The numbers are old: the cash register has not reported for a while (closed, or no internet). */
export function isStale(at: number, now: number): boolean {
  return now - at > 30 * 60_000;
}

export function checksText(n: number): string {
  return `${n} ${plural(n, 'чек', 'чека', 'чеков')}`;
}

export function viewMoney(minor: number, currency: string): string {
  return formatMoney(minor, currency || 'KZT');
}

export const METHOD_LABEL: Record<keyof TrialSummary['methodsToday'], string> = { cash: 'Наличные', card: 'Карта', qr: 'QR' };

/** «последний заказ в 14:25» / «последний заказ вчера» / «заказов не было». */
export function lastActivityText(at: number | null, now: number, timeZone: string): string {
  if (at === null) return 'заказов ещё не было';
  const day = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }).format(at);
  if (day(at) === day(now)) return `последний заказ в ${time}`;
  if (day(at) === day(now - 86_400_000)) return `последний заказ вчера в ${time}`;
  return `последний заказ ${new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long' }).format(at)}`;
}

/** «пн» … «вс» of a YYYY-MM-DD. */
export function weekdayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}
