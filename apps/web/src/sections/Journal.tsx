import { useEffect, useMemo, useState } from 'react';
import type { HubState, JournalCategory, JournalEntry } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { fetchJournal } from '../api.ts';
import { EmptyState, SectionCard } from '../components.tsx';
import { formatClock, formatDay, formatSpan, lampErrorText } from '../format.ts';
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';
import { navigate } from '../router.tsx';
import { useHub, useLive } from '../useHub.tsx';

type Filter = 'all' | JournalCategory;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'games', label: 'Игры' },
  { value: 'lamps', label: 'Свет' },
  { value: 'alerts', label: 'Тревоги' },
  { value: 'bar', label: 'Бар' },
  { value: 'club', label: 'Клуб' },
  { value: 'system', label: 'Система' },
];

interface Described {
  title: string;
  detail?: string;
  icon: IconName;
  cat: JournalCategory;
  bad?: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** Turns an audit record into a sentence a cashier understands. */
function describe(e: JournalEntry, state: HubState): Described {
  const table = state.tables.find((t) => t.id === e.tableId)?.name ?? 'Стол';
  const d = e.data;
  const money = (v: unknown) => formatMoney(num(v), state.club.currency);
  switch (e.action) {
    case 'session.open_requested': {
      const tariff = state.tariffs.find((t) => t.id === d.tariffId)?.name;
      return { title: `${table}: открытие`, detail: `${tariff ? `тариф «${tariff}» · ` : ''}ждём подтверждения лампы`, icon: 'play', cat: 'games' };
    }
    case 'session.started':
      return { title: `${table}: игра началась`, detail: 'лампа подтвердила включение — время пошло', icon: 'play', cat: 'games' };
    case 'session.stopped':
      return {
        title: `${table}: игра остановлена`,
        detail: `${formatSpan(num(d.playedSeconds) * 1000)} · ${money(d.amount)}`,
        icon: 'stop',
        cat: 'games',
      };
    case 'session.cancelled':
      return { title: `${table}: открытие отменено`, detail: 'до включения света, без оплаты', icon: 'close', cat: 'games' };
    case 'session.failed':
      return { title: `${table}: игра не началась`, detail: 'лампа не подтвердила включение', icon: 'alert', cat: 'games', bad: true };
    case 'lamp.on':
      return { title: `${table}: свет включён`, icon: 'lamp', cat: 'lamps' };
    case 'lamp.off':
      return { title: `${table}: свет выключен`, icon: 'lamp', cat: 'lamps' };
    case 'lamp.failed':
      return {
        title: `${table}: лампа не ответила`,
        detail: `${str(d.action) === 'ON' ? 'включение' : 'выключение'} · попыток: ${num(d.attempts)} · ${lampErrorText(str(d.error))}`,
        icon: 'alert',
        cat: 'lamps',
        bad: true,
      };
    case 'alert.raised':
      return { title: 'Тревога', detail: str(d.message), icon: 'bell', cat: 'alerts', bad: true };
    case 'alert.resolved':
      return { title: 'Тревога принята', icon: 'check', cat: 'alerts' };
    case 'hub.recovered':
      return {
        title: 'HUB запущен',
        detail: `лампы сверены: отправлено команд ${num(d.resent)} из ${num(d.tables)}`,
        icon: 'refresh',
        cat: 'system',
      };
    case 'hall.layout_saved':
      return {
        title: 'План зала сохранён',
        detail: `${(num(d.width) / 100).toLocaleString('ru-RU')} × ${(num(d.height) / 100).toLocaleString('ru-RU')} м · столов ${num(d.tables)} · меток ${num(d.landmarks)}`,
        icon: 'plan',
        cat: 'system',
      };
    // Bar and orders
    case 'order.created': {
      const items = Array.isArray(d.items) ? (d.items as Array<{ title?: unknown; qty?: unknown }>) : [];
      const list = items.map((i) => `${str(i.title)} ×${num(i.qty)}`).join(', ');
      return { title: `${table}: заказ из бара`, detail: `${list}${list ? ' · ' : ''}${money(d.total)}`, icon: 'orders', cat: 'bar' };
    }
    case 'order.cancelled':
      return { title: `${table}: заказ отменён`, detail: `${money(d.total)}${str(d.reason) ? ` · ${str(d.reason)}` : ''}`, icon: 'close', cat: 'bar' };
    case 'product.created':
      return { title: `Меню: добавлен товар «${str(d.name)}»`, detail: d.price !== undefined ? money(d.price) : undefined, icon: 'bar', cat: 'bar' };
    case 'product.updated':
      return { title: `Меню: изменён товар «${str(d.name) || str((d.was as Record<string, unknown> | undefined)?.name)}»`, icon: 'bar', cat: 'bar' };
    case 'category.created':
      return { title: `Меню: новая категория «${str(d.name)}»`, icon: 'bar', cat: 'bar' };
    case 'category.updated':
      return { title: `Меню: изменена категория «${str(d.name) || str((d.was as Record<string, unknown> | undefined)?.name)}»`, icon: 'bar', cat: 'bar' };
    // Club settings and staff
    case 'club.updated':
      return { title: 'Настройки клуба изменены', detail: Object.keys(d).join(', '), icon: 'settings', cat: 'club' };
    case 'table.created':
      return { title: `Добавлен стол «${str(d.name)}»`, detail: str(d.kind) ? `тип: ${str(d.kind)}` : undefined, icon: 'hall', cat: 'club' };
    case 'table.updated':
      return { title: `${table}: настройки стола изменены`, detail: Object.keys(d).join(', '), icon: 'hall', cat: 'club' };
    case 'tables.reordered':
      return { title: 'Порядок столов изменён', icon: 'hall', cat: 'club' };
    case 'tariff.created':
      return { title: `Новый тариф «${str(d.name)}»`, icon: 'tariffs', cat: 'club' };
    case 'tariff.updated':
      return { title: `Тариф изменён${str(d.name) ? `: «${str(d.name)}»` : ''}`, detail: Object.keys(d).join(', '), icon: 'tariffs', cat: 'club' };
    case 'staff.created':
      return { title: `Новый сотрудник: ${str(d.name)}`, detail: str(d.role) ? `роль: ${str(d.role)}` : undefined, icon: 'staff', cat: 'club' };
    case 'staff.updated':
      return { title: 'Сотрудник изменён', detail: Object.keys(d).join(', '), icon: 'staff', cat: 'club' };
    case 'staff.pin_checked':
      return { title: d.ok === false ? 'Неверный PIN' : 'Вход по PIN', icon: 'user', cat: 'club', bad: d.ok === false };
    default:
      return { title: e.action, icon: 'journal', cat: 'system' };
  }
}

export function JournalSection({ params }: { params: URLSearchParams }) {
  const hub = useHub();
  const { state } = hub;
  const tz = state.club.timezone;
  const tableId = params.get('table') ?? '';
  const [filter, setFilter] = useState<Filter>('all');
  const [older, setOlder] = useState<JournalEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const query = { limit: 60, ...(filter !== 'all' ? { category: filter } : {}), ...(tableId ? { tableId } : {}) };
  const head = useLive(() => fetchJournal(query), [filter, tableId], hub.version);

  useEffect(() => {
    setOlder([]);
    setNextBefore(null);
  }, [filter, tableId]);
  useEffect(() => {
    if (head.data && older.length === 0) setNextBefore(head.data.nextBefore);
  }, [head.data, older.length]);

  const entries = useMemo(() => {
    const seen = new Set<number>();
    return [...(head.data?.entries ?? []), ...older].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  }, [head.data, older]);

  const loadMore = async () => {
    if (nextBefore === null) return;
    setLoadingMore(true);
    try {
      const page = await fetchJournal({ ...query, before: nextBefore });
      setOlder((o) => [...o, ...page.entries]);
      setNextBefore(page.nextBefore);
    } catch (e) {
      hub.notify((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const groups: Array<{ day: string; items: JournalEntry[] }> = [];
  for (const e of entries) {
    const day = formatDay(e.at, tz);
    const last = groups.at(-1);
    if (last && last.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }

  return (
    <div className="page">
      <p className="page-lead">
        Всё, что происходит в клубе: кто открыл и остановил стол, когда включался свет, тревоги и запуски HUB. Записи не
        удаляются и не меняются.
      </p>
      <SectionCard
        title="Журнал действий"
        actions={
          <select
            className="select"
            aria-label="Стол"
            value={tableId}
            onChange={(e) => navigate('/journal', e.target.value ? { table: e.target.value } : undefined)}
          >
            <option value="">Все столы</option>
            {state.tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        }
      >
        <div className="chips" role="group" aria-label="Что показывать">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" className="filter-chip" aria-pressed={f.value === filter} onClick={() => setFilter(f.value)}>
              {f.label}
            </button>
          ))}
        </div>

        {head.data === null ? (
          <p className="hint">{head.error ?? 'Загрузка…'}</p>
        ) : entries.length === 0 ? (
          <EmptyState icon="journal" title="Записей нет">
            По этому фильтру пока ничего не происходило.
          </EmptyState>
        ) : (
          <ol className="timeline">
            {groups.map((g) => (
              <li key={g.day}>
                <div className="timeline-day">{g.day}</div>
                <ol className="timeline">
                  {g.items.map((e) => {
                    const d = describe(e, state);
                    return (
                      <li key={e.id} className="timeline-item" data-cat={d.cat} data-bad={d.bad || undefined}>
                        <span className="timeline-time">{formatClock(e.at, tz, true)}</span>
                        <span className="timeline-icon" aria-hidden="true">
                          <Icon name={d.icon} size={17} />
                        </span>
                        <div>
                          <p className="timeline-title">{d.title}</p>
                          {d.detail && <p className="timeline-detail">{d.detail}</p>}
                          <p className="timeline-actor">{e.actor === 'system' ? 'Система' : e.actor}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </li>
            ))}
          </ol>
        )}

        {nextBefore !== null && (
          <button type="button" className="btn btn-ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Загрузка…' : 'Показать раньше'}
          </button>
        )}
      </SectionCard>
    </div>
  );
}
