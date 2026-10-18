import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEntryView, AuditListResponse } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { Empty, Field, Loading, Page, Section, formatDateTime, localDate } from '../ui.tsx';
import { useHub } from '../useHub.tsx';
import './staff.css';

const DAY = 24 * 60 * 60 * 1000;
const PAGE = 50;

/** Action groups for the filter: a label and the prefixes it covers. */
const GROUPS: Array<{ key: string; label: string; prefixes: string[] }> = [
  { key: '', label: 'все действия', prefixes: [] },
  { key: 'session', label: 'игры', prefixes: ['session.'] },
  { key: 'lamp', label: 'лампы', prefixes: ['lamp.'] },
  { key: 'alert', label: 'тревоги', prefixes: ['alert.'] },
  { key: 'bar', label: 'бар', prefixes: ['order.', 'product.', 'category.'] },
  { key: 'staff', label: 'сотрудники', prefixes: ['staff.'] },
  { key: 'settings', label: 'настройки', prefixes: ['club.', 'table.', 'tariff.'] },
];

const ACTION_LABEL: Record<string, string> = {
  'session.open_requested': 'Открыл стол',
  'session.started': 'Игра началась (лампа подтвердила)',
  'session.stopped': 'Остановил игру',
  'session.cancelled': 'Отменил игру',
  'session.failed': 'Игра не началась (лампа не ответила)',
  'alert.raised': 'Тревога',
  'alert.resolved': 'Принял тревогу',
  'lamp.on': 'Лампа включена',
  'lamp.off': 'Лампа выключена',
  'lamp.failed': 'Лампа не ответила',
  'hub.recovered': 'HUB восстановил состояние после запуска',
  'order.created': 'Добавил заказ',
  'order.cancelled': 'Отменил заказ',
  'product.created': 'Добавил товар',
  'product.updated': 'Изменил товар',
  'category.created': 'Добавил категорию',
  'category.updated': 'Изменил категорию',
  'staff.created': 'Добавил сотрудника',
  'staff.updated': 'Изменил сотрудника',
  'staff.pin_checked': 'Проверка PIN',
  'club.updated': 'Изменил настройки клуба',
  'table.created': 'Добавил стол',
  'table.updated': 'Изменил стол',
  'tables.reordered': 'Поменял порядок столов',
  'tariff.created': 'Добавил тариф',
  'tariff.updated': 'Изменил тариф',
};

const ENTITY_LABEL: Record<string, string> = {
  session: 'игра',
  table: 'стол',
  lamp: 'лампа',
  alert: 'тревога',
  order: 'заказ',
  product: 'товар',
  category: 'категория',
  staff: 'сотрудник',
  club: 'клуб',
  tariff: 'тариф',
  hub: 'HUB',
};

function actionLabel(action: string): { text: string; known: boolean } {
  const known = ACTION_LABEL[action];
  if (known) return { text: known, known: true };
  // lamp.* carries the table and command in the action name sometimes; show the group at least.
  const prefix = action.split('.')[0] ?? '';
  const group = GROUPS.find((g) => g.prefixes.some((p) => p === `${prefix}.`));
  return { text: group ? `${group.label}: ${action}` : action, known: false };
}

interface Filters {
  actor: string;
  tableId: string;
  group: string;
  from: string;
  to: string;
}

