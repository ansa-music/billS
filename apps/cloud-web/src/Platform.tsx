/** Platform cabinet (owner and tech of TS): clients, their managers and licenses. */
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ClientView, CreateClientResponse, IssuedLongKey, ManagerInviteResponse, ManagerTempPasswordResponse, PlatformMe } from '@bills/domain';
import { ROLE_LABEL, can } from '@bills/domain';
import {
  SUPABASE_MODE,
  blockClient,
  createClient,
  inviteManager,
  issueManagerKey,
  listClients,
  managerTempPassword,
  setLicense,
} from './api.ts';
import { BrandMark } from './BrandMark.tsx';
import { CopyButton, CopyValue, LicenseFields, LicenseLine, ShownOnce } from './cabinet-ui.tsx';
import { formatDateTime } from './format.ts';
import { usePoll } from './hooks.ts';
import type { LicenseDraft } from './license-form.ts';
import {
  branchesUsage,
  buildTermsRequest,
  describeCabinetError,
  draftFromLicense,
  emptyLicenseDraft,
  kzDate,
  modulesText,
  planLabel,
} from './license-form.ts';
import { OfflineBanner, Section, loadingText } from './shared.tsx';

const ZONE = 'Asia/Almaty';

/** What happened to the invitation letter, in words. */
function inviteText(res: ManagerInviteResponse): string {
  return res.status === 'invited'
    ? `Приглашение отправлено на ${res.email}: управляющий откроет письмо, задаст пароль и попадёт в кабинет.`
    : `У ${res.email} уже есть учётная запись — отправлено письмо для смены пароля.`;
}

/**
 * Supabase: the manager's access to the cabinet — the invitation letter again, or a temporary
 * password (no mail needed) shown once, to pass on in a messenger.
 */
function ManagerAccess({ companyId, invite }: { companyId: string; invite?: { result: ManagerInviteResponse | null; error: string | null } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(invite?.error ?? null);
  const [sent, setSent] = useState<ManagerInviteResponse | null>(invite?.result ?? null);
  const [temp, setTemp] = useState<ManagerTempPasswordResponse | null>(null);

  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeCabinetError(err));
    } finally {
      setBusy(false);
    }
  }

  function tempPassword() {
    if (!confirm('Выдать управляющему временный пароль? Прежний пароль перестанет работать; при первом входе управляющий задаст свой.')) return;
    void act(async () => {
      setSent(null);
      setTemp(await managerTempPassword(companyId));
    });
  }

  return (
    <div className="sub-panel">
      {sent && (
        <p className="saved" role="status">
          {inviteText(sent)}
        </p>
      )}
      {temp && (
        <ShownOnce
          onDone={() => setTemp(null)}
          note={
            <p className="hint">
              Передайте управляющему в мессенджере: вход в кабинет — почта {temp.email} и этот пароль. При первом входе кабинет
              попросит задать свой пароль.
            </p>
          }
        >
          <CopyValue label="Временный пароль" value={temp.password} />
        </ShownOnce>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              setTemp(null);
              setSent(await inviteManager(companyId));
            })
          }
        >
          Отправить приглашение ещё раз
        </button>
        <button type="button" className="btn" disabled={busy} onClick={tempPassword}>
          Временный пароль
        </button>
      </div>
    </div>
  );
}

