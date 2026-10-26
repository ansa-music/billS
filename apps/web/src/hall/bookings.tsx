import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ArriveBookingResponse, HubBookingsResponse, HubBookingView, TableView } from '@bills/domain';
import { BOOKING_KIND_LABEL, BOOKING_SHOW_BEFORE_MINUTES, bookingConflict, durationText, formatPhone, isBookingActive } from '@bills/domain';
import { command, fetchJson } from '../api.ts';
import { formatClock } from '../format.ts';
import { Icon } from '../icons.tsx';
import { Confirm } from '../ui.tsx';
import { useHub } from '../useHub.tsx';
import './bookings.css';

/**
 * «Онлайн-бронь столов» on the hall (apps/hub/src/bookings.ts). Bookings come from the cloud
 * through the HUB and stay there, so all of this works without internet:
 * - a badge «Бронь 19:00 · Аня» on the table card from an hour before;
 * - «Брони» above the tables: the next bookings with «Гость пришёл» (the HUB picks the table,
 *   the game opens with the normal open flow) and «Не пришёл»;
 * - opening a game on a table booked within the hour asks first (`useOpenGuard`).
 */

// ── Data: one request per change event for every component on screen ─────────

let data: HubBookingsResponse | null = null;
let loadedFor = -1;
let inFlight = false;
let again = false;
const listeners = new Set<() => void>();

function fetchNow(): void {
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = true;
  void fetchJson<HubBookingsResponse>('/api/bookings')
    .then((d) => {
      data = d;
      for (const l of listeners) l();
    })
    .catch(() => {
      // An older HUB without bookings, no access or offline: keep what we had.
    })
    .finally(() => {
      inFlight = false;
      if (again) {
        again = false;
        fetchNow();
      }
    });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Bookings of the hall; refetched on every change event of the HUB (`useHub().version`). */
export function useHallBookings(): HubBookingsResponse | null {
  const { version } = useHub();
  useEffect(() => {
    if (version === loadedFor) return;
    loadedFor = version;
    fetchNow();
  }, [version]);
  return useSyncExternalStore(subscribe, () => data);
}

/** The table a booking is shown on: assigned on arrival, else planned by the HUB. */
const withTable = (b: HubBookingView) => ({ ...b, tableId: b.plannedTableId });

/** The booking to show on a table card now: active, on this table, from an hour before until the hold runs out. */
export function bookingOnTable(list: HubBookingsResponse | null, tableId: string, now: number): HubBookingView | null {
  if (!list) return null;
  const hit = bookingConflict(list.bookings.map(withTable), tableId, now, list.holdMinutes, BOOKING_SHOW_BEFORE_MINUTES);
  return hit ? (list.bookings.find((b) => b.id === hit.id) ?? null) : null;
}

/** «Бронь 19:00 · Аня» on a table card (cards and the drawer). */
export function BookingBadge({ tableId }: { tableId: string }) {
  const hub = useHub();
  const list = useHallBookings();
  const b = bookingOnTable(list, tableId, hub.serverNow);
  if (!b) return null;
  const late = hub.serverNow >= b.startsAt;
  return (
    <span className="booking-badge" data-late={late || undefined} title={`Онлайн-бронь: ${b.guestName}, ${durationText(b.minutes)}`}>
      <Icon name="clock" size={12} /> Бронь {formatClock(b.startsAt, hub.state.club.timezone)} · {b.guestName}
    </span>
  );
}

// ── «Стол забронирован на 19:00 — всё равно открыть?» ───────────────────────

export interface OpenGuard {
  /** Runs `open` at once, or asks first when the table is booked within the hour. */
  guard: (tableId: string, open: () => void) => void;
  dialog: React.ReactNode;
}

export function useOpenGuard(tables: readonly TableView[]): OpenGuard {
  const hub = useHub();
  const list = useHallBookings();
  const [pending, setPending] = useState<{ booking: HubBookingView; tableName: string; open: () => void } | null>(null);
  const guard = (tableId: string, open: () => void) => {
    const hit = list ? bookingConflict(list.bookings.map(withTable), tableId, hub.serverNow, list.holdMinutes) : null;
    const booking = hit ? list?.bookings.find((b) => b.id === hit.id) : undefined;
    if (!booking) return open();
    setPending({ booking, tableName: tables.find((t) => t.id === tableId)?.name ?? 'Стол', open });
  };
  const time = pending ? formatClock(pending.booking.startsAt, hub.state.club.timezone) : '';
  const dialog = (
    <Confirm
      open={pending !== null}
      title={pending ? `${pending.tableName} забронирован на ${time} — всё равно открыть?` : ''}
      text={
        pending
          ? `Бронь: ${pending.booking.guestName}, ${durationText(pending.booking.minutes)}. Если открыть игру сейчас, к ${time} стол может быть занят — гостям по брони достанется другой свободный стол, если он будет.`
          : undefined
      }
      confirmLabel="Всё равно открыть"
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const open = pending?.open;
        setPending(null);
        open?.();
      }}
    />
  );
  return { guard, dialog };
}

