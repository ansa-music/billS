import { useId, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './cash.css';

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Pinned under the scrolling body: errors and the main buttons stay visible. */
  footer?: ReactNode;
  className?: string;
}

/**
 * A native modal <dialog>: the browser keeps focus inside, Escape closes it and focus
 * returns to where it was. It is shown while mounted. The first element marked
 * `data-autofocus` gets the focus. Rendered into <body> so panel styles do not leak in.
 */
export function Modal({ title, onClose, children, footer, className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // Escape normally arrives as a cancelable `cancel`; without a recent user gesture the
  // browser closes the dialog itself, and only `close` tells us.
  return createPortal(
    <dialog
      ref={ref}
      className={className ? `modal ${className}` : 'modal'}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (!ref.current?.open) onClose();
      }}
    >
      <header className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="modal-close" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </dialog>,
    document.body,
  );
}

export function FormError({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p className="form-error" role="alert">
      {error}
    </p>
  );
}

/** Money is typed in major units ("2 070", "2070,5") and parsed with parseMoney. */
export function MoneyField({
  label,
  value,
  onChange,
  autoFocus,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="money-input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-autofocus={autoFocus ? '' : undefined}
      />
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  maxLength = 500,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  maxLength?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        autoComplete="off"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-autofocus={autoFocus ? '' : undefined}
      />
    </label>
  );
}
