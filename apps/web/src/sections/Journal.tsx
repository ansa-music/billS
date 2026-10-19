import { useEffect, useMemo, useState } from 'react';
import type { HubState, JournalCategory, JournalEntry } from '@bills/domain';
import { formatMoney, ROLE_LABEL } from '@bills/domain';
import type { Role } from '@bills/domain';
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
  { value: 'money', label: 'Касса' },
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
const METHOD_WORD: Record<string, string> = { CASH: 'наличные', CARD: 'карта', QR: 'QR' };
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
    // Games: pauses, transfers, prepaid time, settling
    case 'session.paused':
      return { title: `${table}: пауза`, detail: d.reason === 'power' ? 'отключение света' : undefined, icon: 'clock', cat: 'games' };
    case 'session.resume_requested':
      return { title: `${table}: продолжить`, detail: d.manual ? 'ручной режим — время пошло сразу' : 'ждём подтверждения лампы', icon: 'play', cat: 'games' };
    case 'session.resumed':
      return { title: `${table}: игра продолжена`, icon: 'play', cat: 'games' };
    case 'session.resume_failed':
      return { title: `${table}: не удалось продолжить`, detail: 'лампа не подтвердила включение', icon: 'alert', cat: 'games', bad: true };
    case 'session.transferred': {
      const to = state.tables.find((t) => t.id === d.toTableId)?.name ?? 'другой стол';
      const from = state.tables.find((t) => t.id === d.fromTableId)?.name ?? table;
      return { title: `${from} → ${to}: игра перенесена`, icon: 'refresh', cat: 'games' };
    }
    case 'session.prepaid':
      return { title: `${table}: время на ${num(d.minutes)} мин`, detail: 'HUB сам остановит игру', icon: 'clock', cat: 'games' };
    case 'session.prepaid_warning':
      return { title: `${table}: скоро конец оплаченного времени`, detail: 'лампа мигнула', icon: 'clock', cat: 'games' };
    case 'session.prepaid_ended':
      return { title: `${table}: оплаченное время вышло`, detail: d.minutes ? `${num(d.minutes)} мин` : undefined, icon: 'stop', cat: 'games' };
    case 'session.prepaid_deadline_shifted':
      return { title: `${table}: конец оплаченного времени сдвинут`, icon: 'clock', cat: 'games' };
    case 'session.closed':
      return { title: `${table}: игра оплачена`, detail: d.prepaid ? 'предоплата' : undefined, icon: 'check', cat: 'games' };
    case 'session.voided':
      return {
        title: `${table}: игра отменена`,
        detail: [money(d.amount), str(d.reason), str(d.approvedBy) && `подтвердил ${str(d.approvedBy)}`].filter(Boolean).join(' · '),
        icon: 'close',
        cat: 'games',
        bad: true,
      };
    // Money: checks, payments, shifts
    case 'check.created':
      return { title: `Счёт №${num(d.number)} создан`, detail: d.prepaid ? 'предоплата' : undefined, icon: 'checks', cat: 'money' };
    case 'check.item_added':
      return { title: 'В счёт добавлена строка', detail: d.amount !== undefined ? money(d.amount) : undefined, icon: 'checks', cat: 'money' };
    case 'check.item_removed':
      return { title: 'Строка убрана из счёта', detail: d.amount !== undefined ? money(d.amount) : undefined, icon: 'checks', cat: 'money' };
    case 'check.discount_set':
      return {
        title: 'Скидка на счёт',
        detail: `${d.kind === 'PERCENT' ? `${num(d.value)}%` : money(d.value)} = ${money(d.amount)}${str(d.reason) ? ` · ${str(d.reason)}` : ''}`,
        icon: 'checks',
        cat: 'money',
      };
    case 'check.discount_removed':
      return { title: 'Скидка убрана', icon: 'checks', cat: 'money' };
    case 'check.paid':
      return {
        title: `Счёт №${num(d.number)} оплачен`,
        detail: `${money(d.total)}${num(d.discount) ? ` · скидка ${money(d.discount)}` : ''}`,
        icon: 'check',
        cat: 'money',
      };
    case 'check.voided':
      return { title: 'Счёт аннулирован', detail: 'в нём не осталось строк', icon: 'close', cat: 'money' };
    case 'payment.accepted': {
      // `parts` are what went into the check per method (cash net of change); `applied` is their sum.
      const applied = Array.isArray(d.parts) ? (d.parts as Array<{ method?: unknown; amount?: unknown }>) : [];
      const how = applied.map((p) => `${METHOD_WORD[str(p.method)] ?? str(p.method)} ${money(p.amount)}`).join(' + ');
      return {
        title: `Оплата по счёту №${num(d.number)}`,
        detail: `${how}${num(d.change) ? ` · сдача ${money(d.change)}` : ''}${num(d.remaining) ? ` · осталось ${money(d.remaining)}` : ''}`,
        icon: 'checks',
        cat: 'money',
      };
    }
    case 'payment.refunded':
      return {
        title: `Возврат по счёту №${num(d.number)}`,
        detail: `${METHOD_WORD[str(d.method)] ?? str(d.method)} ${money(d.amount)} · ${str(d.reason)}${str(d.approvedBy) ? ` · подтвердил ${str(d.approvedBy)}` : ''}`,
        icon: 'close',
        cat: 'money',
        bad: true,
      };
    case 'shift.opened':
      return { title: `Смена №${num(d.number)} открыта`, detail: `размен ${money(d.openingFloat)}`, icon: 'checks', cat: 'money' };
    case 'shift.closed':
      return {
        title: `Смена №${num(d.number)} закрыта`,
        detail: `в кассе ${money(d.countedCash)}${num(d.difference) ? ` · расхождение ${money(d.difference)}` : ' · без расхождений'}`,
        icon: 'checks',
        cat: 'money',
        bad: num(d.difference) !== 0,
      };
    case 'shift.cash_deposited':
      return { title: 'Внесение в кассу', detail: `${money(d.amount)}${str(d.reason) ? ` · ${str(d.reason)}` : ''}`, icon: 'checks', cat: 'money' };
    case 'shift.cash_withdrawn':
      return { title: 'Изъятие из кассы', detail: `${money(d.amount)}${str(d.reason) ? ` · ${str(d.reason)}` : ''}`, icon: 'checks', cat: 'money' };
    case 'order.closed':
      return { title: `${table}: заказ оплачен в счёте`, detail: money(d.total), icon: 'orders', cat: 'bar' };
    // Access
    case 'auth.login':
      return {
        title: 'Вход по ключу',
        detail: [str(d.prefix) && `ключ ${str(d.prefix)}…`, str(d.device)].filter(Boolean).join(' · ') || undefined,
        icon: 'user',
        cat: 'club',
      };
    case 'auth.logout':
      return { title: 'Выход', icon: 'logout', cat: 'club' };
    case 'key.issued':
      return {
        title: 'Выдан ключ доступа',
        detail: [ROLE_LABEL[str(d.forRole) as Role], str(d.label)].filter(Boolean).join(' · ') || undefined,
        icon: 'staff',
        cat: 'club',
      };
    case 'key.revoked':
      return { title: 'Ключ доступа отозван', detail: str(d.prefix) ? `${str(d.prefix)}…` : undefined, icon: 'staff', cat: 'club', bad: true };
    // Lamps, manual mode, power, cloud
    case 'lamp.blink_requested':
      return { title: `${table}: мигнуть лампой`, icon: 'lamp', cat: 'lamps' };
    case 'lamp.mismatch':
      return { title: `${table}: реле разошлось с нужным состоянием`, detail: 'HUB отправил команду ещё раз', icon: 'alert', cat: 'lamps', bad: true };
    case 'hub.manual_mode_on':
      return { title: 'Включён ручной режим', detail: str(d.reason) || undefined, icon: 'alert', cat: 'system', bad: true };
    case 'hub.manual_mode_off':
      return { title: 'Ручной режим выключен', icon: 'check', cat: 'system' };
    case 'power.on_battery':
      return {
        title: 'Отключение света: ИБП на батарее',
        detail: d.chargePercent != null ? `заряд ${num(d.chargePercent)}%` : undefined,
        icon: 'plug',
        cat: 'system',
        bad: true,
      };
    case 'power.critical':
      return { title: 'Батарея ИБП почти разряжена', icon: 'plug', cat: 'system', bad: true };
    case 'power.restored':
      return { title: 'Свет вернулся', icon: 'plug', cat: 'system' };
    case 'power.ups_unreachable':
      return { title: 'ИБП не отвечает', icon: 'plug', cat: 'system', bad: true };
    case 'power.ups_reachable':
      return { title: 'Связь с ИБП восстановлена', icon: 'plug', cat: 'system' };
    case 'power.auto_paused':
      return { title: 'Игры на паузе: нет света', icon: 'clock', cat: 'system' };
    case 'power.auto_resumed':
      return { title: 'Игры продолжены: свет вернулся', icon: 'play', cat: 'system' };
    case 'power.settings_changed':
      return {
        title: 'Настройка ИБП изменена',
        detail: d.autoPauseOnPowerLoss ? 'автопауза при отключении света' : 'без автопаузы',
        icon: 'plug',
        cat: 'system',
      };
    case 'cloud.settings_applied':
      return { title: 'Настройки из облака применены', detail: `тарифов ${num(d.tariffs)} · столов ${num(d.tables)}`, icon: 'refresh', cat: 'system' };
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
