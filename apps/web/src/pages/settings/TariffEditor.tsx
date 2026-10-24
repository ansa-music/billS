import { useState } from 'react';
import type { ClubAdminView, TariffAdminView, TariffConfig, Weekday } from '@bills/domain';
import { formatMoney, nextPriceChange, priceAt, validateTariff } from '@bills/domain';
import { formatClock } from '../../format.ts';
import { navigate } from '../../router.tsx';
import { EmptyState } from '../../components.tsx';
import { Field, Modal, Section } from '../../ui.tsx';
import { useServerNow } from '../../useHub.tsx';
import type { SectionProps } from './shared.tsx';
import { fromMajor, toInt, toMajor, WEEKDAY_SHORT } from './shared.tsx';

const DAY = 24 * 60 * 60 * 1000;
const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

interface WindowDraft {
  label: string;
  days: Weekday[];
  from: string;
  to: string;
  price: string;
}

interface TariffDraft {
  name: string;
  basePrice: string;
  windows: WindowDraft[];
  stepMinutes: string;
  minimumMinutes: string;
  freeMinutes: string;
  rounding: string;
}

/** «Тарифы»: list with the rate in force now, editor dialog with a live preview. */
export function TariffsEditor({ club, online, isBusy, run, onSaved, reload, canEdit }: SectionProps & { canEdit: boolean }) {
  const [editing, setEditing] = useState<TariffAdminView | 'new' | null>(null);
  /** Tariffs are there but no tables yet: point to the next step. */
  const [nextStep, setNextStep] = useState(false);
  const now = useServerNow(30_000);
  const disabled = !canEdit || !online;

  const fillExample = async () => {
    const res = await run<{ tariffs: number }>('template', '/api/templates/apply', { kind: 'tariffs-standard' });
    if (!res) return;
    await reload(res.tariffs > 0 ? 'Тарифы «Стандарт» и «Снукер» добавлены' : 'Тарифы уже есть');
    if (res.tariffs > 0 && club.tables.length === 0) setNextStep(true);
  };

  const toggle = async (t: TariffAdminView) => {
    const res = await run<TariffAdminView>(`tariff:${t.id}`, `/api/tariffs/${t.id}/update`, { isActive: !t.isActive });
    if (res) await reload(res.isActive ? `${res.name} включён` : `${res.name} выключен`);
  };

  return (
    <Section
      title="Тарифы"
      aside={
        <button type="button" className="btn btn-small btn-primary" disabled={disabled} onClick={() => setEditing('new')}>
          + Новый тариф
        </button>
      }
    >
      {club.tariffs.length === 0 ? (
        <EmptyState icon="tariffs" title="Тарифов пока нет">
          <p>Тариф — это цена часа игры. Он нужен, чтобы добавить столы и открывать игры.</p>
          <div className="row wrap">
            <button type="button" className="btn btn-primary" disabled={disabled || isBusy('template')} onClick={() => void fillExample()}>
              {isBusy('template') ? 'Добавляем…' : 'Заполнить примером'}
            </button>
            <button type="button" className="btn" disabled={disabled} onClick={() => setEditing('new')}>
              Создать тариф самому
            </button>
          </div>
          <p className="hint">Пример — «Стандарт» и «Снукер»: днём, вечером и в выходные разная цена. Всё можно поменять.</p>
        </EmptyState>
      ) : (
        <ul className="list tariff-list">
          {club.tariffs.map((t) => {
            const current = priceAt(now, t.config, club.timezone);
            const next = nextPriceChange(now, t.config, club.timezone, DAY);
            const busy = isBusy(`tariff:${t.id}`);
            return (
              <li key={t.id} data-inactive={t.isActive ? undefined : ''}>
                <div className="grow">
                  <div className="tariff-title">
                    <strong>{t.name}</strong>
                    {!t.isActive && <span className="tag tag-muted">выключен</span>}
                    {t.tableCount > 0 && (
                      <span className="tag tag-ok">
                        {t.tableCount} {plural(t.tableCount, 'стол', 'стола', 'столов')}
                      </span>
                    )}
                  </div>
                  <div className="muted tariff-now">
                    Сейчас {formatMoney(current.pricePerHour, club.currency)}/час ({current.label})
                    {next && (
                      <>
                        {' · '}с {formatClock(next.at, club.timezone)} — {next.label}, {formatMoney(next.pricePerHour, club.currency)}/час
                      </>
                    )}
                  </div>
                  <div className="muted tariff-meta">
                    {describe(t.config, club.currency)}
                  </div>
                </div>
                <div className="actions">
                  <button type="button" className="btn btn-small" disabled={disabled || busy} onClick={() => setEditing(t)}>
                    Изменить
                  </button>
                  <button
                    type="button"
                    className={t.isActive ? 'btn btn-small btn-ghost' : 'btn btn-small btn-primary'}
                    disabled={disabled || busy || (t.isActive && t.tableCount > 0)}
                    title={t.isActive && t.tableCount > 0 ? 'Тариф назначен столам — сначала переназначьте их' : undefined}
                    onClick={() => void toggle(t)}
                  >
                    {t.isActive ? 'Выключить' : 'Включить'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {(nextStep || (club.tariffs.some((t) => t.isActive) && club.tables.length === 0)) && (
        <div className="settings-guide" role="note">
          <p>
            <strong>Дальше: добавьте столы.</strong> Каждому столу назначается тариф.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/settings', { tab: 'tables' })}>
            Перейти к столам
          </button>
        </div>
      )}
      <p className="hint">
        Тариф фиксируется в игре при открытии стола: изменение цен не влияет на уже идущие игры. Выключенный тариф нельзя выбрать для новых игр.
      </p>
      {editing && (
        <TariffDialog
          club={club}
          tariff={editing === 'new' ? null : editing}
          busy={isBusy(editing === 'new' ? 'tariff:new' : `tariff:${editing.id}`)}
          onClose={() => setEditing(null)}
          onSubmit={async (name, config) => {
            if (editing === 'new') {
              const res = await run<TariffAdminView>('tariff:new', '/api/tariffs', { name, config });
              if (!res) return;
              setEditing(null);
              onSaved({ ...club, tariffs: [...club.tariffs, res] }, `Тариф «${res.name}» создан`);
            } else {
              const res = await run<TariffAdminView>(`tariff:${editing.id}`, `/api/tariffs/${editing.id}/update`, { name, config });
              if (!res) return;
              setEditing(null);
              onSaved({ ...club, tariffs: club.tariffs.map((t) => (t.id === res.id ? res : t)) });
            }
          }}
        />
      )}
    </Section>
  );
}

function describe(c: TariffConfig, currency: string): string {
  const parts = [`база ${formatMoney(c.basePricePerHour, currency)}/час`];
  if (c.windows.length) parts.push(`цен по времени суток: ${c.windows.length}`);
  parts.push(c.stepMinutes === 1 ? 'шаг 1 мин (поминутно)' : `шаг ${c.stepMinutes} мин`);
  if (c.minimumMinutes > 0) parts.push(`минимальное время ${c.minimumMinutes} мин`);
  if (c.freeMinutes > 0) parts.push(`бесплатные минуты: ${c.freeMinutes}`);
  if (c.roundingMinor > 1) parts.push(`округление суммы до ${formatMoney(c.roundingMinor, currency)}`);
  return parts.join(' · ');
}

function toDraft(t: TariffAdminView | null, club: ClubAdminView): TariffDraft {
  const cur = club.currency;
  if (t) {
    return {
      name: t.name,
      basePrice: toMajor(t.config.basePricePerHour, cur),
      windows: t.config.windows.map((w) => ({ label: w.label, days: [...w.days], from: w.from, to: w.to === '24:00' ? '00:00' : w.to, price: toMajor(w.pricePerHour, cur) })),
      stepMinutes: String(t.config.stepMinutes),
      minimumMinutes: String(t.config.minimumMinutes),
      freeMinutes: String(t.config.freeMinutes),
      rounding: toMajor(t.config.roundingMinor, cur),
    };
  }
  const r = club.settings.rules;
  return {
    name: '',
    basePrice: '',
    windows: [],
    stepMinutes: String(r.defaultStepMinutes),
    minimumMinutes: String(r.defaultMinimumMinutes),
    freeMinutes: String(r.defaultFreeMinutes),
    rounding: toMajor(r.defaultRoundingMinor, cur),
  };
}

/** Draft → config; problems in Russian for the fields, plus the domain's own checks. */
function toConfig(d: TariffDraft, club: ClubAdminView): { config: TariffConfig | null; errors: string[] } {
  const errors: string[] = [];
  const cur = club.currency;
  const basePricePerHour = fromMajor(d.basePrice, cur);
  if (basePricePerHour === null) errors.push('Обычная цена: укажите сумму за час');
  const stepMinutes = toInt(d.stepMinutes);
  if (stepMinutes === null || stepMinutes < 1) errors.push('Шаг: целое число минут, не меньше 1');
  const minimumMinutes = toInt(d.minimumMinutes);
  if (minimumMinutes === null) errors.push('Минимальное время: целое число минут');
  const freeMinutes = toInt(d.freeMinutes);
  if (freeMinutes === null) errors.push('Бесплатные минуты: целое число');
  const roundingMinor = fromMajor(d.rounding, cur);
  if (roundingMinor === null || roundingMinor < 1) errors.push('Округление суммы: сумма не меньше минимальной единицы');
  const windows = d.windows.map((w, i) => {
    const n = i + 1;
    if (!w.label.trim()) errors.push(`Цена по времени ${n}: укажите название`);
    if (w.days.length === 0) errors.push(`Цена по времени ${n}: выберите хотя бы один день`);
    if (!/^\d{2}:\d{2}$/.test(w.from) || !/^\d{2}:\d{2}$/.test(w.to)) errors.push(`Цена по времени ${n}: время в формате ЧЧ:ММ`);
    const pricePerHour = fromMajor(w.price, cur);
    if (pricePerHour === null) errors.push(`Цена по времени ${n}: укажите цену за час`);
    // <input type=time> cannot hold 24:00; "00:00" as an end means the end of the day (domain: to === 0 → 24:00).
    return { label: w.label.trim(), days: w.days, from: w.from, to: w.to === '00:00' ? '24:00' : w.to, pricePerHour: pricePerHour ?? 0 };
  });
  if (minimumMinutes !== null && freeMinutes !== null && minimumMinutes > 0 && minimumMinutes < freeMinutes) {
    errors.push('Минимальное время не может быть меньше бесплатных минут');
  }
  if (errors.length) return { config: null, errors };
  const config: TariffConfig = {
    currency: cur,
    basePricePerHour: basePricePerHour!,
    windows,
    stepMinutes: stepMinutes!,
    minimumMinutes: minimumMinutes!,
    freeMinutes: freeMinutes!,
    roundingMinor: roundingMinor!,
  };
  const domain = validateTariff(config, club.timezone);
  return domain.length ? { config: null, errors: domain } : { config, errors: [] };
}

function TariffDialog({
  club,
  tariff,
  busy,
  onClose,
  onSubmit,
}: {
  club: ClubAdminView;
  tariff: TariffAdminView | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, config: TariffConfig) => Promise<void>;
}) {
  const [d, setD] = useState<TariffDraft>(() => toDraft(tariff, club));
  const [touched, setTouched] = useState(false);
  const now = useServerNow(30_000);
  const cur = club.currency;
  const name = d.name.trim();
  const nameTaken = club.tariffs.some((t) => t.isActive && t.id !== tariff?.id && t.name === name);
  const { config, errors } = toConfig(d, club);
  const allErrors = [...(name ? [] : ['Укажите название тарифа']), ...(nameTaken ? ['Тариф с таким названием уже есть'] : []), ...errors];
  const ok = allErrors.length === 0 && config !== null;

  const setWindow = (i: number, patch: Partial<WindowDraft>) =>
    setD((x) => ({ ...x, windows: x.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) }));
  const unit = cur;

  return (
    <Modal open title={tariff ? `Тариф: ${tariff.name}` : 'Новый тариф'} onClose={onClose}>
      <form
        className="form tariff-form"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (ok && config) void onSubmit(name, config);
        }}
      >
        <div className="form-row">
          <Field label="Название">
            <input autoFocus value={d.name} maxLength={60} onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))} />
          </Field>
          <Field label={`Обычная цена за час, ${unit}`} hint="Действует всё время, кроме часов с особой ценой ниже">
            <input inputMode="decimal" value={d.basePrice} placeholder="2000" onChange={(e) => setD((x) => ({ ...x, basePrice: e.target.value }))} />
          </Field>
        </div>

        <fieldset className="windows">
          <legend>Цена по времени суток</legend>
          <p className="hint">
            Например, вечером и в выходные дороже. Если часы пересекаются, действует верхняя строка. Время через полночь
            относится к дню начала: «Пт 22:00–06:00» действует и в субботу до 06:00.
          </p>
          {d.windows.map((w, i) => (
            <div key={i} className="window">
              <div className="form-row">
                <Field label="Название">
                  <input value={w.label} maxLength={40} placeholder="Вечер" onChange={(e) => setWindow(i, { label: e.target.value })} />
                </Field>
                <Field label={`Цена за час, ${unit}`}>
                  <input inputMode="decimal" value={w.price} placeholder="3000" onChange={(e) => setWindow(i, { price: e.target.value })} />
                </Field>
              </div>
              <div className="days" role="group" aria-label="Дни недели">
                {ALL_DAYS.map((day) => (
                  <button
                    key={day}
                    type="button"
                    className="chip day"
                    aria-pressed={w.days.includes(day)}
                    onClick={() =>
                      setWindow(i, {
                        days: w.days.includes(day) ? w.days.filter((x) => x !== day) : [...w.days, day].sort((a, b) => a - b),
                      })
                    }
                  >
                    {WEEKDAY_SHORT[day - 1]}
                  </button>
                ))}
              </div>
              <div className="window-time">
                <Field label="С">
                  <input type="time" value={w.from} step={60} onChange={(e) => setWindow(i, { from: e.target.value })} />
                </Field>
                <Field label="До" hint={w.to === '00:00' ? 'до конца дня' : w.to <= w.from ? 'через полночь' : undefined}>
                  <input type="time" value={w.to} step={60} onChange={(e) => setWindow(i, { to: e.target.value })} />
                </Field>
                <button
                  type="button"
                  className="btn btn-small btn-ghost btn-narrow"
                  aria-label="Удалить эту цену"
                  onClick={() => setD((x) => ({ ...x, windows: x.windows.filter((_, j) => j !== i) }))}
                >
                  Удалить
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-small btn-narrow"
            onClick={() =>
              setD((x) => ({
                ...x,
                windows: [...x.windows, { label: '', days: [1, 2, 3, 4, 5], from: '18:00', to: '23:00', price: '' }],
              }))
            }
          >
            + Добавить цену по времени
          </button>
        </fieldset>

        <div className="form-row">
          <Field label="Шаг, мин" hint="1 — поминутно">
            <input inputMode="numeric" value={d.stepMinutes} onChange={(e) => setD((x) => ({ ...x, stepMinutes: e.target.value }))} />
          </Field>
          <Field label="Минимальное время, мин" hint="0 — без минимума">
            <input inputMode="numeric" value={d.minimumMinutes} onChange={(e) => setD((x) => ({ ...x, minimumMinutes: e.target.value }))} />
          </Field>
          <Field label="Бесплатные минуты" hint="Игра короче — бесплатно">
            <input inputMode="numeric" value={d.freeMinutes} onChange={(e) => setD((x) => ({ ...x, freeMinutes: e.target.value }))} />
          </Field>
          <Field label={`Округление суммы, ${unit}`} hint="Итог кратен этой сумме">
            <input inputMode="decimal" value={d.rounding} onChange={(e) => setD((x) => ({ ...x, rounding: e.target.value }))} />
          </Field>
        </div>

        {config && <Preview config={config} now={now} timezone={club.timezone} currency={cur} />}
        {allErrors.length > 0 && (touched || d.name !== '' || d.basePrice !== '') && (
          <ul className="errors">
            {allErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div className="row wrap modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !ok}>
            {busy ? 'Сохраняем…' : tariff ? 'Сохранить' : 'Создать'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Preview({ config, now, timezone, currency }: { config: TariffConfig; now: number; timezone: string; currency: string }) {
  const current = priceAt(now, config, timezone);
  const next = nextPriceChange(now, config, timezone, DAY);
  return (
    <div className="preview">
      <div className="preview-now">
        Сейчас час стоит: <strong>{formatMoney(current.pricePerHour, currency)}</strong>
        <span className="muted"> ({current.label})</span>
      </div>
      <div className="muted">
        {next ? `с ${formatClock(next.at, timezone)} — ${next.label}, ${formatMoney(next.pricePerHour, currency)}/час` : 'Ближайшие сутки цена не меняется'}
      </div>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
