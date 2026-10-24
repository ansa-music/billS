import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { CreateStaffRequest, IssueKeyResponse, Role, StaffListResponse, StaffView, UpdateStaffRequest } from '@bills/domain';
import { ROLES, ROLE_LABEL, canAssignRoles, isPlatformRole, normalizeRoles, rolesLabel } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { useAuth } from '../auth.ts';
import { Confirm, Empty, Field, Loading, Modal, Page, Section, Toast, useToast } from '../ui.tsx';
import { useCommands, useHub, useServerNow } from '../useHub.tsx';
import { IssuedKey, KeysModal } from './staff/KeysModal.tsx';
import { CABINET_URL } from './settings/LicenseSection.tsx';
import { LoginAttempts } from './staff/LoginAttempts.tsx';
import './staff.css';

interface FormState {
  name: string;
  roles: Role[];
  tableIds: string[];
}

/** Manager and the platform: they do not count against the license's staff limit. */
const isLead = (r: Role) => r === 'manager' || isPlatformRole(r);

/**
 * Staff of the club: name and roles, the login key (issued right when a person
 * is added and shown big, with a QR code and a printed slip), assigned tables,
 * the login log. Editing needs staff.edit (and a license that is not read-only).
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
  /** Just added: the person and the key issued in the same step. */
  const [added, setAdded] = useState<{ staff: StaffView; issued: IssueKeyResponse | null; problem: string | null } | null>(null);
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
      const created = await formCmd.run<StaffView>('create', '/api/staff', body);
      if (!created) return false;
      // The key in the same step: a person without a key cannot log in.
      let problem: string | null = null;
      const issued = await formCmd.run<IssueKeyResponse>(`issue:${created.id}`, `/api/staff/${created.id}/keys`, {});
      if (!issued) problem = 'Ключ выдать не удалось — нажмите «Ключ входа» у сотрудника, чтобы попробовать ещё раз.';
      setFormError(null);
      setAdded({ staff: created, issued: issued ?? null, problem });
    } else if (editing) {
      const body: UpdateStaffRequest = { name: form.name.trim(), roles: form.roles, tableIds };
      const updated = await formCmd.run<StaffView>(`update:${editing.id}`, `/api/staff/${editing.id}/update`, body);
      if (!updated) return false;
      show('Изменения сохранены');
    }
    await load();
    return true;
  };

  const toggleActive = async () => {
    if (!toggling) return;
    const body: UpdateStaffRequest = { isActive: !toggling.isActive };
    const updated = await run<StaffView>(`active:${toggling.id}`, `/api/staff/${toggling.id}/update`, body);
    setToggling(null);
    if (!updated) return;
    show(updated.isActive ? `«${updated.name}» снова может входить` : `«${updated.name}» отключён`);
    await load();
  };

  const timeZone = state?.club.timezone ?? 'UTC';
  const atLimit = maxStaff !== null && activeCount >= maxStaff;

  return (
    <Page
      title="Сотрудники и роли"
      subtitle="Кто работает в заведении и что ему можно."
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
        Нажмите «Добавить сотрудника», впишите имя и роль — ключ входа из 6 цифр появится сразу. Передайте его человеку
        лично или распечатайте. Ролей может быть несколько, например «официант + кассир»: права складываются.
        {maxStaff !== null && ` По лицензии — до ${maxStaff} работающих сотрудников, сейчас ${activeCount}.`}
      </p>
      {editBlocked && <p className="blocked-note">{editBlocked}</p>}

      <Section>
        {loadError && <p className="field-error">{loadError}</p>}
        {!staff && !loadError && <Loading />}
        {staff && staff.length === 0 && <Empty>Сотрудников пока нет — нажмите «Добавить сотрудника».</Empty>}
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
                    {s.origin === 'cloud' && (
                      <span className="staff-cloud">
                        изменяется в{' '}
                        <a href={CABINET_URL} target="_blank" rel="noreferrer">
                          кабинете TS
                        </a>
                      </span>
                    )}
                  </div>
                  <div className="staff-tags">
                    <span className={`tag ${s.isActive ? 'tag-ok' : 'tag-muted'}`}>{s.isActive ? 'Активен' : 'Отключён'}</span>
                    <span className={`tag ${s.activeKeys > 0 ? 'tag-ok' : 'tag-warn'}`}>{s.activeKeys > 0 ? 'Ключ выдан' : 'Нет ключа'}</span>
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
                          Ключ входа
                        </button>
                      )}
                      {editable && (
                        <>
                          <button type="button" className="btn btn-small" onClick={() => setEditing(s)}>
                            Изменить
                          </button>
                          <button
                            type="button"
                            className={s.isActive ? 'btn btn-small btn-ghost' : 'btn btn-small'}
                            onClick={() => setToggling(s)}
                            disabled={self || isBusy(`active:${s.id}`)}
                            title={self ? 'Нельзя отключить самого себя' : undefined}
                          >
                            {s.isActive ? 'Отключить' : 'Включить снова'}
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

      {added && (
        <Modal open title={`${added.staff.name} — сотрудник добавлен`} onClose={() => setAdded(null)}>
          {added.issued ? (
            <IssuedKey
              issued={added.issued}
              name={added.staff.name}
              title="Ключ входа"
              doneLabel="Готово, ключ передан"
              onDone={() => setAdded(null)}
            />
          ) : (
            <>
              <p className="field-error" role="alert">
                {added.problem}
              </p>
              <div className="form-actions modal-actions">
                <button type="button" className="btn btn-primary" onClick={() => setAdded(null)}>
                  Понятно
                </button>
              </div>
            </>
          )}
        </Modal>
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
                ? 'Сотрудник заведён в кабинете TS — ключ ему выдаётся там.'
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
        title={toggling?.isActive ? 'Отключить сотрудника?' : 'Включить сотрудника снова?'}
        text={
          toggling?.isActive
            ? `«${toggling.name}» больше не сможет входить в кассу. История его действий сохранится.`
            : `«${toggling?.name ?? ''}» снова сможет входить по своему ключу.`
        }
        confirmLabel={toggling?.isActive ? 'Отключить' : 'Включить'}
        danger={toggling?.isActive ?? false}
        busy={toggling ? isBusy(`active:${toggling.id}`) : false}
        onConfirm={() => void toggleActive()}
        onCancel={() => setToggling(null)}
      />

      <Toast message={toast} onClose={clear} />
    </Page>
  );
}

/** Add or edit: name, roles (a set), tables for a waiter. Adding also issues the login key. */
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
            {staff ? 'Сохранить' : busy ? 'Добавляем…' : 'Добавить и выдать ключ'}
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
