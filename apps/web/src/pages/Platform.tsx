import { useState } from 'react';
import type { ReactNode } from 'react';
import { formatMoney } from '@bills/domain';
import { Modal, Page, Section, formatDateTime } from '../ui.tsx';
import { useHub, useServerNow } from '../useHub.tsx';
import { plural } from './owner/Charts.tsx';
import './owner.css';

/**
 * Platform super-admin mock (stage 8): what our support will see across all
 * companies. Everything below is invented except the real club of this HUB.
 * No backend yet; the buttons only explain that.
 */

type Plan = 'Старт' | 'Сеть';
type SubscriptionStatus = 'active' | 'expiring' | 'overdue';
type HubStatus = 'online' | 'offline';

interface MockClub {
  name: string;
  city: string;
  tables: number;
  hub: HubStatus;
  /** How long ago the HUB last reported, minutes. */
  lastSeenMinutesAgo: number;
  version: string;
}

interface MockCompany {
  id: string;
  name: string;
  contact: { name: string; phone: string };
  subscription: { plan: Plan; status: SubscriptionStatus; paidUntil: string; monthlyPrice: number };
  clubs: MockClub[];
}

const CURRENCY = 'KZT';

const SUBSCRIPTION_LABEL: Record<SubscriptionStatus, { text: string; tag: string }> = {
  active: { text: 'Активна', tag: 'tag tag-ok' },
  expiring: { text: 'Истекает', tag: 'tag tag-warn' },
  overdue: { text: 'Просрочена', tag: 'tag tag-danger' },
};

/** Invented companies; the first one takes the real club of this HUB. */
const MOCK_COMPANIES: MockCompany[] = [
  {
    id: 'demo',
    name: 'Демо компания',
    contact: { name: 'Асель Владелец', phone: '+7 701 000-00-01' },
    subscription: { plan: 'Старт', status: 'active', paidUntil: '2026-11-30', monthlyPrice: 25_000_00 },
    clubs: [{ name: 'Клуб «Демо»', city: 'Алматы', tables: 6, hub: 'online', lastSeenMinutesAgo: 0, version: '0.1.0' }],
  },
  {
    id: 'eight',
    name: 'ТОО «Восьмёрка»',
    contact: { name: 'Бауыржан Сейтказы', phone: '+7 702 000-00-02' },
    subscription: { plan: 'Сеть', status: 'expiring', paidUntil: '2026-10-25', monthlyPrice: 60_000_00 },
    clubs: [
      { name: '«Восьмёрка» на Абая', city: 'Алматы', tables: 12, hub: 'online', lastSeenMinutesAgo: 1, version: '0.1.0' },
      { name: '«Восьмёрка» Astana', city: 'Астана', tables: 8, hub: 'offline', lastSeenMinutesAgo: 190, version: '0.0.9' },
      { name: '«Восьмёрка» Шымкент', city: 'Шымкент', tables: 10, hub: 'online', lastSeenMinutesAgo: 3, version: '0.1.0' },
    ],
  },
  {
    id: 'pyramid',
    name: 'ИП «Пирамида»',
    contact: { name: 'Гульнара Ахметова', phone: '+7 705 000-00-03' },
    subscription: { plan: 'Старт', status: 'overdue', paidUntil: '2026-09-30', monthlyPrice: 25_000_00 },
    clubs: [{ name: 'Пирамида', city: 'Караганда', tables: 5, hub: 'offline', lastSeenMinutesAgo: 60 * 24 * 3, version: '0.0.8' }],
  },
];

