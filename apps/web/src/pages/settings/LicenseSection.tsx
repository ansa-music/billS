import { useCallback, useEffect, useState } from 'react';
import type { LicensePayload, LicenseResponse, LicenseStatus } from '@bills/domain';
import { LICENSE_MODULES, MODULE_LABEL, peekLicense } from '@bills/domain';
import { HubRequestError, command, fetchJson } from '../../api.ts';
import { actorName } from '../../auth.ts';
import { LICENSE_STATE_LABEL, licenseTone } from '../../license.tsx';
import { Field, Loading, Section, formatDate, formatDateTime } from '../../ui.tsx';

const PLAN_LABEL: Record<LicensePayload['plan'], string> = { trial: 'Пробная', paid: 'Оплаченная' };
const TONE_TAG = { ok: 'tag tag-ok', warn: 'tag tag-warn', danger: 'tag tag-danger' } as const;

const limit = (n: number | null | undefined) => (n == null ? 'без ограничений' : String(n));

/** GET /api/license, refetched when the HUB reports a change (`version`). */
export function useLicenseInfo(version: number): {
  info: LicenseResponse | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [info, setInfo] = useState<LicenseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setInfo(await fetchJson<LicenseResponse>('/api/license'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, version]);
  return { info, error, reload };
}

/** State, term, limits and modules of the license in force; the HUB id for support. */
export function LicenseFacts({ info, timeZone }: { info: LicenseResponse; timeZone: string }) {
  const s: LicenseStatus = info.status;
  return (
    <div className="license-facts">
      <p className="license-state">
        <span className={TONE_TAG[licenseTone(s.state)]}>{LICENSE_STATE_LABEL[s.state]}</span>
        {!info.enforced && <span className="tag tag-muted">не проверяется на этом HUB</span>}
        {s.readOnly && info.enforced && <span className="tag tag-danger">только чтение</span>}
      </p>
      {s.message && <p className="hint">{s.message}</p>}
      <dl className="facts">
        <div>
          <dt>Клиент</dt>
          <dd>{s.companyName ?? '—'}</dd>
        </div>
        <div>
          <dt>Тип</dt>
          <dd>{s.plan ? PLAN_LABEL[s.plan] : '—'}</dd>
        </div>
        <div>
          <dt>Действует до</dt>
          <dd>
            {s.validUntil !== null ? formatDateTime(s.validUntil, timeZone) : '—'}
            {s.daysLeft !== null && s.validUntil !== null && <span className="muted"> · осталось {s.daysLeft} дн.</span>}
          </dd>
        </div>
        <div>
          <dt>Филиалов</dt>
          <dd>{s.maxClubs ?? '—'}</dd>
        </div>
        <div>
          <dt>Столов в филиале</dt>
          <dd>{limit(s.maxTables)}</dd>
        </div>
        <div>
          <dt>Сотрудников в филиале</dt>
          <dd>{limit(s.maxStaff)}</dd>
        </div>
        <div>
          <dt>Модули</dt>
          <dd>
            {LICENSE_MODULES.filter((m) => s.modules[m])
              .map((m) => MODULE_LABEL[m])
              .join(', ') || 'нет'}
          </dd>
        </div>
        <div>
          <dt>Установлена</dt>
          <dd>
            {info.installedAt !== null ? formatDateTime(info.installedAt, timeZone) : '—'}
            {info.source && <span className="muted"> · {info.source === 'cloud' ? 'из облака' : 'вручную'}</span>}
          </dd>
        </div>
        <div className="license-hub">
          <dt>ID этого HUB (для поддержки)</dt>
          <dd>
            <code>{info.hubId}</code>
          </dd>
        </div>
        {s.licenseId && (
          <div>
            <dt>Номер лицензии</dt>
            <dd>
              <code>{s.licenseId}</code>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** What a pasted license says, before it is sent (the signature is checked by the HUB). */
function Preview({ payload, hubId, timeZone }: { payload: LicensePayload; hubId: string; timeZone: string }) {
  const forThisHub = payload.hubIds.includes(hubId);
  return (
    <div className="license-preview">
      <h4>В этой лицензии</h4>
      <dl className="facts">
        <div>
          <dt>Клиент</dt>
          <dd>{payload.companyName}</dd>
        </div>
        <div>
          <dt>Тип</dt>
          <dd>{PLAN_LABEL[payload.plan]}</dd>
        </div>
        <div>
          <dt>Срок</dt>
          <dd>
            {formatDate(payload.validFrom, timeZone)} — {formatDateTime(payload.validUntil, timeZone)}
          </dd>
        </div>
        <div>
          <dt>Филиалов · столов · сотрудников</dt>
          <dd>
            {payload.maxClubs} · {limit(payload.maxTables)} · {limit(payload.maxStaff)}
          </dd>
        </div>
        <div>
          <dt>Модули</dt>
          <dd>
            {LICENSE_MODULES.filter((m) => payload.modules[m])
              .map((m) => MODULE_LABEL[m])
              .join(', ') || 'нет'}
          </dd>
        </div>
      </dl>
      {payload.blocked && <p className="field-error">Лицензия помечена как приостановленная — клуб останется в режиме «только чтение».</p>}
      {!forThisHub && (
        <p className="field-error">
          Лицензия выдана для других HUB ({payload.hubIds.join(', ') || 'список пуст'}), а этот — <code>{hubId}</code>. HUB её не
          примет.
        </p>
      )}
    </div>
  );
}

/** Paste a signed license `TS1.…` and install it (license.install). */
function InstallForm({ hubId, timeZone, online, onInstalled }: { hubId: string; timeZone: string; online: boolean; onInstalled: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const trimmed = text.trim();
  const payload = trimmed ? peekLicense(trimmed) : null;

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      await command('/api/license', actorName(), { license: trimmed });
      setText('');
      setDone(true);
      onInstalled();
    } catch (e) {
      setError(
        e instanceof HubRequestError && e.code === 'LICENSE_INVALID' && !/[а-яё]/i.test(e.message)
          ? 'Лицензия не подходит: подпись не сходится или она выдана для другого HUB.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form license-install">
      <Field
        label="Вставить лицензию"
        hint="Текст вида TS1.… из облачного кабинета или от поддержки TS. Обычно лицензия приходит из облака сама."
        error={trimmed && !payload ? 'Это не похоже на лицензию TS: проверьте, что текст скопирован целиком.' : null}
      >
        <textarea
          className="license-text"
          rows={4}
          value={text}
          spellCheck={false}
          autoComplete="off"
          placeholder="TS1.…"
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
            setDone(false);
          }}
        />
      </Field>
      {payload && <Preview payload={payload} hubId={hubId} timeZone={timeZone} />}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {done && <p className="hint">Лицензия установлена.</p>}
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={!payload || busy || !online} onClick={() => void install()}>
          {busy ? 'Устанавливаем…' : 'Установить лицензию'}
        </button>
      </div>
    </div>
  );
}

/** «Настройки клуба» → «Лицензия». */
export function LicenseSection({
  version,
  timeZone,
  online,
  canInstall,
}: {
  version: number;
  timeZone: string;
  online: boolean;
  canInstall: boolean;
}) {
  const { info, error, reload } = useLicenseInfo(version);
  return (
    <Section title="Лицензия">
      {error && <p className="field-error">{error}</p>}
      {!info && !error && <Loading online={online} />}
      {info && <LicenseFacts info={info} timeZone={timeZone} />}
      {info && canInstall && <InstallForm hubId={info.hubId} timeZone={timeZone} online={online} onInstalled={() => void reload()} />}
      {info && !canInstall && <p className="hint">Лицензию устанавливает управляющий или поддержка TS.</p>}
    </Section>
  );
}
