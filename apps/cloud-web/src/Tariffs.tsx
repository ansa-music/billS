import { useCallback, useEffect, useState } from 'react';
import type { ClubSettings, TariffConfig, TariffSetting, UpdateTariffsRequest, Weekday } from '@bills/domain';
import { validateTariff } from '@bills/domain';
import { CloudRequestError, fetchClub, updateTariffs } from './api.ts';
import { WEEKDAYS, currencySymbol, formatDateTime, money, toMajor, toMinor } from './format.ts';
import { usePoll } from './hooks.ts';
import { ClubHeader } from './ClubPage.tsx';
import { loadingText } from './shared.tsx';

/** Editor state keeps text as typed; numbers are parsed only when sending. */
interface WindowDraft {
  key: string;
  label: string;
  days: Weekday[];
  from: string;
  to: string;
  price: string;
}

interface TariffDraft {
  key: string;
  id?: string;
  name: string;
  isActive: boolean;
  basePrice: string;
  windows: WindowDraft[];
  stepMinutes: string;
  minimumMinutes: string;
  freeMinutes: string;
  rounding: string;
}

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

function fromSetting(t: TariffSetting, currency: string): TariffDraft {
  const c = t.config;
  return {
    key: nextKey(),
    id: t.id,
    name: t.name,
    isActive: t.isActive,
    basePrice: toMajor(c.basePricePerHour, currency),
    windows: c.windows.map((w) => ({
      key: nextKey(),
      label: w.label,
      days: [...w.days],
      from: w.from,
      to: w.to,
      price: toMajor(w.pricePerHour, currency),
    })),
    stepMinutes: String(c.stepMinutes),
    minimumMinutes: String(c.minimumMinutes),
    freeMinutes: String(c.freeMinutes),
    rounding: toMajor(c.roundingMinor, currency),
  };
}

function newTariff(currency: string): TariffDraft {
  return {
    key: nextKey(),
    name: '',
    isActive: true,
    basePrice: '',
    windows: [],
    stepMinutes: '1',
    minimumMinutes: '0',
    freeMinutes: '0',
    rounding: toMajor(1, currency),
  };
}

function newWindow(): WindowDraft {
  return { key: nextKey(), label: '', days: [1, 2, 3, 4, 5, 6, 7], from: '18:00', to: '24:00', price: '' };
}

function intField(value: string, name: string, min: number, errors: string[]): number {
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < min) errors.push(`${name}: нужно целое число не меньше ${min}`);
  return n;
}

function moneyField(value: string, name: string, currency: string, errors: string[]): number {
  const n = toMinor(value, currency);
  if (!Number.isFinite(n) || n < 0) errors.push(`${name}: введите сумму в ${currencySymbol(currency)}`);
  return n;
}

/** Draft → request item; Russian errors for what the owner can fix, domain validation as the last line. */
function toSetting(
  d: TariffDraft,
  currency: string,
  timezone: string,
): { setting: UpdateTariffsRequest['tariffs'][number]; errors: string[] } {
  const errors: string[] = [];
  if (!d.name.trim()) errors.push('Укажите название тарифа');
  const config: TariffConfig = {
    currency,
    basePricePerHour: moneyField(d.basePrice, 'Базовая цена', currency, errors),
    windows: d.windows.map((w, i) => {
      const n = `Окно ${i + 1}${w.label ? ` «${w.label}»` : ''}`;
      if (w.days.length === 0) errors.push(`${n}: выберите хотя бы один день`);
      if (!/^\d{2}:\d{2}$/.test(w.from) || !/^\d{2}:\d{2}$/.test(w.to)) errors.push(`${n}: время в формате ЧЧ:ММ`);
      return {
        label: w.label.trim() || `Окно ${i + 1}`,
        days: [...w.days].sort((a, b) => a - b),
        from: w.from,
        to: w.to,
        pricePerHour: moneyField(w.price, `${n}, цена`, currency, errors),
      };
    }),
    stepMinutes: intField(d.stepMinutes, 'Шаг', 1, errors),
    minimumMinutes: intField(d.minimumMinutes, 'Минимум', 0, errors),
    freeMinutes: intField(d.freeMinutes, 'Бесплатные минуты', 0, errors),
    roundingMinor: moneyField(d.rounding, 'Округление', currency, errors),
  };
  if (Number.isFinite(config.roundingMinor) && config.roundingMinor < 1) {
    errors.push('Округление: не меньше одной минимальной единицы');
  }
  if (errors.length === 0) errors.push(...validateTariff(config, timezone));
  const setting = { ...(d.id ? { id: d.id } : {}), name: d.name.trim(), config, isActive: d.isActive };
  return { setting, errors };
}

