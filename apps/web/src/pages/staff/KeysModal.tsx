import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AccessKeyView, IssueKeyRequest, IssueKeyResponse, KeyListResponse, StaffView } from '@bills/domain';
import { fetchJson } from '../../api.ts';
import { hrefFor } from '../../router.tsx';
import { Confirm, Empty, Field, Loading, Modal, formatDate, formatDateTime } from '../../ui.tsx';

const EXPIRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Бессрочно' },
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

/** Login link with the key prefilled, for a QR code or a message to the employee. */
function loginLinkFor(key: string): string {
  return `${window.location.origin}${window.location.pathname}${hrefFor('/login', { key })}`;
}

/**
 * Access keys of one employee: the list, revoking, and issuing a new one.
 * A freshly issued key is shown once; the HUB keeps only its hash.
 */
export function KeysModal({
  staff,
  canIssue,
  timeZone,
  now,
  run,
  isBusy,
  onChanged,
  onClose,
}: {
  staff: StaffView;
  /** The viewer may issue and revoke keys of this employee. */
  canIssue: boolean;
  timeZone: string;
  /** The HUB clock (ms), for "expired". */
  now: number;
  run: <T>(key: string, path: string, body?: object) => Promise<T | undefined>;
  isBusy: (key: string) => boolean;
  /** Called after a key was issued or revoked so the staff list can refresh its counters. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const [keys, setKeys] = useState<AccessKeyView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssueKeyResponse | null>(null);
  const [revoking, setRevoking] = useState<AccessKeyView | null>(null);

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
    const r = await run<IssueKeyResponse>(`issue:${staff.id}`, `/api/staff/${staff.id}/keys`, body);
    if (!r) return false;
    setIssued(r);
    await load();
    onChanged();
    return true;
  };

  const revoke = async () => {
    if (!revoking) return;
    const r = await run<AccessKeyView>(`revoke:${revoking.id}`, `/api/keys/${revoking.id}/revoke`);
    setRevoking(null);
    if (!r) return;
    await load();
    onChanged();
  };

  const sorted = keys ? sortKeys(keys, now) : null;

  return (
    <Modal open title={`Ключи доступа — ${staff.name}`} onClose={onClose}>
      <div className="keys-modal">
        {issued && <IssuedKey issued={issued} onDone={() => setIssued(null)} />}

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
                    <span className="key-prefix">{k.prefix}-…</span>
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
                  {canIssue && status === 'active' && (
                    <div className="key-actions">
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

        {canIssue && staff.isActive && (
          <IssueForm busy={isBusy(`issue:${staff.id}`)} onSubmit={issue} />
        )}
        {canIssue && !staff.isActive && (
          <p className="hint">Сотрудник уволен — новые ключи ему не выдаются. Верните его в штат, чтобы выдать ключ.</p>
        )}
      </div>

      <Confirm
        open={revoking !== null}
        title="Отозвать ключ?"
        text={
          revoking
            ? `Ключ ${revoking.prefix}-… перестанет работать сразу; все входы по нему закроются. Если он нужен, выдайте новый.`
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

/** Label and lifetime for a new key. */
function IssueForm({ busy, onSubmit }: { busy: boolean; onSubmit: (body: IssueKeyRequest) => Promise<boolean> }) {
  const [label, setLabel] = useState('');
  const [expires, setExpires] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: IssueKeyRequest = {};
    const l = label.trim();
    if (l) body.label = l;
    if (expires) body.expiresInDays = Number(expires);
    if (await onSubmit(body)) setLabel('');
  };

  return (
    <form className="form keys-issue" onSubmit={(e) => void submit(e)}>
      <h3>Выдать новый ключ</h3>
      <div className="form-row">
        <Field label="Подпись" hint="Необязательно: «планшет у бара», «телефон»">
          <input
            type="text"
            value={label}
            maxLength={80}
            autoComplete="off"
            onChange={(e) => setLabel(e.target.value)}
          />
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
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Выдаём…' : 'Выдать ключ'}
        </button>
      </div>
    </form>
  );
}

/** The one-time reveal of a new key, with copy buttons for the key and a login link. */
function IssuedKey({ issued, onDone }: { issued: IssueKeyResponse; onDone: () => void }) {
  const link = loginLinkFor(issued.key);
  return (
    <section className="key-issued" aria-live="polite">
      <h3>Новый ключ выдан</h3>
      <CopyBox value={issued.key} label="Ключ доступа" big />
      <p className="key-warning">Ключ показывается один раз. Передайте его сотруднику лично.</p>
      <CopyBox value={link} label="Ссылка для входа (ключ уже подставлен)" />
      <div className="form-actions">
        <button type="button" className="btn btn-small" onClick={onDone}>
          Скрыть
        </button>
      </div>
    </section>
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
