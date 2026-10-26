/**
 * «Онлайн-бронь столов»: the guest's page, #/book/<slug or clubId>. No account. Pick a day
 * (today … +14), how long (1/2/3 h), the table type when the club has several (or «любой»), a free
 * time, name and phone → «Бронь принята — ждём вас в 19:00» with «Добавить в календарь» (.ics).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { BookingAvailability, CreateBookingResponse, TableKind } from '@bills/domain';
import { BOOKING_KIND_LABEL, bookingClock, dayText, durationText, formatPhone, normalizePhone, relativeDayText } from '@bills/domain';
import { BookError, bookErrorField, createBooking, dayChipTitle, dayNumber, downloadIcs, fetchAvailability } from './book.ts';
import './book.css';

type KindChoice = TableKind | 'any';

const KIND_SHORT: Record<TableKind, string> = { pool: 'Пул', russian: 'Русский', snooker: 'Снукер' };

function BallMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="book-ball">
      <circle cx="24" cy="24" r="20" fill="currentColor" />
      <circle cx="24" cy="21" r="8.5" fill="var(--book-ball-face)" />
      <text x="24" y="25.5" textAnchor="middle" fontSize="11" fontWeight="800" fill="currentColor">
        8
      </text>
    </svg>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className="book-done-mark">
      <circle cx="32" cy="32" r="30" fill="currentColor" opacity="0.14" />
      <circle cx="32" cy="32" r="22" fill="currentColor" />
      <path d="M22 33l7 7 14-15" fill="none" stroke="var(--book-on-accent)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BookPage({ refId }: { refId: string }) {
  const [cache, setCache] = useState<Record<string, BookingAvailability>>({});
  const [date, setDate] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(120);
  const [kind, setKind] = useState<KindChoice>('any');
  const [startsAt, setStartsAt] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<BookError | null>(null);
  const [notice, setNotice] = useState<{ text: string; field: 'name' | 'phone' | null } | null>(null);
  const [done, setDone] = useState<CreateBookingResponse | null>(null);

  const load = useCallback(
    async (day: string | null, force = false) => {
      if (day && cache[day] && !force) return cache[day];
      try {
        const res = await fetchAvailability(refId, day);
        setCache((c) => ({ ...c, [res.date]: res }));
        setLoadError(null);
        return res;
      } catch (e) {
        setLoadError(e as BookError);
        return null;
      }
    },
    [refId, cache],
  );

  useEffect(() => {
    void load(null).then((res) => {
      if (res) setDate(res.date);
    });
  }, [refId]);

  useEffect(() => {
    if (date && !cache[date]) void load(date);
  }, [date, cache, load]);

  const first = useMemo(() => Object.values(cache)[0] ?? null, [cache]);
  const avail = date ? (cache[date] ?? null) : null;
  const club = first?.club ?? null;
  const today = first?.days[0] ?? '';

  useEffect(() => {
    if (club) document.title = `Бронь стола — ${club.name}`;
  }, [club]);

  const slots = avail?.slots[String(minutes)]?.[kind] ?? [];
  const chosen = slots.find((s) => s.startsAt === startsAt && s.free) ?? null;
  // A choice that stopped being free (another day, duration, type, or someone booked it) is dropped.
  useEffect(() => {
    if (startsAt !== null && !chosen) setStartsAt(null);
  }, [startsAt, chosen]);

  const nameProblem = tried && !name.trim() ? 'Напишите имя — на него будет бронь' : null;
  const phoneProblem = tried && !normalizePhone(phone) ? 'Проверьте телефон: например, +7 707 123-45-67' : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !avail || !chosen) return;
    setTried(true);
    setNotice(null);
    if (!name.trim() || !normalizePhone(phone)) {
      document.getElementById(!name.trim() ? 'bk-name' : 'bk-phone')?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await createBooking(refId, {
        date: avail.date,
        startsAt: chosen.startsAt,
        minutes,
        kind: kind === 'any' ? null : kind,
        name: name.trim(),
        phone,
        website,
      });
      setDone(res);
      window.scrollTo({ top: 0 });
    } catch (err) {
      const e2 = err as BookError;
      setNotice({ text: e2.message, field: bookErrorField(e2.code) });
      if (e2.code === 'SLOT_TAKEN' || e2.code === 'SLOT_TOO_SOON' || e2.code === 'SLOT_INVALID') {
        setStartsAt(null);
        void load(avail.date, true);
      }
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !first) {
    return (
      <main className="book-page">
        <div className="book-card book-empty">
          <BallMark />
          <h1>Бронь стола</h1>
          <p>{loadError.message}</p>
          {loadError.code === 'OFFLINE' && (
            <button type="button" className="btn btn-primary" onClick={() => void load(null).then((r) => r && setDate(r.date))}>
              Попробовать ещё раз
            </button>
          )}
        </div>
      </main>
    );
  }

  if (!first || !club) {
    return (
      <main className="book-page" aria-busy="true">
        <div className="book-card book-empty">
          <BallMark />
          <p className="muted">Загружаем свободное время…</p>
        </div>
      </main>
    );
  }

  const tz = club.timezone;

  if (done) {
    const time = bookingClock(done.startsAt, tz);
    const end = bookingClock(done.startsAt + done.minutes * 60_000, tz);
    const day = relativeDayText(done.startsAt, first.now, tz);
    return (
      <main className="book-page">
        <section className="book-card book-done" aria-live="polite">
          <CheckMark />
          <h1>Бронь принята — ждём вас в {time}</h1>
          <p className="book-done-club">{done.clubName}</p>
          <dl className="book-done-list">
            <div>
              <dt>Когда</dt>
              <dd>
                {day === 'сегодня' || day === 'завтра' ? `${day[0]!.toUpperCase()}${day.slice(1)}` : day}, {time}–{end}
              </dd>
            </div>
            <div>
              <dt>Сколько</dt>
              <dd>{durationText(done.minutes)}</dd>
            </div>
            <div>
              <dt>Стол</dt>
              <dd>{done.kind ? BOOKING_KIND_LABEL[done.kind] : 'Любой свободный'}</dd>
            </div>
            <div>
              <dt>На имя</dt>
              <dd>{done.guestName}</dd>
            </div>
          </dl>
          <button type="button" className="btn btn-primary book-wide" onClick={() => downloadIcs(done)}>
            Добавить в календарь
          </button>
          <p className="book-note">
            Стол держим 15 минут после начала. Если планы изменятся — позвоните в клуб, чтобы стол достался другим гостям.
          </p>
          <button
            type="button"
            className="link"
            onClick={() => {
              setDone(null);
              setStartsAt(null);
              setTried(false);
              void load(date, true);
            }}
          >
            Забронировать ещё
          </button>
        </section>
      </main>
    );
  }

  const freeCount = slots.filter((s) => s.free).length;

  return (
    <main className="book-page">
      <header className="book-head">
        <BallMark />
        <div>
          <h1>{club.name}</h1>
          <p className="muted">
            Бронь бильярдного стола · с {first.opensAt} до {first.closesAt}
          </p>
        </div>
      </header>

      <form className="book-card book-form" onSubmit={submit} noValidate>
        <fieldset className="book-step">
          <legend>День</legend>
          <div className="book-days" role="radiogroup" aria-label="День">
            {first.days.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={d === date}
                className="book-day"
                onClick={() => {
                  setDate(d);
                  setNotice(null);
                }}
              >
                <span className="book-day-title">{dayChipTitle(d, today)}</span>
                <span className="book-day-num">{dayNumber(d)}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="book-step">
          <legend>Сколько играть</legend>
          <div className="book-seg" role="radiogroup" aria-label="Сколько играть">
            {first.durations.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={m === minutes} onClick={() => setMinutes(m)}>
                {durationText(m)}
              </button>
            ))}
          </div>
        </fieldset>

        {first.kinds.length > 1 && (
          <fieldset className="book-step">
            <legend>Стол</legend>
            <div className="book-seg book-seg-wrap" role="radiogroup" aria-label="Стол">
              {(['any', ...first.kinds] as KindChoice[]).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={k === kind} onClick={() => setKind(k)}>
                  {k === 'any' ? 'Любой' : KIND_SHORT[k]}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="book-step">
          <legend>
            Время {date && <span className="book-legend-note">· {date === today ? 'сегодня' : dayText(date)}</span>}
          </legend>
          {!avail ? (
            <div className="book-times book-times-loading" aria-busy="true">
              {Array.from({ length: 8 }, (_, i) => (
                <span key={i} className="book-time-skel" />
              ))}
            </div>
          ) : slots.length === 0 || freeCount === 0 ? (
            <p className="book-none">
              {slots.length === 0 ? 'На этот день время уже прошло.' : 'Всё время на этот день занято.'} Выберите другой день
              {first.kinds.length > 1 && kind !== 'any' ? ' или «Любой» стол' : ''}.
            </p>
          ) : (
            <div className="book-times" role="radiogroup" aria-label="Время">
              {slots.map((s) => (
                <button
                  key={s.startsAt}
                  type="button"
                  role="radio"
                  className="book-time"
                  aria-checked={s.startsAt === startsAt}
                  disabled={!s.free}
                  title={s.free ? undefined : 'Занято'}
                  onClick={() => {
                    setStartsAt(s.startsAt);
                    setNotice(null);
                  }}
                >
                  {s.time}
                </button>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className="book-step book-contacts">
          <legend>На кого бронь</legend>
          <label className="field">
            <span>Имя</span>
            <input
              id="bk-name"
              autoComplete="given-name"
              maxLength={40}
              placeholder="Аня"
              value={name}
              aria-invalid={nameProblem || notice?.field === 'name' ? true : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {(nameProblem || notice?.field === 'name') && <span className="field-error">{nameProblem ?? notice?.text}</span>}
          </label>
          <label className="field">
            <span>Телефон</span>
            <input
              id="bk-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={20}
              placeholder="+7 707 123-45-67"
              value={phone}
              aria-invalid={phoneProblem || notice?.field === 'phone' ? true : undefined}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => {
                const p = normalizePhone(phone);
                if (p) setPhone(formatPhone(p));
              }}
            />
            {(phoneProblem || notice?.field === 'phone') && <span className="field-error">{phoneProblem ?? notice?.text}</span>}
          </label>
          {/* Honeypot for bots: hidden from people and screen readers. */}
          <input className="book-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} />
          <p className="book-note">Телефон увидит только клуб — чтобы позвонить, если что-то изменится.</p>
        </fieldset>

        {notice && !notice.field && (
          <p className="book-alert" role="alert">
            {notice.text}
          </p>
        )}

        <div className="book-bar">
          <div className="book-bar-what">
            {chosen ? (
              <>
                <strong>
                  {date === today ? 'Сегодня' : dayText(date ?? '')}, {chosen.time}–{bookingClock(chosen.startsAt + minutes * 60_000, tz)}
                </strong>
                <span>
                  {durationText(minutes)} · {kind === 'any' ? 'любой стол' : BOOKING_KIND_LABEL[kind].toLowerCase()}
                </span>
              </>
            ) : (
              <span>Выберите время</span>
            )}
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !chosen}>
            {busy ? 'Бронируем…' : 'Забронировать'}
          </button>
        </div>
      </form>
      <p className="book-foot">Работает на TS</p>
    </main>
  );
}
