/** Words and small rules of the guest's booking page (book.ts, BookPage.tsx); pure, tested in test/book.test.ts. */
import { shiftDay, weekdayShort } from '@bills/domain';

/** `#/book/<ref>` → ref; null for other routes. */
export function bookRefOf(hash: string): string | null {
  const m = /^#\/book\/([^/?#]+)\/?$/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/** The cloud's refusal in the words of a guest who has never seen TS. */
export function bookErrorText(code: string, status: number, message?: string): string {
  switch (code) {
    case 'BOOKING_NOT_FOUND':
      return 'Онлайн-бронь в этом заведении сейчас не работает. Позвоните в клуб.';
    case 'NOT_AVAILABLE':
      return 'Онлайн-бронь работает только в облаке TS.';
    case 'SLOT_TAKEN':
      return 'Это время только что заняли. Выберите другое — список обновлён.';
    case 'SLOT_TOO_SOON':
      return 'До этого времени меньше 30 минут — позвоните в клуб, вас посадят без брони.';
    case 'RATE_LIMITED':
      return 'Слишком много попыток. Подождите немного или позвоните в клуб.';
    case 'TOO_MANY_BOOKINGS':
      return message ?? 'На этот телефон уже есть несколько броней. Позвоните в клуб.';
    case 'OFFLINE':
      return 'Нет связи с интернетом. Проверьте подключение и попробуйте ещё раз.';
    default:
      if (status >= 500) return 'Сервер не ответил. Попробуйте ещё раз через минуту.';
      return message ?? 'Не получилось забронировать. Попробуйте ещё раз.';
  }
}

/** Which field of the form an error belongs to. */
export function bookErrorField(code: string): 'name' | 'phone' | null {
  if (code === 'NAME_REQUIRED') return 'name';
  if (code === 'PHONE_INVALID') return 'phone';
  return null;
}

/** «Сегодня», «Завтра», else the weekday: the first line of a day chip. */
export function dayChipTitle(day: string, today: string): string {
  if (day === today) return 'Сегодня';
  if (day === shiftDay(today, 1)) return 'Завтра';
  const w = weekdayShort(day);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Day of the month: the big number of a day chip. */
export function dayNumber(day: string): string {
  return String(Number(day.slice(8, 10)));
}

