import { useCallback, useEffect, useState } from 'react';
import type { GuardSettings } from '@bills/domain';
import { GUARD_LIMITS } from '@bills/domain';
import { fetchJson } from '../../api.ts';
import { businessOf } from '../../cafe/cafe.ts';
import { Field, Section } from '../../ui.tsx';
import type { SectionProps } from './shared.tsx';
import { fromMajor, SaveBar, toInt, toMajor, useDraft } from './shared.tsx';

interface Draft {
  refundOn: boolean;
  refundAmount: string;
  refundPercent: string;
  refundLate: string;
  cancelsOn: boolean;
  cancelsCount: string;
  cancelsPercent: string;
  cashOn: boolean;
  cashDifference: string;
  manualOn: boolean;
  manualMinutes: string;
  discountsOn: boolean;
  discountsPercent: string;
  discountsPerShift: string;
  reopenOn: boolean;
  reopenMinutes: string;
}

const toDraft = (s: GuardSettings, currency: string): Draft => ({
  refundOn: s.refund.enabled,
  refundAmount: toMajor(s.refund.minAmount, currency),
  refundPercent: String(s.refund.minPercent),
  refundLate: String(s.refund.lateMinutes),
  cancelsOn: s.cancels.enabled,
  cancelsCount: String(s.cancels.minCount),
  cancelsPercent: String(s.cancels.minPercent),
  cashOn: s.cash.enabled,
  cashDifference: toMajor(s.cash.minDifference, currency),
  manualOn: s.manualMode.enabled,
  manualMinutes: String(s.manualMode.minutes),
  discountsOn: s.discounts.enabled,
  discountsPercent: String(s.discounts.maxPercent),
  discountsPerShift: String(s.discounts.perShift),
  reopenOn: s.reopen.enabled,
  reopenMinutes: String(s.reopen.minutes),
});

/** One rule: its switch above its numbers, rules apart from each other. */
const RULE = { display: 'grid', gap: 8, paddingBottom: 12, borderBottom: '1px solid var(--border, rgba(127,127,127,.25))' } as const;

const inRange = (v: number | null, [lo, hi]: readonly [number, number]): v is number => v !== null && v >= lo && v <= hi;

/**
 * «Сторож»: alerts about suspicious operations at the till. Counted on the HUB without the
 * internet; the owner gets them in the phone app and Telegram when the club is online.
 * Manager only (club.edit): thresholds and switches.
 */
