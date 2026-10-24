import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AccessKeyView, IssueKeyRequest, IssueKeyResponse, KeyListResponse, StaffView } from '@bills/domain';
import { SHORT_KEY_LENGTH, isShortKeyShape, isWeakShortKey, usesLongKey } from '@bills/domain';
import { fetchJson } from '../../api.ts';
import { hrefFor } from '../../router.tsx';
import { Confirm, Empty, Field, Loading, Modal, formatDate, formatDateTime } from '../../ui.tsx';
import { useCommands } from '../../useHub.tsx';
import { printForm } from '../../cash/print/printForm.tsx';
import { QrCode } from '../../QrCode.tsx';

const EXPIRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Бессрочно' },
  { value: '1', label: '1 день' },
  { value: '7', label: '7 дней' },
  { value: '30', label: '30 дней' },
  { value: '90', label: '90 дней' },
  { value: '365', label: '365 дней' },
];

type KeyStatus = 'active' | 'revoked' | 'expired';

function statusOf(k: AccessKeyView, now: number): KeyStatus {
  if (k.revokedAt !== null) return 'revoked';
  if (k.expiresAt !== null && k.expiresAt <= now) return 'expired';
  return 'active';
}

const STATUS_LABEL: Record<KeyStatus, string> = { active: 'активен', revoked: 'отозван', expired: 'истёк' };
const STATUS_TAG: Record<KeyStatus, string> = { active: 'tag-ok', revoked: 'tag-muted', expired: 'tag-warn' };

/** Active keys first, newest first within a group. */
function sortKeys(keys: AccessKeyView[], now: number): AccessKeyView[] {
  const rank = (k: AccessKeyView) => (statusOf(k, now) === 'active' ? 0 : 1);
  return [...keys].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}

/** "MGR-7K3Q-…" for a long key; a short one's prefix ("••••42") is already a mask. */
function shownPrefix(k: AccessKeyView): string {
  return k.kind === 'short' ? k.prefix : `${k.prefix}-…`;
}

/** "318 540" — easier to read out and type. */
function spacedShortKey(key: string): string {
  return isShortKeyShape(key) ? `${key.slice(0, 3)} ${key.slice(3)}` : key;
}

/** Login link with the key prefilled, for a QR code or a message to the employee. */
function loginLinkFor(key: string): string {
  return `${window.location.origin}${window.location.pathname}${hrefFor('/login', { key })}`;
}

/**
 * Access keys of one person: the list, revoking, replacing, and issuing a new
 * one. Staff get a short key (6 digits, this branch only), a manager or the
 * platform a long one — the HUB picks the kind by the roles. A freshly issued
 * key is shown once; the HUB keeps only its hash.
 */
