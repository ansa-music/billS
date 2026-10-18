import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { SessionStatus } from '@bills/domain';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';

/** Side panel on wide screens, bottom sheet on phones. Escape and the close button dismiss it. */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  headerExtra,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  headerExtra?: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" ref={panel} tabIndex={-1} aria-label={title} role="dialog">
        <header className="drawer-head">
          <div className="drawer-grip" aria-hidden="true" />
          <div className="drawer-title">
            <h2>{title}</h2>
            {subtitle && <div className="drawer-subtitle">{subtitle}</div>}
          </div>
          {headerExtra}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть" title="Закрыть (Esc)">
            <Icon name="close" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

const STATUS: Record<SessionStatus, { label: string; tone: string; icon: IconName }> = {
  OPENING: { label: 'Включаем свет', tone: 'warn', icon: 'lamp' },
  ACTIVE: { label: 'Идёт игра', tone: 'good', icon: 'play' },
  AWAITING_PAYMENT: { label: 'Ждёт оплаты', tone: 'info', icon: 'checks' },
  CLOSED: { label: 'Оплачено', tone: 'good', icon: 'check' },
  CANCELLED: { label: 'Отменено', tone: 'muted', icon: 'close' },
  FAILED: { label: 'Свет не включился', tone: 'danger', icon: 'alert' },
};

/** Status always carries an icon and a word, never colour alone. */
export function StatusBadge({ status }: { status: SessionStatus }) {
  const s = STATUS[status];
  return (
    <span className="status-badge" data-tone={s.tone}>
      <Icon name={s.icon} size={14} />
      {s.label}
    </span>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: IconName }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="segmented-item"
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={18} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function StatTile({
  label,
  value,
  detail,
  tone,
  href,
  children,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: 'info' | 'warn' | 'danger' | 'good';
  href?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {detail && <span className="stat-detail">{detail}</span>}
      {children}
    </>
  );
  return href ? (
    <a className="stat-tile" data-tone={tone} href={href}>
      {body}
    </a>
  ) : (
    <div className="stat-tile" data-tone={tone}>
      {body}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">
        <Icon name={icon} size={28} />
      </span>
      <p className="empty-state-title">{title}</p>
      {children && <div className="empty-state-text">{children}</div>}
    </div>
  );
}

export function SectionCard({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`section-card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="section-card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="section-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
