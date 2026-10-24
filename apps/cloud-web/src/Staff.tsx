/** Staff of one branch (#/clubs/:id/staff): people, their roles and six-digit keys. */
import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import type { CloudKeyView, CloudStaffView, IssueCloudKeyResponse, Role, StaffRole } from '@bills/domain';
import { ROLE_LABEL, STAFF_ROLES, normalizeRoles, rolesLabel } from '@bills/domain';
import { createStaff, issueStaffKey, listBranches, listStaff, revokeKey, updateStaff } from './api.ts';
import { CopyValue, ShownOnce } from './cabinet-ui.tsx';
import { useCompanyLicense } from './Company.tsx';
import { clubHref, usePoll } from './hooks.ts';
import { describeCabinetError, isKeyLive, kzDate, keyStateText, shortKeyProblem } from './license-form.ts';
import { Section, loadingText } from './shared.tsx';

function RolePicker({ roles, onChange }: { roles: Role[]; onChange: (r: Role[]) => void }) {
  return (
    <fieldset className="lic-fieldset">
      <legend>Роли (можно несколько)</legend>
      <div className="row wrap">
        {STAFF_ROLES.map((r: StaffRole) => (
          <label key={r} className="check">
            <input
              type="checkbox"
              checked={roles.includes(r)}
              onChange={(e) => onChange(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))}
            />
            {ROLE_LABEL[r]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function StaffForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; roles: Role[] };
  submitLabel: string;
  onSubmit: (v: { name: string; roles: Role[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [roles, setRoles] = useState<Role[]>(initial.roles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const norm = normalizeRoles(roles);
    if (!norm.ok) {
      setError(norm.message);
      return;
    }
    if (!name.trim()) {
      setError('Укажите имя');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), roles: norm.roles });
    } catch (err) {
      setError(describeCabinetError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="cab-form sub-panel" onSubmit={submit}>
      <label className="field grow">
        <span>Имя</span>
        <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <RolePicker roles={roles} onChange={setRoles} />
      {roles.length > 0 && <p className="hint">{rolesLabel(roles)}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Сохраняем…' : submitLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

const TERMS: Array<{ days: number | null; label: string }> = [
  { days: null, label: 'Без срока' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
  { days: 365, label: 'Год' },
];

function KeyForm({ staff, onIssued, onCancel }: { staff: CloudStaffView; onIssued: (r: IssueCloudKeyResponse) => void; onCancel: () => void }) {
  const [own, setOwn] = useState(false);
  const [key, setKey] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const typed = key.replace(/\s+/g, '');
    if (own) {
      const problem = shortKeyProblem(typed);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setBusy(true);
    try {
      onIssued(
        await issueStaffKey(staff.id, {
          ...(own ? { key: typed } : {}),
          ...(days !== null ? { expiresInDays: days } : {}),
        }),
      );
    } catch (err) {
      setError(describeCabinetError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="cab-form sub-panel" onSubmit={submit}>
      <h3>Простой ключ для «{staff.name}»</h3>
      <div className="seg" role="radiogroup" aria-label="Какой ключ">
        <button type="button" role="radio" aria-selected={!own} aria-checked={!own} onClick={() => setOwn(false)}>
          Случайный
        </button>
        <button type="button" role="radio" aria-selected={own} aria-checked={own} onClick={() => setOwn(true)}>
          Свои 6 цифр
        </button>
      </div>
      <div className="row wrap">
        {own && (
          <label className="field">
            <span>Ключ (6 цифр)</span>
            <input
              className="key-input short-key-input"
              inputMode="numeric"
              autoComplete="off"
              maxLength={7}
              pattern="\d{3}\s?\d{3}"
              value={key}
              onChange={(e) => setKey(e.target.value.replace(/[^\d\s]/g, ''))}
              autoFocus
            />
          </label>
        )}
        <label className="field">
          <span>Срок</span>
          <select value={days ?? ''} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}>
            {TERMS.map((t) => (
              <option key={t.label} value={t.days ?? ''}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">
        Ключ работает только в этом заведении и только для этого сотрудника. Старые ключи продолжают работать, пока их не
        отозвать.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Выдаём…' : 'Выдать ключ'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

function KeyList({ keys, busy, onRevoke }: { keys: CloudKeyView[]; busy: boolean; onRevoke: (k: CloudKeyView) => void }) {
  if (keys.length === 0) return <span className="hint">ключей нет</span>;
  const now = Date.now();
  return (
    <ul className="key-chips">
      {keys.map((k) => {
        const live = isKeyLive(k, now);
        return (
          <li key={k.id} className="key-chip" data-live={live || undefined}>
            <code>{k.prefix}</code>
            <span className="muted">
              {keyStateText(k, now)}
              {k.label ? ` · ${k.label}` : ''} · выдан {kzDate(k.createdAt)}
            </span>
            {live && (
              <button type="button" className="btn btn-small btn-link" disabled={busy} onClick={() => onRevoke(k)}>
                Отозвать
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type RowMode = 'view' | 'edit' | 'key';

function StaffRow({ staff, readOnly, onChanged }: { staff: CloudStaffView; readOnly: boolean; onChanged: () => void }) {
  const [mode, setMode] = useState<RowMode>('view');
  const [issued, setIssued] = useState<IssueCloudKeyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(describeCabinetError(err));
    } finally {
      setBusy(false);
    }
  }

  function revoke(k: CloudKeyView) {
    if (!confirm(`Отозвать ключ ${k.prefix} сотрудника «${staff.name}»? Войти по нему больше не получится.`)) return;
    void act(() => revokeKey(k.id));
  }

  return (
    <li className="list-item staff-item" data-inactive={!staff.isActive || undefined}>
      <div className="list-main">
        <strong>
          {staff.name}
          {!staff.isActive && <span className="tag tag-warn">не активен</span>}
        </strong>
        <span className="hint">{rolesLabel(staff.roles)}</span>
        <KeyList keys={staff.keys} busy={busy || readOnly} onRevoke={revoke} />
        {issued && (
          <ShownOnce onDone={() => setIssued(null)} note={<p className="hint">Сообщите ключ сотруднику лично. Вход — в кассе этого заведения.</p>}>
            <CopyValue value={issued.key} big />
          </ShownOnce>
        )}
        {mode === 'edit' && (
          <StaffForm
            initial={{ name: staff.name, roles: staff.roles }}
            submitLabel="Сохранить"
            onCancel={() => setMode('view')}
            onSubmit={async (v) => {
              await updateStaff(staff.id, v);
              setMode('view');
              onChanged();
            }}
          />
        )}
        {mode === 'key' && (
          <KeyForm
            staff={staff}
            onCancel={() => setMode('view')}
            onIssued={(r) => {
              setIssued(r);
              setMode('view');
              onChanged();
            }}
          />
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {mode === 'view' && !readOnly && (
        <span className="row wrap staff-actions">
          <label className="check">
            <input
              type="checkbox"
              checked={staff.isActive}
              disabled={busy}
              onChange={(e) => void act(() => updateStaff(staff.id, { isActive: e.target.checked }))}
            />
            активен
          </label>
          <button type="button" className="btn btn-small" onClick={() => setMode('edit')}>
            Изменить
          </button>
          <button type="button" className="btn btn-small btn-primary" disabled={!staff.isActive} onClick={() => setMode('key')}>
            Простой ключ
          </button>
        </span>
      )}
    </li>
  );
}

export function StaffPage({ clubId }: { clubId: string }) {
  const loadStaff = useCallback(() => listStaff(clubId), [clubId]);
  const staff = usePoll(loadStaff, 60_000);
  const loadBranches = useCallback(() => listBranches(), []);
  const branches = usePoll(loadBranches, 5 * 60_000);
  const lic = useCompanyLicense();
  const [adding, setAdding] = useState(false);

  const branch = branches.data?.find((b) => b.id === clubId) ?? null;
  const status = lic.data?.license?.status ?? null;
  // No license at all is read-only too; while it loads, let the cloud decide.
  const readOnly = lic.data ? (status ? status.readOnly : true) : false;
  const active = staff.data?.filter((s) => s.isActive).length ?? 0;
  const atLimit = status?.maxStaff != null && active >= status.maxStaff;

  return (
    <div className="company-page">
      <header className="club-page-head">
        <div>
          <a className="back" href="#/company">
            ← Заведения
          </a>
          <h2>{branch?.name ?? 'Филиал'}</h2>
          <p className="muted">Сотрудники и их ключи входа в кассу</p>
        </div>
        <div className="club-page-right">
          <nav className="tabs" aria-label="Разделы клуба">
            <a href={clubHref(clubId)}>Обзор</a>
            <a href={clubHref(clubId, 'shifts')}>Смены</a>
            <a href={clubHref(clubId, 'tariffs')}>Тарифы</a>
            <a href={clubHref(clubId, 'staff')} aria-current="page">
              Сотрудники
            </a>
          </nav>
        </div>
      </header>

      {readOnly && (
        <p className="lic-banner" data-tone="danger" role="status">
          <strong>Только чтение. </strong>
          {status?.message ?? 'Лицензия не выдана.'} Новых сотрудников и ключей не выдать.
        </p>
      )}

      <Section
        title="Сотрудники"
        aside={
          <span className="panel-aside">
            <span className="panel-total">{status?.maxStaff != null ? `${active} из ${status.maxStaff} активных` : active}</span>
            {!adding && !readOnly && (
              <button type="button" className="btn btn-small btn-primary" disabled={atLimit} onClick={() => setAdding(true)}>
                {atLimit ? `Лимит лицензии: ${status?.maxStaff} сотр.` : 'Новый сотрудник'}
              </button>
            )}
          </span>
        }
      >
        {adding && (
          <StaffForm
            initial={{ name: '', roles: ['waiter'] }}
            submitLabel="Добавить"
            onCancel={() => setAdding(false)}
            onSubmit={async (v) => {
              await createStaff({ clubId, ...v });
              setAdding(false);
              void staff.reload();
            }}
          />
        )}
        {staff.data ? (
          staff.data.length === 0 ? (
            <p className="empty">Сотрудников пока нет — добавьте первого и выдайте ему простой ключ</p>
          ) : (
            <ul className="plain-list">
              {staff.data.map((s) => (
                <StaffRow key={s.id} staff={s} readOnly={readOnly} onChanged={() => void staff.reload()} />
              ))}
            </ul>
          )
        ) : (
          <p className="empty">{loadingText(staff.error, 'сотрудников')}</p>
        )}
        <p className="hint">
          Управляющие и команда TS входят своими длинными ключами — здесь их нет. Изменения доходят до кассы заведения при
          следующей синхронизации (обычно за несколько секунд).
        </p>
      </Section>
    </div>
  );
}

/** «Сотрудники» in the menu (#/staff): one venue — its staff at once, several — pick one. */
export function StaffHome() {
  const loadBranches = useCallback(() => listBranches(), []);
  const branches = usePoll(loadBranches, 5 * 60_000);
  if (!branches.data) return <p className="boot-inline">{loadingText(branches.error, 'заведения')}</p>;
  const list = branches.data;
  if (list.length === 1 && list[0]) return <StaffPage clubId={list[0].id} />;
  if (list.length === 0) {
    return (
      <div className="company-page">
        <div className="empty-state">
          <h2>Сотрудников пока некуда добавить</h2>
          <p className="muted">Сначала добавьте заведение — потом сотрудников и их ключи входа в кассу.</p>
          <a className="btn btn-primary" href="#/company">
            Добавьте первое заведение
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="company-page">
      <Section title="Сотрудники · выберите заведение">
        <ul className="plain-list">
          {list.map((b) => (
            <li key={b.id} className="list-item">
              <div className="list-main">
                <strong>{b.name}</strong>
              </div>
              <a className="btn btn-small btn-primary" href={clubHref(b.id, 'staff')}>
                Сотрудники
              </a>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
