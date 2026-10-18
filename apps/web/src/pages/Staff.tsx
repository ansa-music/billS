import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { CreateStaffRequest, Role, StaffListResponse, StaffView, UpdateStaffRequest } from '@bills/domain';
import { ASSIGNABLE_ROLES, ROLE_LABEL, canAssignRole } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { useAuth } from '../auth.ts';
import { Confirm, Empty, Field, Loading, Modal, Page, Section, Toast, useToast } from '../ui.tsx';
import { useCommands, useHub } from '../useHub.tsx';
import './staff.css';

const PIN_RE = /^\d{4,6}$/;

interface FormState {
  name: string;
  role: Role;
  pin: string;
  tableIds: string[];
}

/** Staff of the club: roles, PINs, assigned tables. Editing needs staff.edit. */
export function StaffPage() {
  const { state } = useHub();
  const { staff: me, role: myRole, can } = useAuth();
  const { toast, show, clear } = useToast();
  const { run, isBusy } = useCommands(show);

  const [staff, setStaff] = useState<StaffView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffView | 'new' | null>(null);
  const [pinFor, setPinFor] = useState<StaffView | null>(null);
  const [toggling, setToggling] = useState<StaffView | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchJson<StaffListResponse>('/api/staff');
      setStaff(r.staff);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  // The list is not part of /api/state, so refetch whenever the HUB reports a change.
  useEffect(() => {
    void load();
  }, [load, state?.serverNow]);

  const canEdit = can('staff.edit');
  const tables = state?.tables ?? [];
  const tableName = useMemo(() => new Map(tables.map((t) => [t.id, t.name])), [tables]);
  const assignable = myRole ? ASSIGNABLE_ROLES[myRole] : [];
  /** May the current user touch this row? The platform row is for the platform only. */
  const rowEditable = (s: StaffView) => canEdit && canAssignRole(myRole, s.role);

  const submitForm = async (form: FormState): Promise<boolean> => {
    const tableIds = form.role === 'waiter' ? form.tableIds : [];
    if (editing === 'new') {
      const body: CreateStaffRequest = { name: form.name.trim(), role: form.role, tableIds };
      if (form.pin) body.pin = form.pin;
      const created = await run<StaffView>('create', '/api/staff', body);
      if (!created) return false;
      show(`Сотрудник «${created.name}» добавлен`);
    } else if (editing) {
      const body: UpdateStaffRequest = { name: form.name.trim(), role: form.role, tableIds };
      const updated = await run<StaffView>(`update:${editing.id}`, `/api/staff/${editing.id}/update`, body);
      if (!updated) return false;
      show('Изменения сохранены');
    }
    await load();
    return true;
  };

  const submitPin = async (pin: string | null): Promise<boolean> => {
    if (!pinFor) return false;
    const body: UpdateStaffRequest = { pin };
    const updated = await run<StaffView>(`pin:${pinFor.id}`, `/api/staff/${pinFor.id}/update`, body);
    if (!updated) return false;
    show(pin === null ? `PIN у «${updated.name}» убран` : `PIN у «${updated.name}» обновлён`);
    await load();
    return true;
  };

  const toggleActive = async () => {
    if (!toggling) return;
    const body: UpdateStaffRequest = { isActive: !toggling.isActive };
    const updated = await run<StaffView>(`active:${toggling.id}`, `/api/staff/${toggling.id}/update`, body);
    setToggling(null);
    if (!updated) return;
    show(updated.isActive ? `«${updated.name}» снова в штате` : `«${updated.name}» уволен`);
    await load();
  };

  return (
    <Page
      title="Сотрудники и роли"
      subtitle="Кто работает в клубе и что ему можно."
      actions={
        canEdit && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')} disabled={!state}>
            Добавить сотрудника
          </button>
        )
      }
    >
      <p className="staff-hint">
        Вход по PIN появится на этапе 3; пока сотрудник выбирается из списка на экране входа.
      </p>

      <Section>
        {loadError && <p className="field-error">{loadError}</p>}
        {!staff && !loadError && <Loading />}
        {staff && staff.length === 0 && <Empty>В клубе ещё нет сотрудников</Empty>}
        {staff && staff.length > 0 && (
          <ul className="staff-list">
            {staff.map((s) => {
              const editable = rowEditable(s);
              const self = me?.id === s.id;
              return (
                <li key={s.id} className="staff-row" data-inactive={s.isActive ? undefined : ''}>
                  <span className="avatar" aria-hidden="true">
                    {initials(s.name)}
                  </span>
                  <div className="staff-who">
                    <span className="staff-name">
                      {s.name}
                      {self && <span className="muted"> (вы)</span>}
                    </span>
                    <span className="staff-role">{ROLE_LABEL[s.role]}</span>
                  </div>
                  <div className="staff-tags">
                    <span className={`tag ${s.role === 'superadmin' ? 'tag-warn' : 'tag-muted'}`}>{ROLE_LABEL[s.role]}</span>
                    <span className={`tag ${s.hasPin ? 'tag-ok' : 'tag-warn'}`}>{s.hasPin ? 'PIN задан' : 'нет PIN'}</span>
                    <span className={`tag ${s.isActive ? 'tag-ok' : 'tag-muted'}`}>{s.isActive ? 'работает' : 'уволен'}</span>
                  </div>
                  <div className="staff-tables">
                    {s.role === 'waiter' ? (
                      s.tableIds.length === 0 ? (
                        <span>все столы</span>
                      ) : (
                        s.tableIds.map((id) => (
                          <span key={id} className="chip" aria-disabled="true">
                            {tableName.get(id) ?? 'стол удалён'}
                          </span>
                        ))
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </div>
                  {editable && (
                    <div className="staff-actions">
                      <button type="button" className="btn btn-small" onClick={() => setEditing(s)}>
                        Изменить
                      </button>
                      <button type="button" className="btn btn-small" onClick={() => setPinFor(s)} disabled={!s.isActive}>
                        Сменить PIN
                      </button>
                      <button
                        type="button"
                        className={s.isActive ? 'btn btn-small btn-ghost' : 'btn btn-small'}
                        onClick={() => setToggling(s)}
                        disabled={self || isBusy(`active:${s.id}`)}
                        title={self ? 'Нельзя уволить самого себя' : undefined}
                      >
                        {s.isActive ? 'Уволить' : 'Вернуть'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {editing && (
        <StaffForm
          key={editing === 'new' ? 'new' : editing.id}
          staff={editing === 'new' ? null : editing}
          roles={assignable}
          tables={tables}
          busy={isBusy('create') || (editing !== 'new' && isBusy(`update:${editing.id}`))}
          onSubmit={submitForm}
          onClose={() => setEditing(null)}
        />
      )}

      {pinFor && (
        <PinForm
          key={pinFor.id}
          staff={pinFor}
          busy={isBusy(`pin:${pinFor.id}`)}
          onSubmit={submitPin}
          onClose={() => setPinFor(null)}
        />
      )}

      <Confirm
        open={toggling !== null}
        title={toggling?.isActive ? 'Уволить сотрудника?' : 'Вернуть сотрудника?'}
        text={
          toggling?.isActive
            ? `«${toggling.name}» больше не сможет входить и действовать в системе. История действий сохранится.`
            : `«${toggling?.name ?? ''}» снова появится на экране входа.`
        }
        confirmLabel={toggling?.isActive ? 'Уволить' : 'Вернуть'}
        danger={toggling?.isActive ?? false}
        busy={toggling ? isBusy(`active:${toggling.id}`) : false}
        onConfirm={() => void toggleActive()}
        onCancel={() => setToggling(null)}
      />

      <Toast message={toast} onClose={clear} />
    </Page>
  );
}

/** Add or edit: name, role, PIN (on add only), tables for a waiter. */
function StaffForm({
  staff,
  roles,
  tables,
  busy,
  onSubmit,
  onClose,
}: {
  staff: StaffView | null;
  roles: readonly Role[];
  tables: Array<{ id: string; name: string }>;
  busy: boolean;
  onSubmit: (form: FormState) => Promise<boolean>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    name: staff?.name ?? '',
    role: staff?.role ?? roles[roles.length - 1] ?? 'waiter',
    pin: '',
    tableIds: staff?.tableIds ?? [],
  }));
  const [error, setError] = useState<string | null>(null);

  // The row's current role stays selectable even if the editor could not assign it anew.
  const roleOptions = staff && !roles.includes(staff.role) ? [staff.role, ...roles] : roles;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return setError('Укажите имя');
    if (name.length > 80) return setError('Имя — не длиннее 80 символов');
    if (form.pin && !PIN_RE.test(form.pin)) return setError('PIN — от 4 до 6 цифр');
    setError(null);
    if (await onSubmit({ ...form, name })) onClose();
  };

  const toggleTable = (id: string) =>
    setForm((f) => ({
      ...f,
      tableIds: f.tableIds.includes(id) ? f.tableIds.filter((x) => x !== id) : [...f.tableIds, id],
    }));

  return (
    <Modal open title={staff ? 'Изменить сотрудника' : 'Новый сотрудник'} onClose={onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <Field label="Имя">
          <input
            type="text"
            value={form.name}
            maxLength={80}
            autoFocus
            autoComplete="off"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Роль">
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </Field>
        {!staff && (
          <Field label="PIN" hint="4–6 цифр, можно задать позже">
            <input
              className="pin-input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="new-password"
              maxLength={6}
              value={form.pin}
              onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })}
            />
          </Field>
        )}
        {form.role === 'waiter' && (
          <Field
            label="Столы официанта"
            hint={form.tableIds.length === 0 ? 'Ничего не выбрано — все столы' : `Выбрано: ${form.tableIds.length}`}
          >
            <div className="table-picker" role="group" aria-label="Столы">
              {tables.length === 0 && <span className="hint">В клубе нет активных столов</span>}
              {tables.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="chip"
                  aria-pressed={form.tableIds.includes(t.id)}
                  onClick={() => toggleTable(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </Field>
        )}
        {error && <p className="field-error">{error}</p>}
        <div className="form-actions modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {staff ? 'Сохранить' : 'Добавить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** New PIN for an employee, or remove it. */
function PinForm({
  staff,
  busy,
  onSubmit,
  onClose,
}: {
  staff: StaffView;
  busy: boolean;
  onSubmit: (pin: string | null) => Promise<boolean>;
  onClose: () => void;
}) {
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!PIN_RE.test(pin)) return setError('PIN — от 4 до 6 цифр');
    if (pin !== again) return setError('PIN не совпадает');
    setError(null);
    if (await onSubmit(pin)) onClose();
  };

  const remove = async () => {
    if (await onSubmit(null)) onClose();
  };

  return (
    <Modal open title={`PIN: ${staff.name}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="form-row">
          <Field label="Новый PIN">
            <input
              className="pin-input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="new-password"
              maxLength={6}
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Field label="Ещё раз">
            <input
              className="pin-input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="new-password"
              maxLength={6}
              value={again}
              onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </div>
        {error && <p className="field-error">{error}</p>}
        <div className="form-actions modal-actions">
          {staff.hasPin && (
            <button type="button" className="btn btn-ghost" onClick={() => void remove()} disabled={busy}>
              Убрать PIN
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}
