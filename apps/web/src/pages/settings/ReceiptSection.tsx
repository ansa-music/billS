import { useMemo, useState } from 'react';
import type { ReceiptCopies, ReceiptField, ReceiptPaper, ReceiptSettings } from '@bills/domain';
import { defaultThanks, normalizeReceiptSettings, RECEIPT_LIMITS, receiptSettingsProblems, sampleReceiptCheck } from '@bills/domain';
import { useDevicePaper, setPaper } from '../../cash/print/paper.ts';
import { printReceipt, ReceiptPreview, receiptOf } from '../../cash/print/Receipt.tsx';
import { LogoError, toReceiptLogo } from '../../cash/print/receipt-logo.ts';
import { businessOf } from '../../cafe/cafe.ts';
import { Field, Section, Segmented } from '../../ui.tsx';
import type { SectionProps } from './shared.tsx';
import { SaveBar, useDraft } from './shared.tsx';

type TextKey = 'title' | 'address' | 'phone' | 'taxId' | 'header' | 'footer' | 'wifiName' | 'wifiPassword' | 'instagram' | 'qrUrl';

/** The form keeps texts as typed; blanks become null when saved. */
type Draft = Omit<ReceiptSettings, TextKey> & Record<TextKey, string>;

const TEXT_KEYS: readonly TextKey[] = ['title', 'address', 'phone', 'taxId', 'header', 'footer', 'wifiName', 'wifiPassword', 'instagram', 'qrUrl'];

function toDraft(s: ReceiptSettings): Draft {
  const texts = Object.fromEntries(TEXT_KEYS.map((k) => [k, k === 'instagram' && s.instagram ? `@${s.instagram}` : (s[k] ?? '')])) as Record<TextKey, string>;
  return { ...s, ...texts };
}

function toPatch(d: Draft): Partial<ReceiptSettings> {
  const texts = Object.fromEntries(TEXT_KEYS.map((k) => [k, d[k].trim() ? d[k] : null])) as Record<TextKey, string | null>;
  return {
    ...texts,
    logo: d.logo,
    showCashier: d.showCashier,
    showGuest: d.showGuest,
    showService: d.showService,
    paper: d.paper,
    copies: d.copies,
  };
}

/**
 * «Чек»: what the venue may put on its receipt — and nothing else. Amounts, lines, payments, the
 * order number, the date and «Не является фискальным чеком» come from the check (receipt.ts).
 * A live preview with a sample order sits next to the form. The manager and the administrator
 * («Директор» and «Управляющий» of a coffee shop): `receipt.edit`, checked by the HUB too.
 */