function NewClient({ onDone }: { onDone: () => void }) {
  const [companyName, setCompanyName] = useState('');
  const [managerName, setManagerName] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [password, setPassword] = useState('');
  const [draft, setDraft] = useState<LicenseDraft>(emptyLicenseDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateClientResponse | null>(null);
  const [invite, setInvite] = useState<{ result: ManagerInviteResponse | null; error: string | null }>({ result: null, error: null });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!SUPABASE_MODE && password && password.length < 8) {
      setError('Пароль — не короче 8 символов (или оставьте пустым — облако придумает сам)');
      return;
    }
    const built = buildTermsRequest(draft, Date.now());
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    try {
      const res = await createClient({
        companyName: companyName.trim(),
        managerName: managerName.trim(),
        managerEmail: managerEmail.trim(),
        ...(!SUPABASE_MODE && password ? { managerPassword: password } : {}),
        license: built.request,
      });
      // Supabase: the manager gets the invitation letter at once (a failure does not undo the client).
      if (SUPABASE_MODE) {
        try {
          setInvite({ result: await inviteManager(res.client.companyId), error: null });
        } catch (err) {
          setInvite({ result: null, error: `Клиент создан, но письмо не отправлено: ${describeCabinetError(err)}. Используйте «Временный пароль» ниже.` });
        }
      }
      setCreated(res);
    } catch (err) {
      setError(describeCabinetError(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Section title={`Клиент «${created.client.companyName}» создан`}>
        <ShownOnce
          onDone={onDone}
          note={
            <p className="hint">
              Ключ управляющего — для входа на HUB филиалов. {SUPABASE_MODE
                ? `В облачный кабинет управляющий входит по почте ${managerEmail.trim()} и паролю, который задаст по ссылке из письма-приглашения.`
                : `В облачный кабинет — по почте ${managerEmail.trim()} и паролю.`}
            </p>
          }
        >
          <CopyValue label="Ключ управляющего" value={created.managerKey.key} />
          {created.managerPassword && <CopyValue label="Пароль кабинета" value={created.managerPassword} />}
        </ShownOnce>
        {SUPABASE_MODE && <ManagerAccess companyId={created.client.companyId} invite={invite} />}
      </Section>
    );
  }

  return (
    <Section title="Новый клиент" aside={<button type="button" className="btn btn-small" onClick={onDone}>Отмена</button>}>
      <form className="cab-form" onSubmit={submit}>
        <div className="row wrap">
          <label className="field grow">
            <span>Название компании</span>
            <input required maxLength={120} value={companyName} onChange={(e) => setCompanyName(e.target.value)} autoFocus />
          </label>
        </div>
        <div className="row wrap">
          <label className="field grow">
            <span>Имя управляющего</span>
            <input required maxLength={120} value={managerName} onChange={(e) => setManagerName(e.target.value)} />
          </label>
          <label className="field grow">
            <span>E-mail управляющего</span>
            <input type="email" required value={managerEmail} onChange={(e) => setManagerEmail(e.target.value)} />
          </label>
          {!SUPABASE_MODE && (
            <label className="field grow">
              <span>Пароль (необязательно — сгенерируется)</span>
              <input type="text" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          )}
        </div>
        <LicenseFields draft={draft} onChange={setDraft} now={Date.now()} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Создаём…' : 'Создать клиента'}
          </button>
        </div>
      </form>
    </Section>
  );
}

type CardMode = 'view' | 'license' | 'block';

function ClientCard({
  client,
  editable,
  onChanged,
  onClose,
}: {
  client: ClientView;
  editable: boolean;
  onChanged: (c: ClientView) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<CardMode>('view');
  const [draft, setDraft] = useState<LicenseDraft>(() => draftFromLicense(client.license));
  const [reason, setReason] = useState(client.blockedReason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<IssuedLongKey | null>(null);
  const lic = client.license;
  const now = Date.now();

  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeCabinetError(err));
    } finally {
      setBusy(false);
    }
  }

  function saveLicense(e: FormEvent) {
    e.preventDefault();
    const built = buildTermsRequest(draft, Date.now(), lic);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    void act(async () => {
      onChanged(await setLicense(client.companyId, built.request));
      setMode('view');
    });
  }

  function saveBlock(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      onChanged(await blockClient(client.companyId, !client.blocked, client.blocked ? undefined : reason.trim() || undefined));
      setMode('view');
    });
  }

  function newManagerKey() {
    if (!confirm(`Выдать новый ключ управляющего для «${client.companyName}»? Старые ключи продолжат работать, пока их не отзовут.`)) return;
    void act(async () => setNewKey(await issueManagerKey(client.companyId)));
  }

  return (
    <Section
      title={client.companyName}
      aside={
        <button type="button" className="btn btn-small" onClick={onClose}>
          Закрыть
        </button>
      }
    >
      <dl className="facts">
        <div>
          <dt>Лицензия</dt>
          <dd>
            <LicenseLine status={lic?.status} />
          </dd>
        </div>
        {lic && (
          <>
            <div>
              <dt>План</dt>
              <dd>
                {planLabel(lic.payload.plan)} · с {kzDate(lic.payload.validFrom)} · выдана {formatDateTime(lic.payload.issuedAt, ZONE)}
              </dd>
            </div>
            <div>
              <dt>Лимиты</dt>
              <dd>
                филиалов {lic.payload.maxClubs} · столов {lic.payload.maxTables ?? 'без ограничения'} · сотрудников{' '}
                {lic.payload.maxStaff ?? 'без ограничения'}
              </dd>
            </div>
            <div>
              <dt>Модули</dt>
              <dd>{modulesText(lic.payload.modules)}</dd>
            </div>
          </>
        )}
        {client.blocked && (
          <div>
            <dt>Блокировка</dt>
            <dd className="danger-text">{client.blockedReason || 'без причины'}</dd>
          </div>
        )}
        <div>
          <dt>Управляющие</dt>
          <dd>
            {client.managers.length === 0
              ? '—'
              : client.managers.map((m) => (
                  <span key={m.id} className="cell-stack">
                    {m.name} <span className="muted">{m.email}</span>
                  </span>
                ))}
          </dd>
        </div>
        <div>
          <dt>Филиалы</dt>
          <dd>
            {client.branches.length === 0
              ? 'пока нет'
              : client.branches.map((b) => (
                  <span key={b.id} className="cell-stack">
                    {b.name}{' '}
                    <span className="muted">
                      {b.hubIds.length ? b.hubIds.join(', ') : 'HUB не подключён'}
                      {b.lastSeenAt ? ` · на связи ${formatDateTime(b.lastSeenAt, ZONE)}` : ''}
                    </span>
                  </span>
                ))}
          </dd>
        </div>
        <div>
          <dt>Клиент с</dt>
          <dd>{formatDateTime(client.createdAt, ZONE)}</dd>
        </div>
      </dl>

      {SUPABASE_MODE && editable && mode === 'view' && client.managers.length > 0 && <ManagerAccess key={client.companyId} companyId={client.companyId} />}

      {newKey && (
        <ShownOnce onDone={() => setNewKey(null)}>
          <CopyValue label="Новый ключ управляющего" value={newKey.key} />
        </ShownOnce>
      )}

      {mode === 'license' && (
        <form className="cab-form sub-panel" onSubmit={saveLicense}>
          <h3>{lic ? 'Продлить или изменить лицензию' : 'Выдать лицензию'}</h3>
          <LicenseFields draft={draft} onChange={setDraft} current={lic} now={now} />
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Сохраняем…' : 'Сохранить и переподписать'}
            </button>
            <button type="button" className="btn" onClick={() => setMode('view')}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {mode === 'block' && (
        <form className="cab-form sub-panel" onSubmit={saveBlock}>
          <h3>{client.blocked ? 'Разблокировать клиента' : 'Заблокировать клиента'}</h3>
          {client.blocked ? (
            <p className="hint">HUB'ы клиента получат лицензию без блокировки при следующей синхронизации.</p>
          ) : (
            <>
              <p className="hint">
                Все филиалы перейдут в режим «только чтение»: новые игры не открываются, данные сохраняются.
              </p>
              <label className="field grow">
                <span>Причина</span>
                <input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например: не оплачен счёт" />
              </label>
            </>
          )}
          <div className="row">
            <button type="submit" className={client.blocked ? 'btn btn-primary' : 'btn btn-danger'} disabled={busy}>
              {client.blocked ? 'Разблокировать' : 'Заблокировать'}
            </button>
            <button type="button" className="btn" onClick={() => setMode('view')}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {mode === 'view' && (
        <div className="row wrap">
          {editable && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setDraft(draftFromLicense(lic));
                  setMode('license');
                }}
              >
                {lic ? 'Продлить / изменить' : 'Выдать лицензию'}
              </button>
              <button type="button" className="btn" onClick={() => setMode('block')}>
                {client.blocked ? 'Разблокировать' : 'Заблокировать'}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={newManagerKey}>
                Новый ключ управляющего
              </button>
            </>
          )}
          {lic && <CopyButton text={lic.signed}>Скопировать лицензию</CopyButton>}
        </div>
      )}
      {lic && mode === 'view' && (
        <p className="hint">«Скопировать лицензию» — подписанный текст для HUB без облака: HUB → «Лицензия» → «Вставить».</p>
      )}
    </Section>
  );
}

