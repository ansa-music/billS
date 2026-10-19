import type { ClubSummary, CloudShiftView } from '@bills/domain';
import { fetchOverview } from './api.ts';
import { formatClock, formatDateTime, localDay } from './format.ts';
import { clubHref, usePoll } from './hooks.ts';
import { AlertList, Difference, HubBadge, Section, StatTile, gamesLabel, loadingText } from './shared.tsx';
import { ShiftsTable } from './Shifts.tsx';
import { LicenseBanner, useCompanyLicense } from './Company.tsx';

function tablesLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'стол'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)
        ? 'стола'
        : 'столов';
  return `${n} ${word}`;
}

function alertsLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'тревога'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)
        ? 'тревоги'
        : 'тревог';
  return `${n} ${word}`;
}

/** «Смена №12 открыта с 10:05, Айгерим» / «Смена закрыта · №11: недостача −300 ₸». */
function ShiftStatus({ club, now }: { club: ClubSummary; now: number }) {
  const open = club.openShift;
  if (open) {
    // A shift opened on another local day shows its date, not only the time.
    const sameDay = localDay(open.openedAt, club.timezone) === localDay(now, club.timezone);
    const since = sameDay ? formatClock(open.openedAt, club.timezone) : formatDateTime(open.openedAt, club.timezone);
    return (
      <p className="shift-status" data-open="">
        <span className="shift-dot" aria-hidden="true" />
        Смена №{open.number} открыта с {since}, {open.openedBy}
      </p>
    );
  }
  const last = club.lastClosedShift;
  if (!last) {
    return <p className="shift-status muted">Смен ещё не было</p>;
  }
  return (
    <p className="shift-status">
      <span className="shift-dot" aria-hidden="true" />
      Смена закрыта
      <span className="muted">
        {' '}
        · №{last.number}
        {last.closedAt !== null ? `, ${formatDateTime(last.closedAt, club.timezone)}` : ''}:
      </span>{' '}
      <Difference value={last.difference} currency={club.currency} />
    </p>
  );
}

function ClubCard({ club, now }: { club: ClubSummary; now: number }) {
  return (
    <a className="club-card" href={clubHref(club.id)} data-problem={club.openAlerts > 0 || undefined}>
      <header className="club-head">
        <div>
          <h2>{club.name}</h2>
          <p className="muted">
            {formatClock(now, club.timezone)} · {club.timezone}
          </p>
        </div>
        <HubBadge hub={club.hub} now={now} />
      </header>
      <div className="stats">
        <StatTile label="Сегодня" stats={club.today} currency={club.currency} compact />
        <StatTile label="7 дней" stats={club.week} currency={club.currency} compact />
        <StatTile label="Месяц" stats={club.month} currency={club.currency} compact />
      </div>
      <ShiftStatus club={club} now={now} />
      <footer className="club-foot">
        <span>{tablesLabel(club.tablesCount)}</span>
        <span data-live={club.liveGames > 0 || undefined}>
          {club.liveGames > 0 ? `сейчас идёт ${gamesLabel(club.liveGames)}` : 'сейчас игр нет'}
        </span>
        <span data-alert={club.openAlerts > 0 || undefined}>
          {club.openAlerts > 0 ? alertsLabel(club.openAlerts) : 'тревог нет'}
        </span>
      </footer>
    </a>
  );
}

export function Overview() {
  const { data, error } = usePoll(fetchOverview, 30_000);
  const lic = useCompanyLicense();

  if (!data) {
    return <p className="boot-inline">{loadingText(error, 'обзор')}</p>;
  }

  const now = data.serverNow;
  const currency = data.clubs[0]?.currency ?? 'KZT';
  const mixedCurrency = data.clubs.some((c) => c.currency !== currency);
  const zones = new Map(data.clubs.map((c) => [c.id, c.timezone]));
  const zoneOf = (s: CloudShiftView) => zones.get(s.clubId) ?? 'UTC';
  const mismatched = data.recentShifts.filter((s) => (s.difference ?? 0) !== 0).length;

  return (
    <>
      <LicenseBanner license={lic.data ? lic.data.license : undefined} />
      <section className="totals" aria-label="Итоги по сети">
        <h2 className="section-title">
          {data.company.name}
          <span className="muted"> · {data.clubs.length} {data.clubs.length === 1 ? 'клуб' : data.clubs.length < 5 ? 'клуба' : 'клубов'}</span>
        </h2>
        {mixedCurrency ? (
          <p className="hint">Клубы работают в разных валютах — итоги по сети показаны в валюте первого клуба.</p>
        ) : null}
        <div className="stats stats-big">
          <StatTile label="Сегодня" stats={data.totals.today} currency={currency} big />
          <StatTile label="Последние 7 дней" stats={data.totals.week} currency={currency} big />
          <StatTile label="С начала месяца" stats={data.totals.month} currency={currency} big />
        </div>
      </section>

      <section className="clubs" aria-label="Клубы">
        {data.clubs.length === 0 && <p className="empty">В компании пока нет клубов</p>}
        {data.clubs.map((club) => (
          <ClubCard key={club.id} club={club} now={now} />
        ))}
      </section>

      <Section
        title="Смены за 7 дней"
        aside={
          <span className="panel-aside">
            {mismatched > 0 && (
              <span className="tag tag-danger" title="Смены, где посчитанная наличность не сошлась с ожидаемой">
                расхождений: {mismatched}
              </span>
            )}
            <span className="panel-total">{data.recentShifts.length}</span>
          </span>
        }
      >
        <ShiftsTable shifts={data.recentShifts} currency={currency} zoneOf={zoneOf} now={now} brief />
      </Section>

      <Section title="Открытые тревоги" aside={<span className="panel-total">{data.alerts.length}</span>}>
        <AlertList alerts={data.alerts} showClub emptyText="Во всех клубах спокойно — открытых тревог нет" />
      </Section>
    </>
  );
}