export function ReceiptSection({ club, online, isBusy, run, reload, canEdit }: SectionProps & { canEdit: boolean }) {
  const server = normalizeReceiptSettings(club.settings.receipt);
  const { draft, setDraft, dirty, reset } = useDraft<Draft>(toDraft(server));
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const devicePaper = useDevicePaper();
  const busy = isBusy('receipt');
  const disabled = !canEdit || !online;
  const business = businessOf(club.settings);
  const cafe = business === 'cafe';

  const patch = toPatch(draft);
  const problems = receiptSettingsProblems(patch, server);
  const errorOf = (field: ReceiptField) => problems.find((p) => p.field === field)?.message;
  // The preview shows what saving would give (the HUB normalizes the same way); a field still
  // being fixed keeps its saved value there.
  const previewSettings = normalizeReceiptSettings(withoutFields(patch, new Set(problems.map((p) => p.field))), server);
  const now = useMemo(() => Date.now(), []);
  const sample = useMemo(() => sampleReceiptCheck(now, club.currency, business), [now, club.currency, business]);
  const ctx = { club: { id: club.id, name: club.name, timezone: club.timezone, currency: club.currency }, settings: { ...club.settings, receipt: previewSettings } };
  const data = receiptOf(sample, ctx, { now });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const text = (key: TextKey, label: string, opts: { hint?: string; placeholder?: string; max?: number; inputMode?: 'tel' | 'numeric' | 'url' } = {}) => (
    <Field label={label} hint={opts.hint} error={errorOf(key)}>
      <input
        value={draft[key]}
        maxLength={(opts.max ?? RECEIPT_LIMITS[key]) + 10}
        placeholder={opts.placeholder}
        inputMode={opts.inputMode}
        disabled={disabled}
        aria-invalid={errorOf(key) ? true : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );

  const pickLogo = async (file: File | undefined) => {
    setLogoError(null);
    if (!file) return;
    setLogoBusy(true);
    try {
      const logo = await toReceiptLogo(file);
      setDraft((d) => ({ ...d, logo }));
    } catch (e) {
      setLogoError(e instanceof LogoError ? e.message : 'Не удалось обработать картинку');
    } finally {
      setLogoBusy(false);
    }
  };

  const save = async () => {
    const res = await run<ReceiptSettings>('receipt', '/api/receipt/settings', patch);
    if (res) {
      setDraft(toDraft(res));
      // This device prints on the club's width again, unless it was picked here on purpose.
      if (devicePaper === res.paper) setPaper(null);
      await reload('Чек сохранён');
    }
  };

  return (
    <Section title="Чек">
      <p className="hint">
        Что напечатать на чеке гостя. Суммы, позиции, оплату, номер заказа, дату и строку «Не является фискальным чеком» TS ставит сам — их здесь не поменять.
      </p>
      <div className="receipt-settings">
        <div className="form receipt-form">
          <h3 className="receipt-h">Заведение</h3>
          {text('title', 'Название на чеке', { placeholder: club.name, hint: 'Пусто — название из «Клуб»' })}
          {text('address', 'Адрес', { placeholder: 'ул. Абая 10, Алматы' })}
          <div className="form-row">
            {text('phone', 'Телефон', { placeholder: '+7 777 123 45 67', inputMode: 'tel' })}
            {text('taxId', 'БИН/ИИН', { placeholder: '12 цифр', inputMode: 'numeric' })}
          </div>
          <Field label="Логотип" hint="PNG или JPEG до 2 МБ. Станет чёрно-белым и маленьким — так его печатает чековый принтер." error={logoError ?? errorOf('logo')}>
            <div className="logo-row">
              {draft.logo && <img className="receipt-logo-thumb" src={draft.logo} alt="Логотип на чеке" />}
              <label className={`btn btn-small${disabled || logoBusy ? ' is-disabled' : ''}`}>
                {logoBusy ? 'Обрабатываем…' : draft.logo ? 'Заменить' : 'Загрузить'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  hidden
                  disabled={disabled || logoBusy}
                  onChange={(e) => {
                    void pickLogo(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              {draft.logo && (
                <button type="button" className="btn btn-small btn-ghost" disabled={disabled} onClick={() => set('logo', null)}>
                  Убрать
                </button>
              )}
            </div>
          </Field>
          {text('header', 'Строка вверху', { placeholder: 'Кофе с собой с 8:00' })}

          <h3 className="receipt-h">Внизу чека</h3>
          <Field label="Текст внизу" hint={`До ${RECEIPT_LIMITS.footerLines} строк. Пусто — «${defaultThanks(business)}»`} error={errorOf('footer')}>
            <textarea
              rows={3}
              value={draft.footer}
              maxLength={RECEIPT_LIMITS.footer + 10}
              placeholder={defaultThanks(business)}
              disabled={disabled}
              aria-invalid={errorOf('footer') ? true : undefined}
              onChange={(e) => set('footer', e.target.value)}
            />
          </Field>
          <div className="form-row">
            {text('wifiName', 'Wi-Fi: сеть', { placeholder: 'Coffee_Guest' })}
            {text('wifiPassword', 'Wi-Fi: пароль', { placeholder: 'не обязательно' })}
          </div>
          {text('instagram', 'Instagram', { placeholder: '@coffee.almaty' })}
          {text('qrUrl', 'Ссылка для QR-кода', { placeholder: 'https://2gis.kz/…', inputMode: 'url', hint: 'Одна ссылка: Instagram, 2GIS, меню. Гость наводит камеру — открывается страница.' })}

          <h3 className="receipt-h">Показывать</h3>
          <div className="receipt-flags">
            <label className="check">
              <input type="checkbox" checked={draft.showCashier} disabled={disabled} onChange={(e) => set('showCashier', e.target.checked)} />
              Кто принял оплату
            </label>
            {cafe && (
              <>
                <label className="check">
                  <input type="checkbox" checked={draft.showGuest} disabled={disabled} onChange={(e) => set('showGuest', e.target.checked)} />
                  Имя гостя
                </label>
                <label className="check">
                  <input type="checkbox" checked={draft.showService} disabled={disabled} onChange={(e) => set('showService', e.target.checked)} />
                  «Здесь / С собой»
                </label>
              </>
            )}
          </div>

          <h3 className="receipt-h">Принтер</h3>
          <div className="form-row">
            <Field label="Ширина ленты">
              <Segmented<ReceiptPaper>
                value={draft.paper}
                disabled={disabled}
                options={[
                  { value: '58', label: '58 мм' },
                  { value: '80', label: '80 мм' },
                ]}
                onChange={(paper) => set('paper', paper)}
              />
            </Field>
            <Field label="Копий" hint="Вторая — для бариста или кассы, печатается сразу после оплаты">
              <Segmented<'1' | '2'>
                value={String(draft.copies) as '1' | '2'}
                disabled={disabled}
                options={[
                  { value: '1', label: '1' },
                  { value: '2', label: '2' },
                ]}
                onChange={(v) => set('copies', Number(v) as ReceiptCopies)}
              />
            </Field>
          </div>
          {devicePaper && devicePaper !== draft.paper && (
            <p className="hint hint-warn">
              На этом устройстве выбран принтер {devicePaper} мм.{' '}
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setPaper(null)}>
                Печатать на {draft.paper} мм, как у заведения
              </button>
            </p>
          )}
          <SaveBar dirty={dirty} canSave={dirty && problems.length === 0 && !logoBusy} busy={busy} disabled={disabled} onSave={() => void save()} onReset={reset} />
          {!canEdit && <p className="hint">Менять чек могут {cafe ? 'директор и управляющий' : 'управляющий и администратор'}.</p>}
        </div>

        <aside className="receipt-side" aria-label="Пример чека">
          <div className="receipt-side-head">
            <strong>Так будет выглядеть</strong>
            <span className="hint">пример заказа · {draft.paper} мм</span>
          </div>
          <ReceiptPreview data={data} paper={draft.paper} />
          <button type="button" className="btn btn-small" onClick={() => printReceipt(sample, ctx, { now })}>
            Пробная печать
          </button>
          <PrintHelp cafe={cafe} />
        </aside>
      </div>
    </Section>
  );
}

/** The patch without the fields still being fixed: the preview keeps up with the rest. */
function withoutFields(patch: Partial<ReceiptSettings>, bad: ReadonlySet<ReceiptField>): Partial<ReceiptSettings> {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => !bad.has(key as ReceiptField))) as Partial<ReceiptSettings>;
}

/** How the receipt reaches the printer from a browser: the café owner sets Chrome up once. */
function PrintHelp({ cafe }: { cafe: boolean }) {
  if (!cafe) return null;
  return (
    <details className="receipt-help">
      <summary>Как печатать из браузера</summary>
      <ol>
        <li>Подключите чековый принтер к компьютеру или планшету и поставьте его драйвер. В настройках драйвера выберите бумагу-рулон 58 или 80 мм.</li>
        <li>Нажмите «Пробная печать». В окне печати Chrome: «Принтер» — ваш чековый принтер.</li>
        <li>«Другие настройки»: «Поля» — «Нет», снимите галочку «Верхний и нижний колонтитулы», «Масштаб» — 100 %.</li>
        <li>Нажмите «Печать». Chrome запомнит принтер и настройки — дальше достаточно нажать «Печать».</li>
        <li>Чтобы чек печатался без окна, на кассовом ПК поставьте приложение TS для ПК или запускайте Chrome с ключом <code>--kiosk-printing</code> — он печатает сразу на принтер по умолчанию.</li>
      </ol>
    </details>
  );
}