function ClientsTable({ clients, onOpen, selected }: { clients: ClientView[]; onOpen: (id: string) => void; selected: string | null }) {
  if (clients.length === 0) return <p className="empty">Клиентов пока нет</p>;
  return (
    <div className="grid-wrap">
      <table className="grid clients-grid">
        <thead>
          <tr>
            <th>Компания</th>
            <th>Управляющий</th>
            <th>Филиалы</th>
            <th>Лицензия</th>
            <th>Модули</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const lic = c.license;
            const manager = c.managers[0];
            return (
              <tr key={c.companyId} data-selected={selected === c.companyId || undefined}>
                <td>
                  <strong>{c.companyName}</strong>
                </td>
                <td>
                  {manager ? (
                    <span className="cell-stack">
                      {manager.name}
                      <span className="cell-sub">{manager.email}</span>
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="tnum">{branchesUsage(c.branches.length, lic?.payload.maxClubs)}</td>
                <td>
                  <span className="cell-stack">
                    <LicenseLine status={lic?.status} />
                    {lic && <span className="cell-sub">{planLabel(lic.payload.plan)}</span>}
                  </span>
                </td>
                <td>{modulesText(lic?.payload.modules)}</td>
                <td>
                  <button type="button" className="btn btn-small" onClick={() => onOpen(c.companyId)}>
                    Открыть
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PlatformCabinet({
  me,
  online,
  onSignOut,
  onSwitchToManager,
}: {
  me: PlatformMe;
  online: boolean;
  onSignOut: () => void;
  /** The same person also manages a client (Supabase e-mail sign-in). */
  onSwitchToManager?: () => void;
}) {
  const load = useCallback(() => listClients(), []);
  const { data, error, reload } = usePoll(load, 60_000);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, ClientView>>({});
  const editable = can(me.role, 'clients.edit');
  // A saved card shows the cloud's answer at once; the next poll brings the same and drops it.
  useEffect(() => setOverrides({}), [data]);

  const clients = (data ?? []).map((c) => overrides[c.companyId] ?? c);
  const current = clients.find((c) => c.companyId === selected) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <BrandMark />
          <div>
            <h1>Платформа TS</h1>
            <p className="muted">Клиенты и лицензии</p>
          </div>
        </a>
        <div className="topbar-right">
          <span className="conn" data-online={online || undefined}>
            {online ? 'Облако на связи' : 'Нет связи с облаком'}
          </span>
          <span className="owner">
            {me.name} · {ROLE_LABEL[me.role]}
          </span>
          {onSwitchToManager && (
            <button type="button" className="btn btn-small btn-link" onClick={onSwitchToManager}>
              Кабинет управляющего
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={onSignOut}>
            Выйти
          </button>
        </div>
      </header>
      <OfflineBanner online={online} />

      {can(me.role, 'platform.view') ? (
        <>
          {creating && (
            <NewClient
              onDone={() => {
                setCreating(false);
                void reload();
              }}
            />
          )}
          {current && (
            <ClientCard
              key={current.companyId}
              client={current}
              editable={editable}
              onChanged={(c) => {
                setOverrides((o) => ({ ...o, [c.companyId]: c }));
                void reload();
              }}
              onClose={() => setSelected(null)}
            />
          )}
          <Section
            title="Клиенты"
            aside={
              <span className="panel-aside">
                <span className="panel-total">{data?.length ?? ''}</span>
                {editable && !creating && (
                  <button type="button" className="btn btn-small btn-primary" onClick={() => setCreating(true)}>
                    Новый клиент
                  </button>
                )}
              </span>
            }
          >
            {data ? (
              <ClientsTable
                clients={clients}
                selected={selected}
                onOpen={(id) => {
                  setSelected(id);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              />
            ) : (
              <p className="empty">{loadingText(error, 'клиентов')}</p>
            )}
          </Section>
        </>
      ) : (
        <p className="empty">Недостаточно прав для кабинета платформы</p>
      )}
    </div>
  );
}
