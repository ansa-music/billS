import type { ClubAdminView, FreeTableRule } from '@bills/domain';
import { normalizeClubSettings, validateClubSettings } from '@bills/domain';
import { Field, Section, Segmented } from '../../ui.tsx';
import type { SectionProps } from './shared.tsx';
import { fromMajor, SaveBar, toInt, toMajor, useDraft } from './shared.tsx';

interface RulesDraft {
  freeTableAfterStop: FreeTableRule;
  freeMinutes: string;
  minimumMinutes: string;
  stepMinutes: string;
  rounding: string;
}

/** «Правила»: when a table frees up, defaults for new tariffs. */
export function RulesSettings({ club, online, isBusy, run, onSaved, canEdit }: SectionProps & { canEdit: boolean }) {
  const cur = club.currency;
  const fromServer = (c: ClubAdminView): RulesDraft => ({
    freeTableAfterStop: c.settings.rules.freeTableAfterStop,
    freeMinutes: String(c.settings.rules.defaultFreeMinutes),
    minimumMinutes: String(c.settings.rules.defaultMinimumMinutes),
    stepMinutes: String(c.settings.rules.defaultStepMinutes),
    rounding: toMajor(c.settings.rules.defaultRoundingMinor, cur),
  });
  const { draft, setDraft, dirty, reset } = useDraft<RulesDraft>(fromServer(club));
  const busy = isBusy('rules');
  const disabled = !canEdit || !online;

  const errors: string[] = [];
  const freeMinutes = toInt(draft.freeMinutes);
  const minimumMinutes = toInt(draft.minimumMinutes);
  const stepMinutes = toInt(draft.stepMinutes);
  const roundingMinor = fromMajor(draft.rounding, cur);
  if (freeMinutes === null || freeMinutes > 60) errors.push('Бесплатные минуты: целое число от 0 до 60');
  if (minimumMinutes === null || minimumMinutes > 24 * 60) errors.push('Минимальное время: целое число минут (до суток)');
  if (stepMinutes === null || stepMinutes < 1 || stepMinutes > 60) errors.push('Шаг: от 1 до 60 минут');
  if (roundingMinor === null || roundingMinor < 1) errors.push('Округление суммы: сумма не меньше минимальной единицы');
  const patch = {
    freeTableAfterStop: draft.freeTableAfterStop,
    defaultFreeMinutes: freeMinutes ?? 0,
    defaultMinimumMinutes: minimumMinutes ?? 0,
    defaultStepMinutes: stepMinutes ?? 1,
    defaultRoundingMinor: roundingMinor ?? 1,
  };
  if (errors.length === 0) errors.push(...validateClubSettings(normalizeClubSettings({ rules: patch }, club.settings)));

  const save = async () => {
    const res = await run<ClubAdminView>('rules', '/api/club', { settings: { rules: patch } });
    if (res) {
      setDraft(fromServer(res));
      onSaved(res);
    }
  };

  return (
    <Section title="Правила">
      <div className="form">
        <Field
          label="Стол после «Стоп»"
          hint={
            draft.freeTableAfterStop === 'after_payment'
              ? 'Стол считается занятым, пока кассир не примет оплату. Сейчас экран зала всё равно освобождает стол сразу после «Стоп».'
              : 'Стол свободен сразу, игра висит у кассира как «ожидает оплаты».'
          }
        >
          <Segmented<FreeTableRule>
            value={draft.freeTableAfterStop}
            disabled={disabled}
            options={[
              { value: 'immediately', label: 'Сразу после «Стоп»' },
              { value: 'after_payment', label: 'После оплаты' },
            ]}
            onChange={(freeTableAfterStop) => setDraft((d) => ({ ...d, freeTableAfterStop }))}
          />
        </Field>

        <h3 className="rules-sub">Значения по умолчанию для новых тарифов</h3>
        <p className="hint">Подставляются в форму нового тарифа; уже созданные тарифы не меняются.</p>
        <div className="form-row">
          <Field label="Бесплатные минуты" hint="Игра короче — бесплатно (ошибочное открытие)">
            <input inputMode="numeric" value={draft.freeMinutes} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, freeMinutes: e.target.value }))} />
          </Field>
          <Field label="Минимальное время, мин" hint="0 — без минимума">
            <input inputMode="numeric" value={draft.minimumMinutes} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, minimumMinutes: e.target.value }))} />
          </Field>
          <Field label="Шаг, мин" hint="1 — поминутно">
            <input inputMode="numeric" value={draft.stepMinutes} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, stepMinutes: e.target.value }))} />
          </Field>
          <Field label={`Округление суммы, ${cur}`} hint="Итог кратен этой сумме">
            <input inputMode="decimal" value={draft.rounding} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, rounding: e.target.value }))} />
          </Field>
        </div>
        {dirty && errors.length > 0 && (
          <ul className="errors">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <SaveBar dirty={dirty} canSave={dirty && errors.length === 0} busy={busy} disabled={disabled} onSave={() => void save()} onReset={reset} />
      </div>
    </Section>
  );
}
