import type { ClubSummary } from '@bills/domain';
import { fetchOverview } from './api.ts';
import { formatClock } from './format.ts';
import { clubHref, usePoll } from './hooks.ts';
import { AlertList, HubBadge, Section, StatTile, gamesLabel, loadingText } from './shared.tsx';

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
        <StatTile label="Сегодня" stats={club.today} currency={club.currency} />
        <StatTile label="7 дней" stats={club.week} currency={club.currency} />
        <StatTile label="Месяц" stats={club.month} currency={club.currency} />
      </div>
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

  if (!data) {
    return <p className="boot-inline">{loadingText(error, 'обзор')}</p>;
  }

  const now = data.serverNow;
  const currency = data.clubs[0]?.currency ?? 'KZT';
  const mixedCurrency = data.clubs.some((c) => c.currency !== currency);

  return (
    <>
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

      <Section title="Открытые тревоги" aside={<span className="panel-total">{data.alerts.length}</span>}>
        <AlertList alerts={data.alerts} showClub emptyText="Во всех клубах спокойно — открытых тревог нет" />
      </Section>
    </>
  );
}