// ── «Брони» panel ────────────────────────────────────────────────────────────

/** How far ahead the panel lists bookings. */
const PANEL_AHEAD_MS = 3 * 60 * 60_000;

/**
 * The next bookings: active ones from the hold window back up to three hours ahead, plus the
 * ones that just became «не пришёл» (a late guest may still come). Hidden when there are none.
 */
export function BookingsPanel() {
  const hub = useHub();
  const list = useHallBookings();
  const now = hub.serverNow;
  if (!list) return null;
  const { timezone } = hub.state.club;
  const shown = list.bookings.filter((b) => {
    if (b.startsAt - now > PANEL_AHEAD_MS) return false;
    if (isBookingActive(b.status)) return true;
    return b.status === 'NO_SHOW' && now - b.startsAt < 60 * 60_000;
  });
  const later = list.bookings.filter((b) => isBookingActive(b.status) && b.startsAt - now > PANEL_AHEAD_MS).length;
  if (shown.length === 0) return null;
  const tableName = (id: string | null) => (id ? (hub.state.tables.find((t) => t.id === id)?.name ?? null) : null);

  const arrive = (b: HubBookingView) =>
    void hub.run(`booking:${b.id}`, async () => {
      const res = await command<ArriveBookingResponse>(`/api/bookings/${b.id}/arrive`, hub.actor, {});
      const table = hub.state.tables.find((t) => t.id === res.tableId);
      fetchNow();
      if (table) {
        const opened = await hub.openTable(table.id, table.defaultTariffId);
        hub.notify(opened ? `${table.name}: гость по брони пришёл, игра открыта` : `${table.name}: стол для гостя по брони — откройте игру`);
      }
    });
  const noShow = (b: HubBookingView) =>
    void hub
      .run(`booking:${b.id}`, async () => {
        await command(`/api/bookings/${b.id}/no-show`, hub.actor, {});
        hub.notify(`Бронь ${formatClock(b.startsAt, timezone)} · ${b.guestName}: не пришёл`);
      })
      .finally(fetchNow);

  return (
    <section className="booking-panel" aria-label="Брони">
      <h2>
        <Icon name="clock" size={20} /> Брони <span className="booking-count">{shown.length}</span>
        {later > 0 && <span className="booking-later">позже сегодня и завтра: {later}</span>}
      </h2>
      <ul>
        {shown.map((b) => {
          const busy = hub.isBusy(`booking:${b.id}`) || !hub.online;
          const late = now >= b.startsAt;
          const table = tableName(b.plannedTableId);
          const canOpen = hub.canNow('table.open');
          return (
            <li key={b.id} data-status={b.status}>
              <div className="booking-time" data-late={late || undefined}>
                {formatClock(b.startsAt, timezone)}
              </div>
              <div className="booking-what">
                <strong>
                  {b.guestName} · {durationText(b.minutes)}
                </strong>
                <span>
                  {b.kind ? BOOKING_KIND_LABEL[b.kind] : 'любой стол'}
                  {table ? ` · ${table}` : b.status === 'NO_SHOW' ? '' : ' · свободного стола нет'}
                  {' · '}
                  {b.phone.includes('•') ? b.phone : <a href={`tel:${b.phone}`}>{formatPhone(b.phone)}</a>}
                  {b.status === 'NO_SHOW' ? ' · не пришёл' : late ? ` · опаздывает ${Math.floor((now - b.startsAt) / 60_000)} мин` : ''}
                  {b.status === 'CONFIRMED' && ' · подтверждена'}
                </span>
              </div>
              {canOpen && (
                <div className="booking-tools">
                  <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => arrive(b)}>
                    Гость пришёл
                  </button>
                  {b.status !== 'NO_SHOW' && (
                    <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => noShow(b)}>
                      Не пришёл
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
