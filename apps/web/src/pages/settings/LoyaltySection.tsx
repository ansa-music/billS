import { useEffect, useState } from 'react';
import type { CatalogView, LoyaltyProgram, LoyaltySettings } from '@bills/domain';
import { formatMoney, normalizeLoyaltySettings, stampCategories } from '@bills/domain';
import { fetchJson } from '../../api.ts';
import { businessOf } from '../../cafe/cafe.ts';
import { Guests } from '../../loyalty/Guests.tsx';
import { Field, Section, Segmented } from '../../ui.tsx';
import type { SectionProps } from './shared.tsx';
import { SaveBar, toInt, useDraft } from './shared.tsx';
import '../../loyalty/loyalty.css';

interface Draft {
  enabled: boolean;
  program: LoyaltyProgram;
  cashbackPercent: string;
  stampsEvery: string;
  stampCategoryIds: string[];
  maxRedeemPercent: string;
  expiryDays: string;
}

const toDraft = (s: LoyaltySettings): Draft => ({
  enabled: s.enabled,
  program: s.program,
  cashbackPercent: String(s.cashbackPercent),
  stampsEvery: String(s.stampsEvery),
  stampCategoryIds: s.stampCategoryIds,
  maxRedeemPercent: String(s.maxRedeemPercent),
  expiryDays: String(s.expiryDays),
});

/**
 * «Лояльность»: the program (cashback or every N-th drink free), its numbers, and «Гости» —
 * everyone who left a phone, with bonuses and stamps. The manager decides; off by default.
 */
export function LoyaltySection({ club, online, isBusy, run, reload, canEdit }: SectionProps & { canEdit: boolean }) {
  const server = normalizeLoyaltySettings(club.settings.loyalty ?? {});
  const { draft, setDraft, dirty, reset } = useDraft<Draft>(toDraft(server));
  const [categories, setCategories] = useState<CatalogView['categories']>([]);
  const busy = isBusy('loyalty');
  const disabled = !canEdit || !online;
  const cafe = businessOf(club.settings) === 'cafe';

  useEffect(() => {
    fetchJson<CatalogView>('/api/bar/catalog').then(
      (c) => setCategories(c.categories.filter((x) => x.isActive)),
      () => setCategories([]),
    );
  }, []);

  const errors: string[] = [];
  const percent = toInt(draft.cashbackPercent);
  const every = toInt(draft.stampsEvery);
  const share = toInt(draft.maxRedeemPercent);
  const days = toInt(draft.expiryDays);
  if (draft.program === 'cashback') {
    if (percent === null || percent < 1 || percent > 50) errors.push('Кэшбэк: от 1 до 50 %');
    if (share === null || share > 100) errors.push('Доля чека бонусами: от 0 до 100 %');
    if (days === null || days > 3650) errors.push('Срок бонусов: от 0 до 3650 дней');
  } else if (every === null || every < 2 || every > 20) errors.push('Подарок: каждый от 2-го до 20-го');
  const counted = stampCategories({ stampCategoryIds: draft.stampCategoryIds }, categories);

  const save = async () => {
    const patch: Partial<LoyaltySettings> = {
      enabled: draft.enabled,
      program: draft.program,
      cashbackPercent: percent ?? server.cashbackPercent,
      stampsEvery: every ?? server.stampsEvery,
      stampCategoryIds: draft.stampCategoryIds,
      maxRedeemPercent: share ?? server.maxRedeemPercent,
      expiryDays: days ?? server.expiryDays,
    };
    const res = await run<LoyaltySettings>('loyalty', '/api/loyalty/settings', patch);
    if (res) {
      setDraft(toDraft(res));
      await reload(res.enabled ? 'Лояльность включена' : 'Сохранено');
    }
  };

  const toggleCategory = (id: string) =>
    setDraft((d) => {
      // Starting from the default («Кофе…»), the first tap edits that set rather than an empty one.
      const base = d.stampCategoryIds.length ? d.stampCategoryIds : [...counted];
      return { ...d, stampCategoryIds: base.includes(id) ? base.filter((x) => x !== id) : [...base, id] };
    });

  const example = (() => {
    if (draft.program === 'stamps') {
      const n = every ?? 6;
      return `Гость покупает ${n - 1} напитков — ${n}-й в подарок. Касса сама предложит: «${n}-й кофе в подарок — применить?»`;
    }
    const p = percent ?? 5;
    const check = 2000_00;
    return `С чека ${formatMoney(check, club.currency)} гостю придёт ${formatMoney(Math.floor((check * p) / 100 / 100) * 100, club.currency)} бонусами. 1 бонус = 1 ₸, ими можно оплатить до ${share ?? 50}% следующего чека.`;
  })();

  return (
    <>
      <Section title="Лояльность без приложения">
        <div className="form loy-settings">
          <p className="hint">
            Гость называет номер телефона — касса узнаёт его, показывает бонусы или штампы и сама предлагает подарок. Без SMS и приложений.
            Бонусы и подарки — это скидка в чеке, в кассе и X/Z-отчётах только настоящие деньги.
          </p>
          {!canEdit && <p className="hint">Программу настраивает управляющий.</p>}
          <label className="check">
            <input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} />
            Включить программу — на кассе появится кнопка «Гость»
          </label>
          <Field label="Программа">
            <Segmented<LoyaltyProgram>
              value={draft.program}
              disabled={disabled}
              options={[
                { value: 'cashback', label: 'Кэшбэк бонусами' },
                { value: 'stamps', label: cafe ? 'Каждый N-й напиток в подарок' : 'Каждый N-й товар в подарок' },
              ]}
              onChange={(program) => setDraft((d) => ({ ...d, program }))}
            />
          </Field>
          {draft.program === 'cashback' ? (
            <div className="form-row">
              <Field label="Кэшбэк, %" hint="Сколько процентов от оплаты вернётся бонусами">
                <input inputMode="numeric" value={draft.cashbackPercent} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, cashbackPercent: e.target.value }))} />
              </Field>
              <Field label="Бонусами можно оплатить до, %" hint="Доля чека; остальное — деньгами">
                <input inputMode="numeric" value={draft.maxRedeemPercent} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, maxRedeemPercent: e.target.value }))} />
              </Field>
              <Field label="Бонусы сгорают через, дней" hint="0 — не сгорают">
                <input inputMode="numeric" value={draft.expiryDays} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, expiryDays: e.target.value }))} />
              </Field>
            </div>
          ) : (
            <>
              <div className="form-row">
                <Field label="В подарок каждый" hint="Например, 6 — пять покупает, шестой бесплатно">
                  <input inputMode="numeric" value={draft.stampsEvery} disabled={disabled} onChange={(e) => setDraft((d) => ({ ...d, stampsEvery: e.target.value }))} />
                </Field>
              </div>
              <Field label="Что считается" hint={draft.stampCategoryIds.length ? 'Выбранные категории меню' : 'По умолчанию — категории «Кофе…»'}>
                <div className="loy-cats" role="group" aria-label="Категории, за которые ставится штамп">
                  {categories.length === 0 && <span className="muted">В меню нет категорий</span>}
                  {categories.map((c) => (
                    <button key={c.id} type="button" className="chip" aria-pressed={counted.has(c.id)} disabled={disabled} onClick={() => toggleCategory(c.id)}>
                      {c.name}
                    </button>
                  ))}
                </div>
              </Field>
            </>
          )}
          <p className="hint">{example}</p>
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
      {canEdit && <Guests currency={club.currency} timezone={club.timezone} settings={server} online={online} />}
    </>
  );
}
