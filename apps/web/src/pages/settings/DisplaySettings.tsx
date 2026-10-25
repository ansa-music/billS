import { useState } from 'react';
import type { CardSize, ClubAdminView, DisplaySettings as Display, Theme, WaiterView } from '@bills/domain';
import { Field, Section, Segmented } from '../../ui.tsx';
import type { SectionProps } from './shared.tsx';
import { SaveBar, useDraft } from './shared.tsx';
import { BrandMark } from '../../BrandMark.tsx';

const LOGO_LIMIT = 200 * 1024;

/** «Экран зала»: title, logo, theme, card size, what a waiter sees. Applied live by Layout. */
export function DisplaySettings({ club, online, isBusy, run, onSaved, canEdit }: SectionProps & { canEdit: boolean }) {
  const { draft, setDraft, dirty, reset } = useDraft<Display>(club.settings.display);
  const [logoError, setLogoError] = useState<string | null>(null);
  const busy = isBusy('display');
  const disabled = !canEdit || !online;
  const logo = (draft.logoUrl ?? '').trim();
  const logoValid = logo === '' || /^(https?:\/\/|data:image\/|\/)/i.test(logo);

  const save = async () => {
    const res = await run<ClubAdminView>('display', '/api/club', {
      settings: {
        display: {
          title: draft.title?.trim() || null,
          logoUrl: logo || null,
          theme: draft.theme,
          cardSize: draft.cardSize,
          waiterSees: draft.waiterSees,
          showRoster: draft.showRoster,
        },
      },
    });
    if (res) {
      setDraft(res.settings.display);
      onSaved(res);
    }
  };

  const pickFile = (file: File | undefined) => {
    setLogoError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) return setLogoError('Нужна картинка (PNG, SVG, JPEG, WebP)');
    if (file.size > LOGO_LIMIT) return setLogoError(`Файл больше 200 КБ (${Math.round(file.size / 1024)} КБ) — уменьшите картинку`);
    const reader = new FileReader();
    reader.onload = () => setDraft((d) => ({ ...d, logoUrl: String(reader.result) }));
    reader.onerror = () => setLogoError('Не удалось прочитать файл');
    reader.readAsDataURL(file);
  };

  return (
    <Section title="Экран зала">
      <p className="hint">
        Настройки применяются ко всем планшетам клуба сразу после сохранения — тема и размер карточек видны и на этой странице.
      </p>
      <div className="form">
        <div className="form-row">
          <Field label="Заголовок" hint="Пусто — название клуба">
            <input
              value={draft.title ?? ''}
              maxLength={60}
              placeholder={club.name}
              disabled={disabled}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
          </Field>
          <Field label="Логотип (ссылка)" hint="http(s)://… или загрузите файл до 200 КБ" error={logoValid ? logoError : 'Ссылка должна начинаться с http(s):// или /'}>
            <input
              value={draft.logoUrl?.startsWith('data:') ? '(загруженный файл)' : (draft.logoUrl ?? '')}
              readOnly={draft.logoUrl?.startsWith('data:') ?? false}
              disabled={disabled}
              placeholder="https://…/logo.png"
              onChange={(e) => setDraft((d) => ({ ...d, logoUrl: e.target.value }))}
            />
          </Field>
        </div>
        <div className="logo-row">
          <div className="logo-preview" aria-label="Предпросмотр логотипа">
            {logo && logoValid ? <img src={logo} alt="" /> : <BrandMark />}
            <span>{(draft.title ?? '').trim() || club.name}</span>
          </div>
          <label className={`btn btn-small${disabled ? ' is-disabled' : ''}`}>
            Загрузить файл
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={disabled}
              onChange={(e) => {
                pickFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {logo && (
            <button type="button" className="btn btn-small btn-ghost" disabled={disabled} onClick={() => setDraft((d) => ({ ...d, logoUrl: null }))}>
              Убрать логотип
            </button>
          )}
        </div>
        <Field label="Тема">
          <Segmented<Theme>
            value={draft.theme}
            disabled={disabled}
            options={[
              { value: 'auto', label: 'Авто' },
              { value: 'dark', label: 'Тёмная' },
              { value: 'light', label: 'Светлая' },
            ]}
            onChange={(theme) => setDraft((d) => ({ ...d, theme }))}
          />
        </Field>
        <Field label="Карточки столов">
          <Segmented<CardSize>
            value={draft.cardSize}
            disabled={disabled}
            options={[
              { value: 'compact', label: 'Компактные' },
              { value: 'normal', label: 'Обычные' },
              { value: 'large', label: 'Крупные' },
            ]}
            onChange={(cardSize) => setDraft((d) => ({ ...d, cardSize }))}
          />
        </Field>
        <Field label="Официант видит на столе" hint="Кассир и управляющий видят сумму всегда">
          <Segmented<WaiterView>
            value={draft.waiterSees}
            disabled={disabled}
            options={[
              { value: 'amount', label: 'Сумму и время' },
              { value: 'time', label: 'Только время' },
            ]}
            onChange={(waiterSees) => setDraft((d) => ({ ...d, waiterSees }))}
          />
        </Field>
        <Field label="Экран входа" hint="Список имён удобнее; без него каждый вводит свой ключ на цифровой клавиатуре">
          <Segmented<'on' | 'off'>
            value={draft.showRoster ? 'on' : 'off'}
            disabled={disabled}
            options={[
              { value: 'on', label: 'Список имён' },
              { value: 'off', label: 'Только клавиатура' },
            ]}
            onChange={(v) => setDraft((d) => ({ ...d, showRoster: v === 'on' }))}
          />
        </Field>
        <SaveBar dirty={dirty} canSave={dirty && logoValid} busy={busy} disabled={disabled} onSave={() => void save()} onReset={reset} />
      </div>
    </Section>
  );
}