export function GuardSection({ club, online, isBusy, run, canEdit }: SectionProps & { canEdit: boolean }) {
  const currency = club.currency;
  const cafe = businessOf(club.settings) === 'cafe';
  const [server, setServer] = useState<GuardSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setServer(await fetchJson<GuardSettings>('/api/guard/settings'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!server) {
    return (
      <Section title="Сторож">
        <p className="hint">{error ? `Не удалось загрузить: ${error}` : 'Загружаем…'}</p>
      </Section>
    );
  }
  return <GuardForm server={server} currency={currency} cafe={cafe} online={online} busy={isBusy('guard')} canEdit={canEdit} run={run} onSaved={setServer} />;
}

function GuardForm(props: {
  server: GuardSettings;
  currency: string;
  cafe: boolean;
  online: boolean;
  busy: boolean;
  canEdit: boolean;
  run: SectionProps['run'];
  onSaved: (s: GuardSettings) => void;
}) {
  const { server, currency, cafe } = props;
  const { draft, setDraft, dirty, reset } = useDraft<Draft>(toDraft(server, currency));
  const disabled = !props.canEdit || !props.online;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const L = GUARD_LIMITS;

  const values = {
    refundAmount: fromMajor(draft.refundAmount, currency),
    refundPercent: toInt(draft.refundPercent),
    refundLate: toInt(draft.refundLate),
    cancelsCount: toInt(draft.cancelsCount),
    cancelsPercent: toInt(draft.cancelsPercent),
    cashDifference: fromMajor(draft.cashDifference, currency),
    manualMinutes: toInt(draft.manualMinutes),
    discountsPercent: toInt(draft.discountsPercent),
    discountsPerShift: toInt(draft.discountsPerShift),
    reopenMinutes: toInt(draft.reopenMinutes),
  };
  const errors: string[] = [];
  if (!inRange(values.refundAmount, L.minAmount)) errors.push('Возврат: укажите сумму');
  if (!inRange(values.refundPercent, L.percent)) errors.push('Возврат: доля счёта от 1 до 100 %');
  if (!inRange(values.refundLate, L.lateMinutes)) errors.push('Возврат: время после оплаты от 1 до 1440 мин');
  if (!inRange(values.cancelsCount, L.minCount)) errors.push('Отмены: число от 1 до 100');
  if (!inRange(values.cancelsPercent, L.percent)) errors.push('Отмены: доля от 1 до 100 %');
  if (!inRange(values.cashDifference, L.minDifference)) errors.push('Расхождение кассы: укажите сумму');
  if (!inRange(values.manualMinutes, L.manualMinutes)) errors.push('Ручной режим: от 1 до 1440 мин');
  if (!inRange(values.discountsPercent, L.percent)) errors.push('Скидка: лимит от 1 до 100 %');
  if (!inRange(values.discountsPerShift, L.perShift)) errors.push('Скидки за смену: от 1 до 100');
  if (!inRange(values.reopenMinutes, L.reopenMinutes)) errors.push('Повторное открытие стола: от 1 до 60 мин');

  const save = async () => {
    const v = values;
    const patch: GuardSettings = {
      refund: { enabled: draft.refundOn, minAmount: v.refundAmount!, minPercent: v.refundPercent!, lateMinutes: v.refundLate! },
      cancels: { enabled: draft.cancelsOn, minCount: v.cancelsCount!, minPercent: v.cancelsPercent! },
      cash: { enabled: draft.cashOn, minDifference: v.cashDifference! },
      manualMode: { enabled: draft.manualOn, minutes: v.manualMinutes! },
      discounts: { enabled: draft.discountsOn, maxPercent: v.discountsPercent!, perShift: v.discountsPerShift! },
      reopen: { enabled: draft.reopenOn, minutes: v.reopenMinutes! },
    };
    const res = await props.run<GuardSettings>('guard', '/api/guard/settings', patch);
    if (res) {
      props.onSaved(res);
      setDraft(toDraft(res, currency));
    }
  };

  const sym = currency === 'KZT' ? '₸' : currency;
  const toggle = (key: keyof Draft, label: string) => (
    <label className="check">
      <input type="checkbox" checked={draft[key] as boolean} disabled={disabled} onChange={(e) => set(key, e.target.checked as never)} />
      {label}
    </label>
  );
  const num = (key: keyof Draft, label: string, hint?: string, on = true) => (
    <Field label={label} {...(hint ? { hint } : {})}>
      <input inputMode="numeric" value={draft[key] as string} disabled={disabled || !on} onChange={(e) => set(key, e.target.value as never)} />
    </Field>
  );

  return (
    <Section title="Сторож">
      <div className="form guard-settings">
        <p className="hint">
          Касса сама замечает подозрительные операции и присылает тревогу: в списке тревог на кассе (кнопка «Принято»), владельцу — в
          приложение и Telegram, как только у заведения есть интернет. Считается на месте, без интернета. Тексты без имён и обвинений:
          «проверьте», «возможно, ошибка при вводе». Имя сотрудника видит только управляющий — рядом с тревогой на кассе.
        </p>
        {!props.canEdit && <p className="hint">Пороги настраивает управляющий.</p>}

        <div className="guard-rule" style={RULE}>
          {toggle('refundOn', 'Возврат после оплаты')}
          <div className="form-row">
            {num('refundAmount', `Сумма от, ${sym}`, 'Крупный возврат', draft.refundOn)}
            {num('refundPercent', 'Или доля счёта от, %', 'Часть оплаты, которую вернули', draft.refundOn)}
            {num('refundLate', 'Или позже оплаты на, мин', 'Возврат давно оплаченного счёта', draft.refundOn)}
          </div>
        </div>

        <div className="guard-rule" style={RULE}>
          {toggle('cancelsOn', cafe ? 'Много отмен заказов у одного сотрудника за смену' : 'Много отмен заказов и игр у одного сотрудника за смену')}
          <div className="form-row">
            {num('cancelsCount', 'Отмен не меньше', 'Одна тревога на сотрудника за смену', draft.cancelsOn)}
            {num('cancelsPercent', 'И доля его заказов от, %', 'Чтобы не тревожить при большом потоке', draft.cancelsOn)}
          </div>
        </div>

        <div className="guard-rule" style={RULE}>
          {toggle('cashOn', 'Расхождение кассы при закрытии смены')}
          <div className="form-row">{num('cashDifference', `Недостача или излишек от, ${sym}`, undefined, draft.cashOn)}</div>
        </div>

        <div className="guard-rule" style={RULE}>
          {toggle('discountsOn', 'Скидки')}
          <div className="form-row">
            {num('discountsPercent', 'Скидка от, % счёта', 'Одна тревога на счёт', draft.discountsOn)}
            {num('discountsPerShift', 'Или ручных скидок за смену от', 'У одного сотрудника', draft.discountsOn)}
          </div>
        </div>

        {!cafe && (
          <>
            <div className="guard-rule" style={RULE}>
              {toggle('reopenOn', 'Стол закрыли и сразу открыли снова')}
              <div className="form-row">{num('reopenMinutes', 'Быстрее чем за, мин', 'Возможно, время обнулили', draft.reopenOn)}</div>
            </div>
            <div className="guard-rule" style={RULE}>
              {toggle('manualOn', 'Ручной режим ламп включён давно')}
              <div className="form-row">{num('manualMinutes', 'Дольше, мин', 'Пока он включён, свет не проверяется', draft.manualOn)}</div>
            </div>
            <p className="hint">«Свет горит без игры» и «Игра идёт без света» проверяются всегда, по датчику тока лампы.</p>
          </>
        )}

        {dirty && errors.length > 0 && (
          <ul className="errors">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <SaveBar dirty={dirty} canSave={dirty && errors.length === 0} busy={props.busy} disabled={disabled} onSave={() => void save()} onReset={reset} />
      </div>
    </Section>
  );
}
