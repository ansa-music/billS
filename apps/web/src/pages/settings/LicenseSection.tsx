import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { LicensePayload, LicenseResponse, LicenseStatus } from '@bills/domain';
import { LICENSE_MODULES, MODULE_LABEL, peekLicense } from '@bills/domain';
import { HubRequestError, command, fetchJson } from '../../api.ts';
import { actorName } from '../../auth.ts';
import { LICENSE_STATE_LABEL, licenseTone } from '../../license.tsx';
import { Field, Loading, Section, formatDate, formatDateTime } from '../../ui.tsx';

const PLAN_LABEL: Record<LicensePayload['plan'], string> = { trial: 'Пробная', paid: 'Оплаченная' };
const TONE_TAG = { ok: 'tag tag-ok', warn: 'tag tag-warn', danger: 'tag tag-danger' } as const;

/** The manager's cloud cabinet: licenses, branches, staff. */
export const CABINET_URL = 'https://ts-cabinet.pages.dev';

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

/**
 * The license in one line people understand: «Пробный период: осталось 9 дней»,
 * «Оплачено до 12.03.2027», «Нет лицензии — подключите кассу к кабинету TS».
 */
export function licenseSummary(info: LicenseResponse, timeZone: string): { text: string; tone: 'ok' | 'warn' | 'danger' } {
  const s: LicenseStatus = info.status;
  const tone = licenseTone(s.state);
  const until = s.validUntil !== null ? formatDate(s.validUntil, timeZone) : null;
  const days = s.daysLeft ?? 0;
  const left = `осталось ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  switch (s.state) {
    case 'missing':
      return { text: 'Нет лицензии — подключите кассу к кабинету TS', tone: info.enforced ? 'danger' : 'warn' };
    case 'active':
    case 'expiring':
    case 'last_day':
      if (s.plan === 'trial') return { text: s.state === 'last_day' ? 'Пробный период: последний день' : `Пробный период: ${left}`, tone };
      return { text: until ? `Оплачено до ${until}${s.state === 'active' ? '' : ` (${left})`}` : 'Оплачено', tone };
    case 'expired':
      return { text: `${s.plan === 'trial' ? 'Пробный период закончился' : 'Оплата закончилась'}${until ? ` ${until}` : ''} — продлите в кабинете TS`, tone };
    case 'blocked':
      return { text: 'Доступ приостановлен — свяжитесь с поддержкой TS', tone };
    case 'not_yet':
      return { text: 'Лицензия ещё не началась', tone };
    case 'wrong_hub':
    case 'invalid':
      return { text: 'Лицензия не подходит к этой кассе — подключите кассу к кабинету TS заново', tone };
  }
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** The one line, then what the license includes, then the numbers support asks for. */
export function LicenseFacts({ info, timeZone, children }: { info: LicenseResponse; timeZone: string; children?: ReactNode }) {
  const s: LicenseStatus = info.status;
  const summary = licenseSummary(info, timeZone);
  return (
    <div className="license-facts">
      <p className="license-line" data-tone={summary.tone}>
        <span className={TONE_TAG[summary.tone]}>{summary.text}</span>
      </p>
      {s.readOnly && info.enforced && (
        <p className="hint">Пока лицензия не действует, касса работает «только для просмотра»: новые игры, заказы и изменения не сохраняются.</p>
      )}
      <details className="license-more">
        <summary>Что входит</summary>
        <dl className="facts">
          <div>
            <dt>Заведение</dt>
            <dd>{s.companyName ?? '—'}</dd>
          </div>
          <div>
            <dt>Действует до</dt>
            <dd>{s.validUntil !== null ? formatDateTime(s.validUntil, timeZone) : '—'}</dd>
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
            <dt>Разделы программы</dt>
            <dd>
              {LICENSE_MODULES.filter((m) => s.modules[m])
                .map((m) => MODULE_LABEL[m])
                .join(', ') || 'нет'}
            </dd>
          </div>
        </dl>
      </details>
      <details className="license-more">
        <summary>Для поддержки</summary>
        <dl className="facts">
          <div>
            <dt>Состояние</dt>
            <dd>
              {LICENSE_STATE_LABEL[s.state]}
              {s.plan ? ` · ${PLAN_LABEL[s.plan]}` : ''}
              {!info.enforced ? ' · не проверяется на этой кассе' : ''}
            </dd>
          </div>
          {s.message && (
            <div>
              <dt>Сообщение</dt>
              <dd>{s.message}</dd>
            </div>
          )}
          <div>
            <dt>Установлена</dt>
            <dd>
              {info.installedAt !== null ? formatDateTime(info.installedAt, timeZone) : '—'}
              {info.source && <span className="muted"> · {info.source === 'cloud' ? 'из кабинета' : 'вручную'}</span>}
            </dd>
          </div>
          <div className="license-hub">
            <dt>Номер этой кассы</dt>
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
        {children}
      </details>
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
        label="Вставить лицензию вручную"
        hint="Только если поддержка TS прислала текст лицензии. Обычно она приходит из кабинета сама."
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
      {info && (
        <LicenseFacts info={info} timeZone={timeZone}>
          {canInstall ? (
            <InstallForm hubId={info.hubId} timeZone={timeZone} online={online} onInstalled={() => void reload()} />
          ) : (
            <p className="hint">Лицензию устанавливает управляющий или поддержка TS.</p>
          )}
        </LicenseFacts>
      )}
      {info && (
        <p className="hint">
          Продлить или оплатить —{' '}
          <a href={CABINET_URL} target="_blank" rel="noreferrer">
            в кабинете TS
          </a>
          . Касса получает новую лицензию сама, вставлять ничего не нужно.
        </p>
      )}
    </Section>
  );
}