/** Everything staff and the HUB did, newest first, with filters and paging. */
export function AuditPage() {
  const { state } = useHub();
  const timeZone = state?.club.timezone ?? 'UTC';
  const tables = state?.tables ?? [];

  const [filters, setFilters] = useState<Filters>(() => ({
    actor: '',
    tableId: '',
    group: '',
    from: '',
    to: '',
  }));
  // Default range: the last 7 club-local days, set once the club's time zone is known.
  const defaulted = useRef(false);
  useEffect(() => {
    if (!state || defaulted.current) return;
    defaulted.current = true;
    const now = state.serverNow;
    setFilters((f) => ({ ...f, from: localDate(now - 6 * DAY, state.club.timezone), to: localDate(now, state.club.timezone) }));
  }, [state]);

  const [entries, setEntries] = useState<AuditEntryView[] | null>(null);
  const [actors, setActors] = useState<string[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestNo = useRef(0);

  const group = GROUPS.find((g) => g.key === filters.group) ?? GROUPS[0]!;

  const buildQuery = useCallback(
    (prefix: string | null, before: number | null): string => {
      const q = new URLSearchParams();
      if (filters.actor) q.set('actor', filters.actor);
      if (filters.tableId) q.set('tableId', filters.tableId);
      if (prefix) q.set('action', prefix);
      if (filters.from) q.set('from', String(dayStart(filters.from, timeZone)));
      if (filters.to) q.set('to', String(dayStart(filters.to, timeZone) + DAY - 1));
      q.set('limit', String(PAGE));
      if (before !== null) q.set('before', String(before));
      return `/api/audit?${q.toString()}`;
    },
    [filters, timeZone],
  );

  /**
   * One request per prefix of the group (the HUB filters by a single prefix);
   * the pages are merged newest first and cut to PAGE entries.
   */
  const fetchPage = useCallback(
    async (before: number | null): Promise<AuditListResponse> => {
      const prefixes = group.prefixes.length ? group.prefixes : [null];
      const results = await Promise.all(prefixes.map((p) => fetchJson<AuditListResponse>(buildQuery(p, before))));
      if (results.length === 1) return results[0]!;
      const merged = results
        .flatMap((r) => r.entries)
        .sort((a, b) => b.id - a.id)
        .slice(0, PAGE);
      const exhausted = results.every((r) => r.nextBefore === null);
      const last = merged[merged.length - 1];
      return {
        entries: merged,
        nextBefore: exhausted && merged.length < PAGE ? null : (last?.id ?? null),
        actors: results[0]?.actors ?? [],
      };
    },
    [group, buildQuery],
  );

  // Reload from the top whenever a filter changes; stale responses are ignored.
  useEffect(() => {
    if (!state) return;
    const no = ++requestNo.current;
    setLoading(true);
    fetchPage(null)
      .then((r) => {
        if (no !== requestNo.current) return;
        setEntries(r.entries);
        setActors(r.actors);
        setNextBefore(r.nextBefore);
        setError(null);
      })
      .catch((e: Error) => {
        if (no !== requestNo.current) return;
        setError(e.message);
      })
      .finally(() => {
        if (no === requestNo.current) setLoading(false);
      });
  }, [fetchPage, state === null]);

  const loadMore = async () => {
    if (nextBefore === null || loading) return;
    const no = ++requestNo.current;
    setLoading(true);
    try {
      const r = await fetchPage(nextBefore);
      if (no !== requestNo.current) return;
      setEntries((prev) => [...(prev ?? []), ...r.entries]);
      setNextBefore(r.nextBefore);
      setError(null);
    } catch (e) {
      if (no === requestNo.current) setError((e as Error).message);
    } finally {
      if (no === requestNo.current) setLoading(false);
    }
  };

  const tableName = useMemo(() => new Map(tables.map((t) => [t.id, t.name])), [tables]);
  const actorOptions = useMemo(
    () => (filters.actor && !actors.includes(filters.actor) ? [filters.actor, ...actors] : actors),
    [actors, filters.actor],
  );
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const reset = () => setFilters({ actor: '', tableId: '', group: '', from: '', to: '' });
  const hasFilters = Boolean(filters.actor || filters.tableId || filters.group || filters.from || filters.to);

  return (
    <Page title="Журнал действий" subtitle="Кто, что и когда сделал. Время — по часам клуба." wide>
      <Section>
        <div className="audit-filters">
          <Field label="Сотрудник">
            <select value={filters.actor} onChange={(e) => set({ actor: e.target.value })}>
              <option value="">все</option>
              {actorOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Стол">
            <select value={filters.tableId} onChange={(e) => set({ tableId: e.target.value })}>
              <option value="">все столы</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Действия">
            <select value={filters.group} onChange={(e) => set({ group: e.target.value })}>
              {GROUPS.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="С">
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          </Field>
          <Field label="По">
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </Field>
          <div className="field field-reset">
            <button type="button" className="btn" onClick={reset} disabled={!hasFilters}>
              Сбросить
            </button>
          </div>
        </div>
      </Section>

      <Section
        title="Записи"
        aside={
          entries && (
            <span className="audit-count">
              {entries.length}
              {nextBefore !== null ? '+' : ''}
            </span>
          )
        }
      >
        {error && <p className="field-error">{error}</p>}
        {!entries && !error && <Loading online={state !== null} />}
        {entries && entries.length === 0 && <Empty>Записей с такими условиями нет</Empty>}
        {entries && entries.length > 0 && (
          <ul className="audit-list">
            {entries.map((e) => (
              <Entry key={e.id} entry={e} timeZone={timeZone} tableName={tableName} />
            ))}
          </ul>
        )}
        <div className="audit-foot">
          {nextBefore !== null && (
            <button type="button" className="btn" onClick={() => void loadMore()} disabled={loading}>
              {loading ? 'Загрузка…' : 'Показать ещё'}
            </button>
          )}
          {nextBefore === null && entries && entries.length > 0 && <span className="audit-count">Это все записи</span>}
        </div>
      </Section>
    </Page>
  );
}

function Entry({
  entry,
  timeZone,
  tableName,
}: {
  entry: AuditEntryView;
  timeZone: string;
  tableName: Map<string, string>;
}) {
  const label = actionLabel(entry.action);
  const dataTable = typeof entry.data.tableId === 'string' ? entry.data.tableId : null;
  const table =
    (dataTable && tableName.get(dataTable)) || (entry.entityType === 'table' ? tableName.get(entry.entityId) : undefined);
  const hasData = Object.keys(entry.data).length > 0;
  const system = entry.actor === 'system';
  return (
    <li>
      <details className="audit-entry">
        <summary>
          <span className="audit-main">
            <span className="audit-actor" data-system={system || undefined}>
              {system ? 'HUB' : entry.actor}
            </span>
            <span className="audit-action" data-raw={label.known ? undefined : ''}>
              {label.text}
            </span>
            {table && <span className="tag tag-muted">{table}</span>}
          </span>
          <time className="audit-time" dateTime={new Date(entry.at).toISOString()}>
            {formatDateTime(entry.at, timeZone)}
          </time>
          <span className="audit-meta">
            <span>
              {ENTITY_LABEL[entry.entityType] ?? entry.entityType} <span className="audit-entity">{shortId(entry.entityId)}</span>
            </span>
            {!label.known && <span className="audit-entity">{entry.action}</span>}
            <span className="audit-more">{hasData ? 'подробнее' : 'без данных'}</span>
          </span>
        </summary>
        <pre className="audit-data">{hasData ? JSON.stringify(entry.data, null, 2) : '{}'}</pre>
      </details>
    </li>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Epoch ms of local midnight of a YYYY-MM-DD in the club's time zone. Takes
 * the UTC midnight as a guess and corrects it by the zone offset at that
 * instant, twice, so a DST change on that day still lands on local midnight.
 */
function dayStart(date: string, timeZone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return 0;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const target = Date.UTC(y, mo - 1, d);
  let guess = target;
  for (let i = 0; i < 2; i++) guess = target - zoneOffset(guess, timeZone);
  return guess;
}

/** Offset of the zone at `epochMs`, in ms (positive east of UTC). */
function zoneOffset(epochMs: number, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(epochMs));
  } catch {
    return 0;
  }
  const v = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}
