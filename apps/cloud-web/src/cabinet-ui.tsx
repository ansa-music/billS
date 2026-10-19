/** Pieces shared by the platform and the manager cabinets: license chip, the license form, shown-once secrets. */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LicenseModule, LicenseStatus, LicenseView } from '@bills/domain';
import { LICENSE_MODULES, MODULE_LABEL } from '@bills/domain';
import type { LicenseDraft, TermChoice } from './license-form.ts';
import { LICENSE_STATE_LABEL, TERM_LABEL, licenseTermText, licenseTone, termPreview } from './license-form.ts';

/** Coloured state: active / expiring / last day / expired / blocked. */
export function LicenseChip({ status }: { status: LicenseStatus | null | undefined }) {
  const state = status?.state ?? 'missing';
  return (
    <span className="lic-chip" data-tone={licenseTone(state)} data-state={state}>
      {LICENSE_STATE_LABEL[state]}
    </span>
  );
}

/** «Действует · до 31.12.2026 · осталось 40 дней». */
export function LicenseLine({ status }: { status: LicenseStatus | null | undefined }) {
  return (
    <span className="lic-line">
      <LicenseChip status={status} />
      {status && <span className="muted">{licenseTermText(status)}</span>}
    </span>
  );
}

async function copyText(text: string, fallback: HTMLElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard (http, old browser): select the text so it can be copied by hand.
    if (fallback) {
      const range = document.createRange();
      range.selectNodeContents(fallback);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    return false;
  }
}

/** A value with a «Скопировать» button; `big` for a six-digit key to read out. */
export function CopyValue({ value, label, big = false }: { value: string; label?: string; big?: boolean }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLElement>(null);
  return (
    <div className="key-line copy-value">
      {label && <span className="copy-label">{label}</span>}
      <code ref={ref} className="key-text" data-big={big || undefined}>
        {value}
      </code>
      <button type="button" className="btn btn-small" onClick={() => void copyText(value, ref.current).then(setCopied)}>
        {copied ? 'Скопировано' : 'Скопировать'}
      </button>
    </div>
  );
}

/** A button that copies a long text without showing it (the signed license). */
export function CopyButton({ text, children }: { text: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={() =>
        void copyText(text, null).then((ok) => {
          if (ok) setCopied(true);
          else prompt('Скопируйте текст вручную', text);
        })
      }
    >
      {copied ? 'Скопировано' : children}
    </button>
  );
}

/** Secrets shown once: a warning, the values, «Готово». */
export function ShownOnce({ children, onDone, note }: { children: ReactNode; onDone: () => void; note?: ReactNode }) {
  return (
    <div className="new-key" role="status">
      <p className="new-key-warn">
        <strong>Показывается один раз.</strong> Облако хранит только отпечаток — потом посмотреть нельзя, можно только
        выдать новый.
      </p>
      {children}
      {note}
      <button type="button" className="btn" onClick={onDone}>
        Готово
      </button>
    </div>
  );
}

const TERMS_NEW: TermChoice[] = ['trial3', 'trial7', 'months', 'until'];
const TERMS_EXTEND: TermChoice[] = ['months', 'until', 'trial3', 'trial7', 'keep'];

/**
 * Term, limits and modules of a license. `current` — the client's license when extending:
 * adds «от конца текущего» and «Оставить срок» (change only limits / modules).
 */
export function LicenseFields({
  draft,
  onChange,
  current = null,
  now,
}: {
  draft: LicenseDraft;
  onChange: (d: LicenseDraft) => void;
  current?: LicenseView | null;
  now: number;
}) {
  const set = (patch: Partial<LicenseDraft>) => onChange({ ...draft, ...patch });
  const expired = current ? current.payload.validUntil <= now : true;
  const choices = (current ? TERMS_EXTEND : TERMS_NEW).filter((t) => t !== 'keep' || !expired);
  const preview = termPreview(draft, now, current);
  return (
    <div className="lic-form">
      <fieldset className="lic-fieldset">
        <legend>Срок</legend>
        <div className="seg seg-wrap" role="radiogroup" aria-label="Срок лицензии">
          {choices.map((t) => (
            <button key={t} type="button" role="radio" aria-selected={draft.term === t} aria-checked={draft.term === t} onClick={() => set({ term: t })}>
              {TERM_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="row wrap">
          {draft.term === 'months' && (
            <label className="field">
              <span>Месяцев</span>
              <input type="number" min={1} max={36} step={1} value={draft.months} onChange={(e) => set({ months: e.target.value })} />
            </label>
          )}
          {draft.term === 'until' && (
            <label className="field">
              <span>Последний день доступа</span>
              <input type="date" value={draft.until} onChange={(e) => set({ until: e.target.value })} />
            </label>
          )}
          {current && !expired && draft.term !== 'keep' && (
            <label className="check">
              <input type="checkbox" checked={draft.fromCurrentEnd} onChange={(e) => set({ fromCurrentEnd: e.target.checked })} />
              от конца текущего срока
            </label>
          )}
        </div>
        {preview && <p className="hint">{preview}</p>}
      </fieldset>

      <fieldset className="lic-fieldset">
        <legend>Лимиты</legend>
        <div className="row wrap">
          <label className="field">
            <span>Макс. филиалов</span>
            <input type="number" min={1} step={1} required value={draft.maxClubs} onChange={(e) => set({ maxClubs: e.target.value })} />
          </label>
          <label className="field">
            <span>Макс. столов в филиале</span>
            <input type="number" min={1} step={1} placeholder="без ограничения" value={draft.maxTables} onChange={(e) => set({ maxTables: e.target.value })} />
          </label>
          <label className="field">
            <span>Макс. сотрудников в филиале</span>
            <input type="number" min={1} step={1} placeholder="без ограничения" value={draft.maxStaff} onChange={(e) => set({ maxStaff: e.target.value })} />
          </label>
        </div>
      </fieldset>

      <fieldset className="lic-fieldset">
        <legend>Модули</legend>
        <div className="row wrap">
          {LICENSE_MODULES.map((m: LicenseModule) => (
            <label key={m} className="check">
              <input
                type="checkbox"
                checked={draft.modules[m]}
                onChange={(e) => set({ modules: { ...draft.modules, [m]: e.target.checked } })}
              />
              {MODULE_LABEL[m]}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
