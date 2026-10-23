import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Small shared building blocks for the pages beyond the hall screen (settings,
 * bar, staff, owner). Styles in app.css. Inside the app shell the page title
 * is already in the top bar, so `.page-title` is hidden there (app.css).
 */

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
  /** Full width (dashboards). Kept for compatibility; the shell is full width anyway. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="page" data-wide={wide || undefined}>
      <header className="page-head" data-empty={!subtitle && !actions ? '' : undefined}>
        <div>
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-lead">{subtitle}</p>}
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

/** Placeholder rows the size of a list: the page does not jump when the data arrives. */
export function SkeletonList({ rows = 3, label = 'Загрузка…' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton-list" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden="true">
          <span className="skeleton" />
          <div>
            <span className="skeleton skeleton-line" style={{ width: `${70 - i * 12}%` }} />
            <span className="skeleton skeleton-line" style={{ width: `${45 - i * 6}%` }} />
          </div>
          <span className="skeleton skeleton-line" />
        </div>
      ))}
    </div>
  );
}

export function Loading({ online = true }: { online?: boolean }) {
  if (!online) return <p className="empty">Нет связи с HUB — ждём, данные появятся сами.</p>;
  return <SkeletonList />;
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
    <div className="seg-chips" role="group" aria-label={label}>
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
  const titleId = useId();
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
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // Only a click on the backdrop lands on the <dialog> itself.
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Закрыть">
          ×
        </button>
      </header>
      <div className="modal-body">{children}</div>
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
