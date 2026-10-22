/** Manager cabinet: the company's license and branches (#/company). Staff of a branch — Staff.tsx. */
import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import type { BranchView, CreateBranchResponse, LicenseView } from '@bills/domain';
import { encodeHubSetupCode, hubCloudUrl, hubSetupUrl, isLocalOnlyCloudUrl } from '@bills/domain';
import { companyLicense, listBranches, createBranch } from './api.ts';
import { CopyValue, LicenseLine, ShownOnce } from './cabinet-ui.tsx';
import { SUPABASE_MODE, supabaseUrl } from './config.ts';
import { nativeBridge } from './platform.ts';
import { QrImage } from './QrImage.tsx';
import { formatDateTime } from './format.ts';
import { clubHref, usePoll } from './hooks.ts';
import {
  canAddBranch,
  clubLimitText,
  describeCabinetError,
  kzDate,
  lastLicenseDay,
  licenseTone,
  modulesText,
  planLabel,
} from './license-form.ts';
import { Section, loadingText } from './shared.tsx';

/** Warning strip for the top of the cabinet: 3 days before the end, the last day, read-only. Nothing when all is fine. */
export function LicenseBanner({ license }: { license: LicenseView | null | undefined }) {
  if (license === undefined) return null;
  const status = license?.status;
  const message = status ? status.message : 'Лицензия не выдана — облако работает в режиме «только чтение». Обратитесь к владельцу платформы TS.';
  if (!message) return null;
  return (
    <div className="lic-banner" data-tone={licenseTone(status?.state ?? 'missing')} role="status">
      <strong>{status?.readOnly || !status ? 'Только чтение. ' : 'Лицензия. '}</strong>
      {message}{' '}
      <a className="link" href="#/company">
        Подробнее
      </a>
    </div>
  );
}

export function useCompanyLicense() {
  // Wrapped: usePoll's `null` means "not loaded yet", a client may have no license at all.
  const load = useCallback(async () => ({ license: await companyLicense() }), []);
  return usePoll(load, 5 * 60_000);
}

function LicenseSection({ license, error }: { license: LicenseView | null | undefined; error: Error | null }) {
  if (license === undefined) {
    return (
      <Section title="Лицензия">
        <p className="empty">{loadingText(error, 'лицензию')}</p>
      </Section>
    );
  }
  if (license === null) {
    return (
      <Section title="Лицензия">
        <p className="notice">
          Лицензия не выдана — режим «только чтение». Обратитесь к владельцу платформы TS.
        </p>
      </Section>
    );
  }
  const { payload: p, status } = license;
  return (
    <Section title="Лицензия" aside={<LicenseLine status={status} />}>
      {status.message && (
        <p className="lic-banner" data-tone={licenseTone(status.state)}>
          {status.readOnly && <strong>Только чтение. </strong>}
          {status.message}
        </p>
      )}
      <dl className="facts">
        <div>
          <dt>План</dt>
          <dd>{planLabel(p.plan)}</dd>
        </div>
        <div>
          <dt>Срок</dt>
          <dd>
            с {kzDate(p.validFrom)} по {lastLicenseDay(p.validUntil)} включительно
            {status.daysLeft !== null && !status.readOnly ? ` · осталось ${status.daysLeft} дн.` : ''}
          </dd>
        </div>
        <div>
          <dt>Филиалов</dt>
          <dd>до {p.maxClubs}</dd>
        </div>
        <div>
          <dt>Столов в филиале</dt>
          <dd>{p.maxTables ?? 'без ограничения'}</dd>
        </div>
        <div>
          <dt>Сотрудников в филиале</dt>
          <dd>{p.maxStaff ?? 'без ограничения'}</dd>
        </div>
        <div>
          <dt>Модули</dt>
          <dd>{modulesText(p.modules)}</dd>
        </div>
      </dl>
      <p className="hint">
        Продление и расширение — у владельца платформы TS. HUB'ы филиалов получают лицензию из облака сами; если клуб
        работает без интернета, они продолжат работать до конца срока.
      </p>
    </Section>
  );
}

