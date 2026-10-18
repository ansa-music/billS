import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** Small shared building blocks for the pages beyond the hall screen. Styles in app.css. */

export function Page({
  title,
  subtitle,
  actions,
  wide,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Full width (dashboards); default is a readable 1100px column. */
  wide?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} — billS`;
  }, [title]);
  return (
    <section className="page" data-wide={wide || undefined}>
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function Section({
  title,
  aside,
  children,
  id,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="panel section" id={id}>
      {(title || aside) && (
        <header className="panel-head">
          {title && <h2>{title}</h2>}
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Loading({ online = true }: { online?: boolean }) {
  return <p className="empty">{online ? 'Загрузка…' : 'Нет связи с HUB — ждём…'}</p>;
}

/** Labelled form control. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

/** Toggle chips (one of several). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="chip"
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function useToast(): { toast: string | null; show: (message: string) => void; clear: () => void } {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const show = useCallback((m: string) => setToast(m), []);
  const clear = useCallback(() => setToast(null), []);
  return { toast, show, clear };
}

export function Toast({ message, onClose }: { message: string | null; onClose: () => void }) {
  if (!message) return null;
  return (
    <div className="toast" role="status" onClick={onClose}>
      {message}
    </div>
  );
}

/** Native dialog: confirmations and small forms. Closes on Escape and backdrop click. */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function Confirm({
  open,
  title,
  text,
  confirmLabel = 'Да',
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  text?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      {text && <p>{text}</p>}
      <div className="row wrap modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Отмена
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
          disabled={busy}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** YYYY-MM-DD in the club's time zone. */
export function localDate(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(epochMs))
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 18 окт., 18:05 in the club's time zone. */
export function formatDateTime(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(epochMs);
}

/** 18 окт. 2027 in the club's time zone — for dates far enough away that the year matters. */
export function formatDate(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(epochMs);
}