function WindowRow({
  w,
  currency,
  onChange,
  onRemove,
}: {
  w: WindowDraft;
  currency: string;
  onChange: (next: WindowDraft) => void;
  onRemove: () => void;
}) {
  const toggleDay = (day: Weekday) =>
    onChange({ ...w, days: w.days.includes(day) ? w.days.filter((d) => d !== day) : [...w.days, day] });
  return (
    <div className="window">
      <label className="field">
        <span>Подпись</span>
        <input value={w.label} placeholder="Вечер" maxLength={40} onChange={(e) => onChange({ ...w, label: e.target.value })} />
      </label>
      <div className="field">
        <span>Дни</span>
        <div className="days">
          {WEEKDAYS.map(({ day, label }) => (
            <label key={day} className="day" data-on={w.days.includes(day) || undefined}>
              <input type="checkbox" checked={w.days.includes(day)} onChange={() => toggleDay(day)} />
              {label}
            </label>
          ))}
        </div>
      </div>
      <label className="field">
        <span>С</span>
        <input type="time" value={w.from} step={60} onChange={(e) => onChange({ ...w, from: e.target.value })} />
      </label>
      <label className="field">
        <span>До</span>
        <input
          type="time"
          value={w.to === '24:00' ? '00:00' : w.to}
          step={60}
          onChange={(e) => onChange({ ...w, to: e.target.value })}
          title="00:00 означает конец суток; окно через полночь задаётся временем «до» раньше «с»"
        />
      </label>
      <label className="field">
        <span>Цена/час, {currencySymbol(currency)}</span>
        <input inputMode="decimal" value={w.price} onChange={(e) => onChange({ ...w, price: e.target.value })} />
      </label>
      <button type="button" className="link" onClick={onRemove} title="Убрать окно">
        убрать
      </button>
    </div>
  );
}

