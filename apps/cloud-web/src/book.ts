/**
 * «Онлайн-бронь столов», the guest's side (#/book/<slug or clubId>): calls of the public Edge
 * Function `booking` and the words of the page. No account and no supabase-js: plain fetch with
 * the anon key, so the page loads fast on a guest's phone. Pure parts are tested in test/book.test.ts.
 *
 *   GET  {SUPABASE_URL}/functions/v1/booking/<ref>/availability?date=YYYY-MM-DD → BookingAvailability
 *   POST {SUPABASE_URL}/functions/v1/booking/<ref>  CreateBookingRequest → 201 CreateBookingResponse
 */
import type { BookingAvailability, CreateBookingRequest, CreateBookingResponse } from '@bills/domain';
import { bookingIcs } from '@bills/domain';
import { bookErrorText } from './book-words.ts';
import { SUPABASE_MODE, supabaseAnonKey, supabaseUrl } from './config.ts';

export { bookErrorField, bookErrorText, bookRefOf, dayChipTitle, dayNumber } from './book-words.ts';

export class BookError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!SUPABASE_MODE) throw new BookError(404, 'NOT_AVAILABLE', bookErrorText('NOT_AVAILABLE', 404));
  let res: Response;
  try {
    res = await fetch(`${supabaseUrl()}/functions/v1/booking${path}`, {
      method,
      headers: {
        apikey: supabaseAnonKey(),
        authorization: `Bearer ${supabaseAnonKey()}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
    });
  } catch {
    throw new BookError(0, 'OFFLINE', bookErrorText('OFFLINE', 0));
  }
  if (!res.ok) {
    let code = 'HTTP_ERROR';
    let message: string | undefined;
    try {
      const data = (await res.json()) as { error?: { code?: string; message?: string } };
      code = data.error?.code ?? code;
      message = data.error?.message;
    } catch {
      // not JSON
    }
    throw new BookError(res.status, code, bookErrorText(code, res.status, message));
  }
  return (await res.json()) as T;
}

export const fetchAvailability = (ref: string, date: string | null): Promise<BookingAvailability> =>
  call('GET', `/${encodeURIComponent(ref)}/availability${date ? `?date=${date}` : ''}`);

export const createBooking = (ref: string, body: CreateBookingRequest): Promise<CreateBookingResponse> => call('POST', `/${encodeURIComponent(ref)}`, body);

/** Saves the booking as an .ics file the phone opens in its calendar. */
export function downloadIcs(b: CreateBookingResponse): void {
  const text = bookingIcs({ id: b.id, clubName: b.clubName, startsAt: b.startsAt, minutes: b.minutes, guestName: b.guestName, kind: b.kind, createdAt: b.createdAt });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bron-ts.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
