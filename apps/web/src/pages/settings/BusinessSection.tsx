import { useState } from 'react';
import type { BusinessType, ClubAdminView } from '@bills/domain';
import { BUSINESS_TYPE_LABEL, BUSINESS_TYPES } from '@bills/domain';
import { businessOf } from '../../cafe/cafe.ts';
import { homeOf, navigate } from '../../router.tsx';
import { Confirm, Section } from '../../ui.tsx';
import type { SectionProps } from './shared.tsx';
import '../../cafe/cafe.css';

const ABOUT: Record<BusinessType, string> = {
  billiards: 'Столы, время игры, тарифы и лампы. Бар — заказы к столам.',
  cafe: 'Касса у стойки, экран бариста и экран заказов для гостей. Меню с добавками (размер, молоко, сироп). Столов, тарифов и ламп нет.',
};

/** «Тип заведения»: billiard club or coffee shop. Changes every screen of the branch; the manager decides. */
export function BusinessSection({ club, online, isBusy, run, onSaved, canEdit }: SectionProps & { canEdit: boolean }) {
  const current = businessOf(club.settings);
  const [asked, setAsked] = useState<BusinessType | null>(null);
  const busy = isBusy('business');

  const save = async (type: BusinessType) => {
    const res = await run<ClubAdminView>('business', '/api/club', { settings: { business: { type } } });
    setAsked(null);
    if (!res) return;
    onSaved(res, `Тип заведения: ${BUSINESS_TYPE_LABEL[businessOf(res.settings)]}`);
    navigate(homeOf(businessOf(res.settings)));
  };

  return (
    <Section title="Тип заведения">
      {!canEdit && <p className="hint">Тип заведения меняет управляющий.</p>}
      <div className="business-types" role="radiogroup" aria-label="Тип заведения">
        {BUSINESS_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={t === current}
            className="business-type"
            disabled={!canEdit || !online || busy}
            onClick={() => t !== current && setAsked(t)}
          >
            <strong>{BUSINESS_TYPE_LABEL[t]}</strong>
            <span>{ABOUT[t]}</span>
          </button>
        ))}
      </div>
      <Confirm
        open={asked !== null}
        title={asked ? `Сделать «${BUSINESS_TYPE_LABEL[asked]}»?` : ''}
        text={
          asked === 'cafe'
            ? 'Меню на всех экранах сменится: появятся «Касса», «Бариста» и «Экран заказов», а зал, тарифы и оборудование скроются. Игры, счета, смены и отчёты сохранятся. Вернуть можно здесь же.'
            : 'Вернутся зал, тарифы и оборудование, а «Касса», «Бариста» и «Экран заказов» скроются. Заказы, счета, смены и отчёты сохранятся. Вернуть можно здесь же.'
        }
        confirmLabel="Да, сменить"
        busy={busy}
        onConfirm={() => asked && void save(asked)}
        onCancel={() => setAsked(null)}
      />
    </Section>
  );
}