export function KeysModal({
  staff,
  canIssue,
  issueBlocked,
  timeZone,
  now,
  onChanged,
  onClose,
}: {
  staff: StaffView;
  /** The viewer may issue and revoke keys of this person right now. */
  canIssue: boolean;
  /** Why keys cannot be issued now (cloud staff, read-only license); shown instead of the form. */
  issueBlocked: string | null;
  timeZone: string;
  /** The HUB clock (ms), for "expired". */
  now: number;
  /** Called after a key was issued or revoked so the staff list can refresh its counters. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const [keys, setKeys] = useState<AccessKeyView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssueKeyResponse | null>(null);
  const [revoking, setRevoking] = useState<AccessKeyView | null>(null);
  /** «Сменить»: the new key replaces this one (it is revoked once the new key is issued). */
  const [replacing, setReplacing] = useState<AccessKeyView | null>(null);
  // Errors stay inside the dialog: a page toast would sit under its backdrop.
  const [error, setError] = useState<string | null>(null);
  const { run, isBusy } = useCommands(setError);
  const long = usesLongKey(staff.roles);

  const load = useCallback(async () => {
    try {
      const r = await fetchJson<KeyListResponse>(`/api/staff/${staff.id}/keys`);
      setKeys(r.keys);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [staff.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const issue = async (body: IssueKeyRequest): Promise<boolean> => {
    setError(null);
    const r = await run<IssueKeyResponse>(`issue:${staff.id}`, `/api/staff/${staff.id}/keys`, body);
    if (!r) return false;
    setIssued(r);
    if (replacing) {
      await run<AccessKeyView>(`revoke:${replacing.id}`, `/api/keys/${replacing.id}/revoke`);
      setReplacing(null);
    }
    await load();
    onChanged();
    return true;
  };

  const revoke = async () => {
    if (!revoking) return;
    setError(null);
    const r = await run<AccessKeyView>(`revoke:${revoking.id}`, `/api/keys/${revoking.id}/revoke`);
    setRevoking(null);
    if (!r) return;
    await load();
    onChanged();
  };

  const sorted = keys ? sortKeys(keys, now) : null;
  const issuing = canIssue && staff.isActive && !issueBlocked;

  return (
    <Modal open title={`Ключ входа — ${staff.name}`} onClose={onClose}>
      <div className="keys-modal">
        {issued && <IssuedKey issued={issued} name={staff.name} onDone={() => setIssued(null)} />}

        {loadError && <p className="field-error">{loadError}</p>}
        {!sorted && !loadError && <Loading />}
        {sorted && sorted.length === 0 && <Empty>Ключей ещё не было</Empty>}
        {sorted && sorted.length > 0 && (
          <ul className="keys-list">
            {sorted.map((k) => {
              const status = statusOf(k, now);
              return (
                <li key={k.id} className="key-row" data-status={status}>
                  <div className="key-main">
                    <span className="key-prefix">{shownPrefix(k)}</span>
                    <span className="tag tag-muted">{k.kind === 'short' ? '6 цифр' : 'длинный'}</span>
                    <span className={`tag ${STATUS_TAG[status]}`}>{STATUS_LABEL[status]}</span>
                    {k.label && <span className="key-label">{k.label}</span>}
                  </div>
                  <dl className="key-meta">
                    <div>
                      <dt>Выдан</dt>
                      <dd>
                        {formatDateTime(k.createdAt, timeZone)}
                        {k.createdBy && <span className="muted"> · {k.createdBy}</span>}
                      </dd>
                    </div>
                    <div>
                      <dt>Использован</dt>
                      <dd>{k.lastUsedAt !== null ? formatDateTime(k.lastUsedAt, timeZone) : 'не использовался'}</dd>
                    </div>
                    <div>
                      <dt>Действует</dt>
                      <dd>{k.expiresAt !== null ? `до ${formatDate(k.expiresAt, timeZone)}` : 'бессрочный'}</dd>
                    </div>
                    {k.revokedAt !== null && (
                      <div>
                        <dt>Отозван</dt>
                        <dd>
                          {formatDateTime(k.revokedAt, timeZone)}
                          {k.revokedBy && <span className="muted"> · {k.revokedBy}</span>}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {issuing && status === 'active' && (
                    <div className="key-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => {
                          setReplacing(k);
                          setError(null);
                        }}
                        disabled={replacing?.id === k.id}
                      >
                        Сменить
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        onClick={() => setRevoking(k)}
                        disabled={isBusy(`revoke:${k.id}`)}
                      >
                        Отозвать
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        {issuing && (
          <IssueForm
            long={long}
            replacing={replacing}
            busy={isBusy(`issue:${staff.id}`)}
            onSubmit={issue}
            onCancelReplace={() => setReplacing(null)}
          />
        )}
        {canIssue && !staff.isActive && (
          <p className="hint">Сотрудник уволен — новые ключи ему не выдаются. Верните его в штат, чтобы выдать ключ.</p>
        )}
        {issueBlocked && <p className="blocked-note">{issueBlocked}</p>}
      </div>

      <Confirm
        open={revoking !== null}
        title="Отозвать ключ?"
        text={
          revoking
            ? `Ключ ${shownPrefix(revoking)} перестанет работать сразу; все входы по нему закроются. Если он нужен, выдайте новый.`
            : undefined
        }
        confirmLabel="Отозвать"
        danger
        busy={revoking ? isBusy(`revoke:${revoking.id}`) : false}
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />
    </Modal>
  );
}

/**
 * Lifetime and label for a new key. A short key is random, or six digits the
 * manager picks (checked for weak ones before sending; the HUB checks again).
 */
function IssueForm({
  long,
  replacing,
  busy,
  onSubmit,
  onCancelReplace,
}: {
  long: boolean;
  replacing: AccessKeyView | null;
  busy: boolean;
  onSubmit: (body: IssueKeyRequest) => Promise<boolean>;
  onCancelReplace: () => void;
}) {
  const [label, setLabel] = useState('');
  const [expires, setExpires] = useState('');
  const [own, setOwn] = useState(false);
  const [digits, setDigits] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ownProblem = !own
    ? null
    : digits.length !== SHORT_KEY_LENGTH
      ? `Нужно ровно ${SHORT_KEY_LENGTH} цифр`
      : isWeakShortKey(digits)
        ? 'Слишком простой ключ: не берите одинаковые цифры, подряд (123456) или повторы (121212)'
        : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (ownProblem) return setError(ownProblem);
    setError(null);
    const body: IssueKeyRequest = {};
    const l = label.trim();
    if (l) body.label = l;
    if (expires) body.expiresInDays = Number(expires);
    if (!long && own) body.key = digits;
    if (await onSubmit(body)) {
      setLabel('');
      setDigits('');
    }
  };

  const title = replacing
    ? `Сменить ключ ${replacing.kind === 'short' ? replacing.prefix : `${replacing.prefix}-…`}`
    : long
      ? 'Выдать длинный ключ'
      : 'Выдать простой ключ';

  return (
    <form className="form keys-issue" onSubmit={(e) => void submit(e)}>
      <h3>{title}</h3>
      {replacing && <p className="hint">Старый ключ отзовётся сразу после выдачи нового.</p>}
      {long ? (
        <p className="hint">Управляющему выдаётся длинный ключ — он работает во всех филиалах.</p>
      ) : (
        <>
          <p className="hint">Простой ключ — 6 цифр, работает только в этом филиале. Удобно вводить на планшете.</p>
          <div className="seg-chips" role="radiogroup" aria-label="Какой ключ">
            <button type="button" className="chip" role="radio" aria-checked={!own} aria-pressed={!own} onClick={() => setOwn(false)}>
              Случайный
            </button>
            <button type="button" className="chip" role="radio" aria-checked={own} aria-pressed={own} onClick={() => setOwn(true)}>
              Свои 6 цифр
            </button>
          </div>
          {own && (
            <Field label="Ключ" error={digits.length === SHORT_KEY_LENGTH ? ownProblem : null}>
              <input
                className="short-key-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                maxLength={SHORT_KEY_LENGTH}
                value={digits}
                placeholder="______"
                onChange={(e) => {
                  setDigits(e.target.value.replace(/\D/g, '').slice(0, SHORT_KEY_LENGTH));
                  setError(null);
                }}
              />
            </Field>
          )}
        </>
      )}
      <div className="form-row">
        <Field label="Подпись" hint="Необязательно: «планшет у бара», «телефон»">
          <input type="text" value={label} maxLength={80} autoComplete="off" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Срок действия">
          <select value={expires} onChange={(e) => setExpires(e.target.value)}>
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || (own && !long && ownProblem !== null)}>
          {busy ? 'Выдаём…' : replacing ? 'Выдать новый вместо старого' : long ? 'Выдать ключ' : 'Выдать простой ключ'}
        </button>
        {replacing && (
          <button type="button" className="btn btn-ghost" onClick={onCancelReplace} disabled={busy}>
            Не менять
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * The one-time reveal of a new key: the digits big, «Скопировать», a QR code
 * that opens the login page with the key filled in, and a printed slip for
 * the receipt printer. Also shown right after a person is added (Staff.tsx).
 */
export function IssuedKey({
  issued,
  name,
  onDone,
  doneLabel = 'Скрыть',
  title = 'Новый ключ выдан',
}: {
  issued: IssueKeyResponse;
  /** Whose key it is: printed on the slip. */
  name?: string;
  onDone: () => void;
  doneLabel?: string;
  title?: string;
}) {
  const link = loginLinkFor(issued.key);
  const short = isShortKeyShape(issued.key);
  return (
    <section className="key-issued" aria-live="polite">
      <h3>{title}</h3>
      {short && (
        <p className="short-key-reveal" aria-label={`Ключ ${issued.key.split('').join(' ')}`}>
          {spacedShortKey(issued.key)}
        </p>
      )}
      <CopyBox value={issued.key} label={short ? 'Ключ входа — 6 цифр' : 'Ключ входа'} big={!short} />
      <p className="key-warning">Ключ показывается один раз. Передайте его сотруднику лично или распечатайте.</p>
      <div className="key-qr">
        <QrCode value={link} size={148} label="QR-код для входа" />
        <p className="hint">
          Сотрудник наводит камеру телефона или планшета на этот код — откроется вход в кассу с уже подставленным ключом.
        </p>
      </div>
      <details className="support-details">
        <summary>Ссылка для входа</summary>
        <CopyBox value={link} label="Ссылка (ключ уже подставлен)" />
      </details>
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => printKeySlip(issued.key, link, name)}>
          Распечатать
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          {doneLabel}
        </button>
      </div>
    </section>
  );
}

/** A slip for the receipt printer: name, the key, the QR code to log in. */
function printKeySlip(key: string, link: string, name?: string) {
  printForm(
    <div className="pf-center">
      <div className="pf-head">
        <div className="pf-title">Ключ входа в кассу TS</div>
        {name && <div className="pf-club">{name}</div>}
      </div>
      <div className="pf-sep" />
      <div className="pf-title" style={{ fontSize: '2.2em', letterSpacing: '0.1em' }}>
        {spacedShortKey(key)}
      </div>
      <div className="pf-sep" />
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <QrCode value={link} size={150} label="QR-код для входа" />
      </div>
      <div className="pf-notice">Никому не показывайте этот ключ</div>
    </div>,
  );
}

/** Read-only text with «Скопировать»; falls back to selecting the text where the clipboard is unavailable. */
function CopyBox({ value, label, big }: { value: string; label: string; big?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<'ok' | 'manual' | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 3000);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(value);
      setCopied('ok');
    } catch {
      // Plain http on the LAN has no clipboard API: let the person copy by hand.
      ref.current?.focus();
      ref.current?.select();
      setCopied('manual');
    }
  };

  return (
    <div className="copy-box" data-big={big || undefined}>
      <span className="copy-label">{label}</span>
      <div className="copy-row">
        <input ref={ref} className="copy-value" type="text" readOnly value={value} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn btn-small" onClick={() => void copy()}>
          Скопировать
        </button>
      </div>
      {copied === 'ok' && <span className="hint">Скопировано</span>}
      {copied === 'manual' && <span className="hint">Буфер обмена недоступен — текст выделен, скопируйте его вручную</span>}
    </div>
  );
}