export function PlatformPage() {
  const { state } = useHub();
  const serverNow = useServerNow(30_000);
  const tz = state?.club.timezone ?? 'Asia/Almaty';
  const [open, setOpen] = useState<Set<string>>(() => new Set(['demo']));
  const [modal, setModal] = useState<{ title: string; text: ReactNode } | null>(null);

  // The first company is this HUB's real club; the rest is a mock.
  const companies: MockCompany[] = MOCK_COMPANIES.map((c, i) =>
    i === 0 && state
      ? {
          ...c,
          clubs: [
            { ...c.clubs[0]!, name: state.club.name, tables: state.tables.length, hub: 'online', lastSeenMinutesAgo: 0 },
          ],
        }
      : c,
  );

  const clubCount = companies.reduce((s, c) => s + c.clubs.length, 0);
  const tableCount = companies.reduce((s, c) => s + c.clubs.reduce((t, k) => t + k.tables, 0), 0);
  const mrr = companies.filter((c) => c.subscription.status !== 'overdue').reduce((s, c) => s + c.subscription.monthlyPrice, 0);
  const offline = companies.reduce((s, c) => s + c.clubs.filter((k) => k.hub === 'offline').length, 0);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const stage8 = (title: string) =>
    setModal({
      title,
      text: (
        <>
          <p>Это макет этапа 8: платформа, подписки и подключение компаний появятся вместе с облаком.</p>
          <p className="muted">Сейчас HUB обслуживает один клуб и ничего не отправляет наружу.</p>
        </>
      ),
    });

  return (
    <Page
      title="Платформа"
      wide
      subtitle="Все компании и их клубы: HUB'ы, подписки, контакты."
      actions={
        <button type="button" className="btn btn-small btn-primary" onClick={() => stage8('Подключить компанию')}>
          Подключить компанию
        </button>
      }
    >
      <p className="platform-banner" role="note">
        Макет — этап 8. Данные ненастоящие.
      </p>

      <div className="stats">
        <Tile label="Компаний" value={String(companies.length)} />
        <Tile label="Клубов" value={String(clubCount)} note={offline > 0 ? `${offline} HUB офлайн` : 'все HUB на связи'} tone={offline > 0 ? 'danger' : undefined} />
        <Tile label="Столов" value={String(tableCount)} />
        <Tile label="MRR" value={formatMoney(mrr, CURRENCY)} note="активные подписки в месяц" />
      </div>

      {companies.map((c) => {
        const sub = SUBSCRIPTION_LABEL[c.subscription.status];
        const expanded = open.has(c.id);
        return (
          <Section
            key={c.id}
            title={
              <span className="company-title">
                {c.name}
                <span className={sub.tag}>{sub.text}</span>
                <span className="tag tag-muted">{c.subscription.plan}</span>
              </span>
            }
            aside={
              <div className="company-actions">
                <button type="button" className="btn btn-small" onClick={() => stage8('Продлить подписку')}>
                  Продлить подписку
                </button>
                <button type="button" className="btn btn-small btn-ghost" aria-expanded={expanded} onClick={() => toggle(c.id)}>
                  {expanded ? 'Скрыть клубы' : `Клубы (${c.clubs.length})`}
                </button>
              </div>
            }
          >
            <div className="company-head">
              <div className="company-meta">
                <span>
                  Тариф <strong>{c.subscription.plan}</strong> · {formatMoney(c.subscription.monthlyPrice, CURRENCY)} в месяц
                </span>
                <span>
                  Оплачено до <strong>{formatDay(c.subscription.paidUntil)}</strong>
                </span>
              </div>
              <div className="company-meta">
                <span>
                  Контакт: <strong>{c.contact.name}</strong>
                </span>
                <span>{c.contact.phone}</span>
              </div>
              <div className="company-meta">
                <span>
                  {c.clubs.length} {plural(c.clubs.length, ['клуб', 'клуба', 'клубов'])} ·{' '}
                  {c.clubs.reduce((s, k) => s + k.tables, 0)} {plural(c.clubs.reduce((s, k) => s + k.tables, 0), ['стол', 'стола', 'столов'])}
                </span>
              </div>
            </div>
            {expanded && (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Клуб</th>
                      <th>Город</th>
                      <th className="num">Столов</th>
                      <th>HUB</th>
                      <th>Версия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.clubs.map((k) => (
                      <tr key={k.name} data-inactive={k.hub === 'offline' ? '' : undefined}>
                        <td>{k.name}</td>
                        <td>{k.city}</td>
                        <td className="num">{k.tables}</td>
                        <td>
                          <span className="hub-status" data-online={k.hub === 'online' ? '' : undefined}>
                            {k.hub === 'online' ? 'На связи' : `Офлайн с ${formatDateTime(serverNow - k.lastSeenMinutesAgo * 60_000, tz)}`}
                          </span>
                        </td>
                        <td>{k.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        );
      })}

      <Modal open={modal !== null} title={modal?.title ?? ''} onClose={() => setModal(null)}>
        {modal?.text}
        <div className="row wrap modal-actions">
          <button type="button" className="btn btn-primary" onClick={() => setModal(null)}>
            Понятно
          </button>
        </div>
      </Modal>
    </Page>
  );
}

function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'danger' }) {
  return (
    <div className="stat" data-danger={tone === 'danger' ? '' : undefined}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

function formatDay(date: string): string {
  const [y = '', m = '', d = ''] = date.split('-');
  return `${d}.${m}.${y}`;
}
