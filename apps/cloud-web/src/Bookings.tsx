/**
 * «Брони» of a venue (#/clubs/:id/bookings, Supabase): online bookings by day with «Подтвердить» /
 * «Отменить», and the settings — on/off, opening hours, the step of start times, how long a late
 * guest's table is held, the public link with a QR code to print or send.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookingSettingsView, OwnerBookingsResponse, OwnerBookingView } from '@bills/domain';
import {
  BOOKING_HOLD_LIMITS,
  BOOKING_KIND_LABEL,
  BOOKING_SLOT_CHOICES,
  BOOKING_STATUS_LABEL,
  bookingClock,
  bookingSettingsProblems,
  capacityKinds,
  dayText,
  durationText,
  formatPhone,
  isBookingActive,
  shiftDay,
  slugify,
  weekdayShort,
  workingDay,
} from '@bills/domain';
import type { CloudRequestError } from './api.ts';
import { fetchBookings, fetchClub, saveBookingSettings, setBookingStatus } from './api.ts';
import { ClubHeader } from './ClubPage.tsx';
import { usePoll } from './hooks.ts';
import { QrImage } from './QrImage.tsx';
import { Section, loadingText } from './shared.tsx';

const DAYS = 15;

const STATUS_TAG: Record<OwnerBookingView['status'], string> = {
  PENDING: 'tag tag-new',
  CONFIRMED: 'tag tag-live',
  CANCELLED: 'tag',
  ARRIVED: 'tag tag-live',
  NO_SHOW: 'tag tag-warn',
};

function errorText(e: unknown): string {
  const err = e as CloudRequestError;
  if (err.code === 'OFFLINE') return 'Нет связи с интернетом — попробуйте ещё раз.';
  return err.message || 'Не получилось — попробуйте ещё раз.';
}

function dayTitle(day: string, today: string): string {
  if (day === today) return 'Сегодня';
  if (day === shiftDay(today, 1)) return 'Завтра';
  return `${weekdayShort(day)}, ${dayText(day)}`;
}

function SettingsPanel({ clubId, settings, onSaved }: { clubId: string; settings: BookingSettingsView; onSaved: () => void }) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  const kinds = capacityKinds(settings.capacity);
  const problems = bookingSettingsProblems({ ...draft, slug: draft.slug || null });
  const changed = (['enabled', 'opensAt', 'closesAt', 'slotMinutes', 'holdMinutes', 'slug'] as const).some((k) => (draft[k] ?? null) !== (settings[k] ?? null));

  async function save(patch: Partial<BookingSettingsView> = {}) {
    const next = { ...draft, ...patch };
    setBusy(true);
    setMessage(null);
    try {
      await saveBookingSettings(clubId, {
        enabled: next.enabled,
        opensAt: next.opensAt,
        closesAt: next.closesAt,
        slotMinutes: next.slotMinutes,
        holdMinutes: next.holdMinutes,
        slug: next.slug || null,
      });
      setMessage({ text: next.enabled ? 'Сохранено. Гости могут бронировать по ссылке.' : 'Сохранено. Онлайн-бронь выключена.', error: false });
      onSaved();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(settings.publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // the link stays selectable on screen
    }
  };

  return (
    <Section title="Онлайн-бронь" aside={<span className={settings.enabled ? 'tag tag-live' : 'tag'}>{settings.enabled ? 'включена' : 'выключена'}</span>}>
      <div className="booking-settings">
        <label className="check booking-switch">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          Гости бронируют столы сами, по ссылке или QR
        </label>
        {kinds.length === 0 && (
          <p className="hint">Столы ещё не пришли из кассы клуба: подключите кассу и добавьте столы — бронь считает свободные столы по ним.</p>
        )}
        <div className="row wrap booking-fields">
          <label className="field">
            <span>Открытие</span>
            <input type="time" value={draft.opensAt} onChange={(e) => setDraft({ ...draft, opensAt: e.target.value })} />
          </label>
          <label className="field">
            <span>Закрытие</span>
            <input type="time" value={draft.closesAt} onChange={(e) => setDraft({ ...draft, closesAt: e.target.value })} />
          </label>
          <label className="field">
            <span>Начало брони каждые</span>
            <select value={draft.slotMinutes} onChange={(e) => setDraft({ ...draft, slotMinutes: Number(e.target.value) })}>
              {BOOKING_SLOT_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m === 60 ? 'час' : `${m} мин`}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Ждать опоздавших, мин</span>
            <input
              type="number"
              min={BOOKING_HOLD_LIMITS[0]}
              max={BOOKING_HOLD_LIMITS[1]}
              value={draft.holdMinutes}
              onChange={(e) => setDraft({ ...draft, holdMinutes: Number(e.target.value) })}
            />
          </label>
        </div>
        <p className="hint">
          Закрытие раньше открытия — значит после полуночи (12:00–02:00). Опоздавший дольше этого времени — «не пришёл», стол снова свободен.
        </p>
        <label className="field">
          <span>Адрес ссылки</span>
          <div className="row booking-slug">
            <span className="muted">…/#/book/</span>
            <input
              value={draft.slug ?? ''}
              placeholder={slugify(settings.publicUrl.split('/book/')[1] ?? '') || 'kiy-almaty'}
              maxLength={40}
              onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() || null })}
            />
          </div>
        </label>
        {problems.length > 0 && <p className="form-error">{problems.join('. ')}</p>}
        {message && <p className={message.error ? 'form-error' : 'hint booking-saved'}>{message.text}</p>}
        <div className="row wrap">
          <button type="button" className="btn btn-primary" disabled={busy || !changed || problems.length > 0} onClick={() => void save()}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>

        <div className="booking-share">
          <QrImage text={settings.publicUrl} alt="QR-код страницы брони" />
          <div className="booking-share-text">
            <strong>Ссылка для гостей</strong>
            <a className="booking-link" href={settings.publicUrl} target="_blank" rel="noreferrer">
              {settings.publicUrl}
            </a>
            <p className="hint">Поставьте ссылку в Instagram, 2ГИС и WhatsApp; QR распечатайте и повесьте у входа.</p>
            <div className="row wrap">
              <button type="button" className="btn btn-small" onClick={() => void copy()}>
                {copied ? 'Скопировано' : 'Скопировать ссылку'}
              </button>
              <button type="button" className="btn btn-small" onClick={() => window.print()}>
                Распечатать QR
              </button>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function BookingRow({ b, timezone, clubId, onChanged }: { b: OwnerBookingView; timezone: string; clubId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'confirm' | 'cancel') => {
    setBusy(true);
    setError(null);
    try {
      await setBookingStatus(clubId, b.id, action);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  };
  return (
    <li className="booking-row" data-status={b.status}>
      <div className="booking-row-time">
        <strong>{bookingClock(b.startsAt, timezone)}</strong>
        <span>до {bookingClock(b.startsAt + b.minutes * 60_000, timezone)}</span>
      </div>
      <div className="booking-row-who">
        <strong>{b.guestName}</strong>
        <span>
          <a href={`tel:${b.phone}`}>{formatPhone(b.phone)}</a> · {durationText(b.minutes)} · {b.kind ? BOOKING_KIND_LABEL[b.kind] : 'любой стол'}
        </span>
        {error && <span className="form-error">{error}</span>}
      </div>
      <span className={STATUS_TAG[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</span>
      {isBookingActive(b.status) && (
        <div className="row booking-row-tools">
          {confirmCancel ? (
            <>
              <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => void act('cancel')}>
                Да, отменить
              </button>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => setConfirmCancel(false)}>
                Нет
              </button>
            </>
          ) : (
            <>
              {b.status === 'PENDING' && (
                <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void act('confirm')}>
                  Подтвердить
                </button>
              )}
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => setConfirmCancel(true)}>
                Отменить
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function BookingsPage({ id }: { id: string }) {
  const loadClub = useCallback(() => fetchClub(id), [id]);
  const club = usePoll(loadClub, 60_000);
  const loadBookings = useCallback(() => fetchBookings(id, null, DAYS), [id]);
  const bookings = usePoll<OwnerBookingsResponse>(loadBookings, 30_000);
  const [day, setDay] = useState<string | null>(null);

  const timezone = bookings.data?.timezone ?? club.data?.club.timezone ?? 'Asia/Almaty';
  const today = workingDay(Date.now(), timezone);
  const byDay = useMemo(() => {
    const m = new Map<string, OwnerBookingView[]>();
    for (const b of bookings.data?.bookings ?? []) {
      const d = workingDay(b.startsAt, timezone);
      m.set(d, [...(m.get(d) ?? []), b]);
    }
    return m;
  }, [bookings.data, timezone]);

  if (!club.data || !bookings.data) {
    return <p className="boot-inline">{loadingText(club.error ?? bookings.error, 'брони')}</p>;
  }
  const days = Array.from({ length: DAYS }, (_, i) => shiftDay(today, i));
  const shown = day ? [day] : days.filter((d) => byDay.has(d));
  const active = (bookings.data.bookings ?? []).filter((b) => isBookingActive(b.status)).length;
  const reload = () => void bookings.reload();

  return (
    <>
      <ClubHeader club={club.data.club} now={Date.now()} tab="bookings" />
      <div className="two-col booking-layout">
        <Section title="Брони" aside={<span className="muted">впереди: {active}</span>}>
          <div className="booking-days" role="tablist" aria-label="День">
            <button type="button" role="tab" aria-selected={day === null} className="booking-day" onClick={() => setDay(null)}>
              Все
            </button>
            {days.map((d) => {
              const n = (byDay.get(d) ?? []).filter((b) => isBookingActive(b.status)).length;
              return (
                <button key={d} type="button" role="tab" aria-selected={day === d} className="booking-day" onClick={() => setDay(d)}>
                  {dayTitle(d, today)}
                  {n > 0 && <span className="booking-day-n">{n}</span>}
                </button>
              );
            })}
          </div>
          {shown.length === 0 || shown.every((d) => !byDay.has(d)) ? (
            <p className="empty">
              {bookings.data.settings.enabled
                ? day
                  ? 'На этот день броней нет'
                  : 'Броней пока нет — поделитесь ссылкой с гостями'
                : 'Онлайн-бронь выключена — включите её справа, и брони появятся здесь'}
            </p>
          ) : (
            shown.map((d) => (
              <div key={d} className="booking-group">
                <h3>{dayTitle(d, today)}</h3>
                <ul className="booking-list">
                  {(byDay.get(d) ?? []).map((b) => (
                    <BookingRow key={b.id} b={b} timezone={timezone} clubId={id} onChanged={reload} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </Section>
        <SettingsPanel clubId={id} settings={bookings.data.settings} onSaved={reload} />
      </div>
    </>
  );
}
