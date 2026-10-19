import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { CreateStaffRequest, Role, StaffListResponse, StaffView, UpdateStaffRequest } from '@bills/domain';
import { ROLES, ROLE_LABEL, canAssignRoles, isPlatformRole, normalizeRoles, rolesLabel } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { useAuth } from '../auth.ts';
import { Confirm, Empty, Field, Loading, Modal, Page, Section, Toast, useToast } from '../ui.tsx';
import { useCommands, useHub, useServerNow } from '../useHub.tsx';
import { KeysModal } from './staff/KeysModal.tsx';
import { LoginAttempts } from './staff/LoginAttempts.tsx';
import './staff.css';

const PIN_RE = /^\d{4,6}$/;

interface FormState {
  name: string;
  roles: Role[];
  pin: string;
  tableIds: string[];
}

/** Manager and the platform: they do not count against the license's staff limit. */
const isLead = (r: Role) => r === 'manager' || isPlatformRole(r);

/**
 * Staff of the club: role sets, access keys, PINs, assigned tables, the login
 * log. Editing needs staff.edit (and a license that is not read-only).
 */
export function StaffPage() {
  const { state, canNow, blockedReason, license } = useHub();
  const { staff: me, roles: myRoles, can } = useAuth();
  const { toast, show, clear } = useToast();
  const { run, isBusy } = useCommands(show);
  // Errors of the add / edit form go into the form: a toast would sit under the dialog's backdrop.
  const [formError, setFormError] = useState<string | null>(null);
  const formCmd = useCommands(setFormError);
  const now = useServerNow();

  const [staff, setStaff] = useState<StaffView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffView | 'new' | null>(null);
  const [pinFor, setPinFor] = useState<StaffView | null>(null);
  const [toggling, setToggling] = useState<StaffView | null>(null);
  const [keysFor, setKeysFor] = useState<StaffView | null>(null);

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

  /** The role allows it; the license may still put the club in read-only mode. */
  const roleCanEdit = can('staff.edit');
  const canEdit = canNow('staff.edit');
  const editBlocked = roleCanEdit ? blockedReason('staff.edit') : null;
  const tables = state?.tables ?? [];
  const tableName = useMemo(() => new Map(tables.map((t) => [t.id, t.name])), [tables]);
  /** Roles the viewer may give, one by one (the HUB checks the whole set again). */
  const assignable = useMemo(() => ROLES.filter((r) => canAssignRoles(myRoles, [r])), [myRoles]);
  /** The viewer may manage this person at all (roles top-down). */
  const manages = (s: StaffView) => roleCanEdit && canAssignRoles(myRoles, s.roles);
  /** People from the manager's cloud cabinet are edited there. */
  const rowEditable = (s: StaffView) => canEdit && s.origin !== 'cloud' && manages(s);
  /** Keys: the people one manages, and one's own row. */
  const rowKeysVisible = (s: StaffView) => manages(s) || me?.id === s.id;
  const activeCount = staff?.filter((s) => s.isActive && !s.roles.some(isLead)).length ?? 0;
  const maxStaff = license?.maxStaff ?? null;

  const submitForm = async (form: FormState): Promise<boolean> => {
    setFormError(null);
    const tableIds = form.roles.includes('waiter') ? form.tableIds : [];
    if (editing === 'new') {
      const body: CreateStaffRequest = { name: form.name.trim(), roles: form.roles, tableIds };
      if (form.pin) body.pin = form.pin;
      const created = await formCmd.run<StaffView>('create', '/api/staff', body);
      if (!created) return false;
      show(`Сотрудник «${created.name}» добавлен`);
    } else if (editing) {
      const body: UpdateStaffRequest = { name: form.name.trim(), roles: form.roles, tableIds };
      const updated = await formCmd.run<StaffView>(`update:${editing.id}`, `/api/staff/${editing.id}/update`, body);
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

  const timeZone = state?.club.timezone ?? 'UTC';
  const atLimit = maxStaff !== null && activeCount >= maxStaff;

  return (
    <Page
      title="Сотрудники и роли"
      subtitle="Кто работает в клубе и что ему можно."
      actions={
        canEdit && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setEditing('new')}
            disabled={!state}
            title={atLimit ? 'Лимит сотрудников по лицензии исчерпан' : undefined}
          >
            Добавить сотрудника
          </button>
        )
      }
    >
      <p className="staff-hint">
        Сотрудники входят по простому ключу из 6 цифр — он работает только в этом филиале. Управляющий входит по
        длинному ключу (MGR-…). Ролей у человека может быть несколько, например «официант + кассир»: права
        складываются. Сотрудников, заведённых в облачном кабинете, меняют там.
        {maxStaff !== null && ` По лицензии — до ${maxStaff} работающих сотрудников, сейчас ${activeCount}.`}
      </p>
      {editBlocked && <p className="blocked-note">{editBlocked}</p>}

      <Section>
        {loadError && <p className="field-error">{loadError}</p>}
        {!staff && !loadError && <Loading />}
        {staff && staff.length === 0 && <Empty>В клубе ещё нет сотрудников</Empty>}
        {staff && staff.length > 0 && (
          <ul className="staff-list">
            {staff.map((s) => {
              const editable = rowEditable(s);
              const self = me?.id === s.id;
              const keysVisible = rowKeysVisible(s);
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
                    <span className="staff-role">{rolesLabel(s.roles)}</span>
                  </div>
                  <div className="staff-tags">
                    {s.origin === 'cloud' && (
                      <span className="tag tag-muted" title="Заведён в облачном кабинете управляющего — меняется там">
                        из кабинета
                      </span>
                    )}
                    {s.roles.some(isLead) && <span className="tag tag-warn">{rolesLabel(s.roles)}</span>}
                    <span className={`tag ${s.activeKeys > 0 ? 'tag-ok' : 'tag-warn'}`}>
                      {s.activeKeys > 0 ? `ключей: ${s.activeKeys}` : 'нет ключа'}
                    </span>
                    <span className={`tag ${s.hasPin ? 'tag-ok' : 'tag-muted'}`}>{s.hasPin ? 'PIN задан' : 'нет PIN'}</span>
                    <span className={`tag ${s.isActive ? 'tag-ok' : 'tag-muted'}`}>{s.isActive ? 'работает' : 'уволен'}</span>
                  </div>
                  <div className="staff-tables">
                    {s.roles.includes('waiter') ? (
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
                  {(editable || keysVisible) && (
                    <div className="staff-actions">
                      {keysVisible && (
                        <button type="button" className="btn btn-small" onClick={() => setKeysFor(s)}>
                          Ключи
                        </button>
                      )}
                      {editable && (
                        <>
                          <button type="button" className="btn btn-small" onClick={() => setEditing(s)}>
                            Изменить
                          </button>
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() => setPinFor(s)}
                            disabled={!s.isActive}
                          >
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
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {can('staff.view') && <LoginAttempts timeZone={timeZone} />}

      {editing && (
        <StaffForm
          key={editing === 'new' ? 'new' : editing.id}
          staff={editing === 'new' ? null : editing}
          roles={assignable}
          tables={tables}
          busy={formCmd.isBusy('create') || (editing !== 'new' && formCmd.isBusy(`update:${editing.id}`))}
          serverError={formError}
          onSubmit={submitForm}
          onClose={() => {
            setEditing(null);
            setFormError(null);
          }}
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

      {keysFor && (
        <KeysModal
          key={keysFor.id}
          staff={staff?.find((s) => s.id === keysFor.id) ?? keysFor}
          canIssue={rowEditable(keysFor)}
          issueBlocked={
            !manages(keysFor)
              ? null
              : keysFor.origin === 'cloud'
                ? 'Сотрудник заведён в облачном кабинете — ключи ему выдаются там.'
                : editBlocked
          }
          timeZone={timeZone}
          now={now}
          onChanged={() => void load()}
          onClose={() => setKeysFor(null)}
        />
      )}

      <Confirm
        open={toggling !== null}
        title={toggling?.isActive ? 'Уволить сотрудника?' : 'Вернуть сотрудника?'}
        text={
          toggling?.isActive
            ? `«${toggling.name}» больше не сможет входить по ключу и действовать в системе. История действий сохранится.`
            : `«${toggling?.name ?? ''}» снова сможет входить по своим ключам.`
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

/** Add or edit: name, roles (a set), PIN (on add only), tables for a waiter. */
function StaffForm({
  staff,
  roles,
  tables,
  busy,
  serverError,
  onSubmit,
  onClose,
}: {
  staff: StaffView | null;
  /** Roles the editor may give. */
  roles: readonly Role[];
  tables: Array<{ id: string; name: string }>;
  busy: boolean;
  /** The HUB refused (LICENSE_STAFF_LIMIT, a role that cannot be given…). */
  serverError: string | null;
  onSubmit: (form: FormState) => Promise<boolean>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    name: staff?.name ?? '',
    roles: staff ? [...staff.roles] : roles.includes('waiter') ? ['waiter'] : roles.slice(-1),
    pin: '',
    tableIds: staff?.tableIds ?? [],
  }));
  const [error, setError] = useState<string | null>(null);

  // The person's current roles stay visible, even one the editor could not give anew.
  const roleOptions = ROLES.filter((r) => roles.includes(r) || form.roles.includes(r));

  const toggleRole = (r: Role) =>
    setForm((f) => {
      if (f.roles.includes(r)) return { ...f, roles: f.roles.filter((x) => x !== r) };
      // Manager and the platform roles stand alone: picking one clears the rest, and the other way round.
      const kept: Role[] = isLead(r) ? [] : f.roles.filter((x) => !isLead(x));
      return { ...f, roles: ROLES.filter((x) => x === r || kept.includes(x)) };
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return setError('Укажите имя');
    if (name.length > 80) return setError('Имя — не длиннее 80 символов');
    const checked = normalizeRoles(form.roles);
    if (!checked.ok) return setError(checked.message);
    const added = checked.roles.filter((r) => !staff?.roles.includes(r));
    if (added.some((r) => !roles.includes(r))) {
      return setError('Эту роль вы назначить не можете');
    }
    if (form.pin && !PIN_RE.test(form.pin)) return setError('PIN — от 4 до 6 цифр');
    setError(null);
    if (await onSubmit({ ...form, name, roles: checked.roles })) onClose();
  };

  const toggleTable = (id: string) =>
    setForm((f) => ({
      ...f,
      tableIds: f.tableIds.includes(id) ? f.tableIds.filter((x) => x !== id) : [...f.tableIds, id],
    }));

  const shown = error ?? serverError;

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
        <Field
          label="Роли"
          hint={form.roles.length > 0 ? `Права складываются: ${rolesLabel(form.roles)}` : 'Отметьте хотя бы одну роль'}
        >
          <div className="role-picker" role="group" aria-label="Роли">
            {roleOptions.map((r) => {
              const allowed = roles.includes(r);
              return (
                <label key={r} className="role-option" data-disabled={allowed ? undefined : ''}>
                  <input type="checkbox" checked={form.roles.includes(r)} disabled={!allowed} onChange={() => toggleRole(r)} />
                  <span>{ROLE_LABEL[r]}</span>
                </label>
              );
            })}
          </div>
        </Field>
        {!staff && (
          <Field label="PIN" hint="4–6 цифр, можно задать позже. Это не ключ входа — ключ выдаётся кнопкой «Ключи».">
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
        {form.roles.includes('waiter') && (
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
        {shown && (
          <p className="field-error" role="alert">
            {shown}
          </p>
        )}
        <div className="form-actions modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || form.roles.length === 0}>
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