function TariffCard({
  d,
  currency,
  errors,
  onChange,
}: {
  d: TariffDraft;
  currency: string;
  errors: string[] | undefined;
  onChange: (next: TariffDraft) => void;
}) {
  const sym = currencySymbol(currency);
  const base = toMinor(d.basePrice, currency);
  return (
    <section className="tariff" data-inactive={!d.isActive || undefined} aria-label={d.name || 'Новый тариф'}>
      <header className="tariff-head">
        <label className="field grow">
          <span>Название</span>
          <input value={d.name} placeholder="Например, Дневной" maxLength={60} onChange={(e) => onChange({ ...d, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Базовая цена/час, {sym}</span>
          <input inputMode="decimal" value={d.basePrice} onChange={(e) => onChange({ ...d, basePrice: e.target.value })} />
          {Number.isFinite(base) && base >= 0 && <span className="hint">{money(base, currency)} в час</span>}
        </label>
        <label className="check">
          <input type="checkbox" checked={d.isActive} onChange={(e) => onChange({ ...d, isActive: e.target.checked })} />
          {d.isActive ? 'Активен' : 'Выключен'}
        </label>
        {!d.id && <span className="tag tag-new">новый</span>}
      </header>

      <div className="tariff-grid">
        <label className="field">
          <span>Шаг, мин</span>
          <input inputMode="numeric" value={d.stepMinutes} onChange={(e) => onChange({ ...d, stepMinutes: e.target.value })} />
          <span className="hint">время округляется вверх до шага</span>
        </label>
        <label className="field">
          <span>Минимум, мин</span>
          <input inputMode="numeric" value={d.minimumMinutes} onChange={(e) => onChange({ ...d, minimumMinutes: e.target.value })} />
          <span className="hint">меньше не считаем</span>
        </label>
        <label className="field">
          <span>Бесплатно, мин</span>
          <input inputMode="numeric" value={d.freeMinutes} onChange={(e) => onChange({ ...d, freeMinutes: e.target.value })} />
          <span className="hint">короче — не платят (0 — выключено)</span>
        </label>
        <label className="field">
          <span>Округление суммы, {sym}</span>
          <input inputMode="decimal" value={d.rounding} onChange={(e) => onChange({ ...d, rounding: e.target.value })} />
          <span className="hint">итог кратен этой сумме</span>
        </label>
      </div>

      <div className="windows">
        <div className="panel-head">
          <h3>Окна цен</h3>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => onChange({ ...d, windows: [...d.windows, newWindow()] })}
          >
            + Окно
          </button>
        </div>
        {d.windows.length === 0 && <p className="hint">Без окон всегда действует базовая цена. Первое подходящее окно побеждает.</p>}
        {d.windows.map((w, i) => (
          <WindowRow
            key={w.key}
            w={w}
            currency={currency}
            onChange={(next) => onChange({ ...d, windows: d.windows.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => onChange({ ...d, windows: d.windows.filter((_, j) => j !== i) })}
          />
        ))}
      </div>

      {errors && errors.length > 0 && (
        <ul className="form-errors" role="alert">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Tariffs({ id }: { id: string }) {
  const load = useCallback(() => fetchClub(id), [id]);
  // Every 10 s: the owner wants to see when the HUB picks the new version up.
  const { data, error, reload } = usePoll(load, 10_000);

  const [drafts, setDrafts] = useState<TariffDraft[] | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ version: number; at: number } | null>(null);

  const settings: ClubSettings | undefined = data?.settings;
  const currency = data?.club.currency ?? settings?.club.currency ?? 'KZT';

  // Take the cloud's list until the owner starts editing; afterwards only an explicit reset replaces it.
  useEffect(() => {
    if (!settings || dirty) return;
    if (loadedVersion === settings.version && drafts) return;
    setDrafts(settings.tariffs.map((t) => fromSetting(t, currency)));
    setLoadedVersion(settings.version);
  }, [settings, dirty, loadedVersion, drafts, currency]);

  if (!data || !drafts) {
    return <p className="boot-inline">{loadingText(error, 'тарифы')}</p>;
  }

  const { club } = data;
  const hub = club.hub;
  const now = Date.now();

  const edit = (key: string, next: TariffDraft) => {
    setDrafts((list) => (list ?? []).map((d) => (d.key === key ? next : d)));
    setDirty(true);
  };

  const reset = () => {
    setDrafts(data.settings.tariffs.map((t) => fromSetting(t, currency)));
    setLoadedVersion(data.settings.version);
    setDirty(false);
    setErrors({});
    setServerError(null);
  };

  async function send() {
    const nextErrors: Record<string, string[]> = {};
    const tariffs: UpdateTariffsRequest['tariffs'] = [];
    for (const d of drafts ?? []) {
      const { setting, errors: errs } = toSetting(d, currency, club.timezone);
      if (errs.length > 0) nextErrors[d.key] = errs;
      tariffs.push(setting);
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (tariffs.filter((t) => t.isActive).length === 0) {
      setServerError('Нужен хотя бы один активный тариф — иначе столы будет не на чем открывать');
      return;
    }
    setServerError(null);
    setSaving(true);
    try {
      const res = await updateTariffs(id, { tariffs });
      setDrafts(res.settings.tariffs.map((t) => fromSetting(t, currency)));
      setLoadedVersion(res.settings.version);
      setDirty(false);
      setSaved({ version: res.settings.version, at: Date.now() });
      void reload();
    } catch (e) {
      const err = e as CloudRequestError;
      setServerError(err.code === 'TARIFF_INVALID' ? `Облако отклонило тарифы: ${err.message}` : err.message);
    } finally {
      setSaving(false);
    }
  }

  const cloudVersion = data.settings.version;
  const hubStatus = !hub
    ? 'HUB не подключён — настройки применятся, когда клуб подключат к облаку'
    : hub.pendingSettings
      ? `HUB ещё не забрал версию ${cloudVersion} (у него ${hub.settingsVersion})${hub.online ? '' : ' — HUB не на связи'}`
      : `HUB применил версию ${hub.settingsVersion}`;

  return (
    <>
      <ClubHeader club={club} now={now} tab="tariffs" />

      <section className="panel sticky-bar">
        <div className="version">
          <strong>Версия настроек в облаке: {cloudVersion}</strong>
          <span className="muted" data-pending={hub?.pendingSettings || undefined}>
            {hubStatus}
          </span>
          {saved && (
            <span className="saved">
              Версия {saved.version} отправлена {formatDateTime(saved.at, club.timezone)}
              {hub?.pendingSettings ? ' · HUB ещё не забрал' : hub ? ' · HUB забрал' : ''}
            </span>
          )}
          {dirty && cloudVersion !== loadedVersion && (
            <span className="form-error">
              Пока вы редактировали, в облаке появилась версия {cloudVersion}. Отправка перезапишет её вашим списком.
            </span>
          )}
        </div>
        <div className="row wrap">
          {dirty && (
            <button type="button" className="btn btn-small" onClick={reset} disabled={saving}>
              Отменить правки
            </button>
          )}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setDrafts((list) => [...(list ?? []), newTariff(currency)]);
              setDirty(true);
            }}
          >
            + Тариф
          </button>
          <button type="button" className="btn btn-primary btn-narrow" onClick={() => void send()} disabled={saving || !dirty}>
            {saving ? 'Отправляем…' : 'Отправить в клуб'}
          </button>
        </div>
        {serverError && (
          <p className="form-error" role="alert">
            {serverError}
          </p>
        )}
      </section>

      <div className="tariffs">
        {drafts.length === 0 && <p className="empty">Тарифов нет — добавьте первый</p>}
        {drafts.map((d) => (
          <TariffCard key={d.key} d={d} currency={currency} errors={errors[d.key]} onChange={(next) => edit(d.key, next)} />
        ))}
      </div>

      <p className="hint">
        Выключенный тариф остаётся в списке, но не предлагается на столах. Удалять тарифы нельзя — по ним есть история
        игр. Цены вводятся в {currencySymbol(currency)}, время окон — по часам клуба ({club.timezone}).
      </p>
    </>
  );
}