function NewBranch({ onCreated, onCancel }: { onCreated: (res: CreateBranchResponse) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Asia/Almaty');
  const [currency, setCurrency] = useState('KZT');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createBranch({ name: name.trim(), timezone: timezone.trim() || undefined, currency: currency.trim().toUpperCase() || undefined }));
    } catch (err) {
      setError(describeCabinetError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="cab-form sub-panel" onSubmit={submit}>
      <h3>Новый филиал</h3>
      <div className="row wrap">
        <label className="field grow">
          <span>Название</span>
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Например: TS на Абая" />
        </label>
        <label className="field">
          <span>Часовой пояс</span>
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </label>
        <label className="field">
          <span>Валюта</span>
          <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Создаём…' : 'Создать филиал'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

/**
 * CLOUD_URL for a branch's HUB: the `sync` Edge Function under the Supabase project, or the
 * self-hosted cloud this cabinet is served from (in the phone app — the cloud from its settings).
 */
function branchCloudUrl(): string | null {
  if (SUPABASE_MODE) return hubCloudUrl({ supabaseUrl: supabaseUrl() });
  return hubCloudUrl({ cloudOrigin: nativeBridge()?.cloudUrl() ?? (typeof location === 'undefined' ? null : location.origin) });
}

function BranchConnect({ res, onDone }: { res: CreateBranchResponse; onDone: () => void }) {
  const cloudUrl = branchCloudUrl();
  let code: string | null = null;
  try {
    code = cloudUrl ? encodeHubSetupCode({ hubId: res.hubId, apiKey: res.hubApiKey, cloudUrl }) : null;
  } catch {
    code = null; // values the cloud never issues: the manual ones below still work
  }
  const env = [`HUB_ID=${res.hubId}`, `CLOUD_API_KEY=${res.hubApiKey}`, ...(cloudUrl ? [`CLOUD_URL=${cloudUrl}`] : [])].join('\n');
  return (
    <ShownOnce
      onDone={onDone}
      note={
        <div className="hint">
          <p>
            Без кода: на странице мастера нажмите «ввести HUB_ID и ключ вручную» или впишите эти строки в файл настроек HUB
            (<code>/etc/bills/hub.env</code>) и перезапустите HUB:
          </p>
          <pre className="env-snippet">{env}</pre>
          {cloudUrl && isLocalOnlyCloudUrl(cloudUrl) && (
            <p>
              Кабинет открыт по адресу <code>{cloudUrl}</code> — такой адрес облака работает только на этом же компьютере. HUB
              другого клуба подключайте вручную, указав вместо него адрес этого компьютера в сети (например, Tailscale).
            </p>
          )}
          <p>HUB получит лицензию, сотрудников и их ключи при первой синхронизации.</p>
        </div>
      }
    >
      {code && (
        <>
          <p className="hint">
            На мини-ПК клуба: отсканируйте QR телефоном в Wi-Fi клуба — откроется мастер настройки HUB. Если не открылось —
            откройте адрес, который показан на экране мини-ПК, и вставьте код.
          </p>
          <QrImage text={hubSetupUrl(code)} alt={`QR-код для подключения HUB филиала «${res.branch.name}»`} />
          <CopyValue label="Код подключения" value={code} />
        </>
      )}
      <CopyValue label="HUB_ID" value={res.hubId} />
      <CopyValue label="CLOUD_API_KEY" value={res.hubApiKey} />
      {cloudUrl && <CopyValue label="CLOUD_URL" value={cloudUrl} />}
    </ShownOnce>
  );
}

function BranchList({ branches }: { branches: BranchView[] }) {
  if (branches.length === 0) return <p className="empty">Филиалов пока нет</p>;
  return (
    <ul className="plain-list">
      {branches.map((b) => {
        const seen = b.hubs.map((h) => h.lastSeenAt ?? 0).reduce((a, x) => Math.max(a, x), 0);
        return (
          <li key={b.id} className="list-item">
            <div className="list-main">
              <strong>{b.name}</strong>
              <span className="hint">
                {b.timezone} · {b.currency} ·{' '}
                {b.hubs.length === 0
                  ? 'HUB не подключён'
                  : seen
                    ? `HUB на связи ${formatDateTime(seen, b.timezone)}`
                    : 'HUB ещё не выходил на связь'}
              </span>
            </div>
            <span className="row">
              <a className="btn btn-small" href={clubHref(b.id, 'staff')}>
                Сотрудники
              </a>
              <a className="btn btn-small" href={clubHref(b.id)}>
                Отчёты
              </a>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function CompanyPage() {
  const lic = useCompanyLicense();
  const loadBranches = useCallback(() => listBranches(), []);
  const branches = usePoll(loadBranches, 60_000);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<CreateBranchResponse | null>(null);

  const license = lic.data ? lic.data.license : undefined;
  const status = license?.status ?? null;
  const used = branches.data?.length ?? 0;
  const allowed = canAddBranch(used, status);
  const limitReached = status !== null && status.maxClubs !== null && used >= status.maxClubs;

  return (
    <div className="company-page">
      <a className="back" href="#/">
        ← Все клубы
      </a>
      <LicenseSection license={license} error={lic.error} />

      <Section
        title="Филиалы"
        aside={
          <span className="panel-aside">
            <span className="panel-total">{status?.maxClubs ? `${used} из ${status.maxClubs}` : used}</span>
            {!adding && !created && (
              <button
                type="button"
                className="btn btn-small btn-primary"
                disabled={!allowed || !branches.data}
                title={!allowed && status?.readOnly ? 'Лицензия: только чтение' : undefined}
                onClick={() => setAdding(true)}
              >
                {limitReached && status?.maxClubs != null ? clubLimitText(status.maxClubs) : 'Новый филиал'}
              </button>
            )}
          </span>
        }
      >
        {limitReached && <p className="hint">Чтобы открыть ещё филиал, расширьте лицензию у владельца платформы TS.</p>}
        {status?.readOnly && <p className="hint">Лицензия в режиме «только чтение» — новые филиалы не открываются.</p>}
        {adding && (
          <NewBranch
            onCancel={() => setAdding(false)}
            onCreated={(res) => {
              setAdding(false);
              setCreated(res);
              void branches.reload();
              void lic.reload();
            }}
          />
        )}
        {created && <BranchConnect res={created} onDone={() => setCreated(null)} />}
        {branches.data ? <BranchList branches={branches.data} /> : <p className="empty">{loadingText(branches.error, 'филиалы')}</p>}
      </Section>
    </div>
  );
}
