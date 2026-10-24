/** Manager cabinet: the company's license and branches (#/company). Staff of a branch — Staff.tsx. */
import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import type { BranchView, CreateBranchResponse, LicenseView } from '@bills/domain';
import { companyLicense, listBranches, createBranch } from './api.ts';
import { LicenseLine } from './cabinet-ui.tsx';
import { CURRENCIES, DEFAULT_CITY_ID, citiesByCountry, cityById, currencyName, zoneLabel } from './cities.ts';
import type { CurrencyCode } from './cities.ts';
import { ConnectCash, rememberHubCode } from './ConnectCash.tsx';
import { formatAgo } from './format.ts';
import { StartCard } from './Start.tsx';
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
          <dt>Заведений</dt>
          <dd>до {p.maxClubs}</dd>
        </div>
        <div>
          <dt>Столов в заведении</dt>
          <dd>{p.maxTables ?? 'без ограничения'}</dd>
        </div>
        <div>
          <dt>Сотрудников в заведении</dt>
          <dd>{p.maxStaff ?? 'без ограничения'}</dd>
        </div>
        <div>
          <dt>Модули</dt>
          <dd>{modulesText(p.modules)}</dd>
        </div>
      </dl>
      <p className="hint">
        Продление и расширение — у команды TS. Кассы заведений получают лицензию сами; если пропал интернет, они
        продолжат работать до конца срока.
      </p>
    </Section>
  );
}

function NewBranch({ onCreated, onCancel }: { onCreated: (res: CreateBranchResponse) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [cityId, setCityId] = useState(DEFAULT_CITY_ID);
  const [currency, setCurrency] = useState<CurrencyCode>(cityById(DEFAULT_CITY_ID).currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createBranch({ name: name.trim(), timezone: cityById(cityId).timezone, currency }));
    } catch (err) {
      setError(describeCabinetError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="cab-form sub-panel" onSubmit={submit}>
      <h3>Новое заведение</h3>
      <div className="form-grid">
        <label className="field form-grid-wide">
          <span>Название</span>
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Например: Кофейня на Абая" />
        </label>
        <label className="field">
          <span>Город</span>
          <select
            value={cityId}
            onChange={(e) => {
              setCityId(e.target.value);
              setCurrency(cityById(e.target.value).currency);
            }}
          >
            {citiesByCountry().map((g) => (
              <optgroup key={g.country} label={g.label}>
                {g.cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Валюта</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value as CurrencyCode)}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Создаём…' : 'Создать заведение'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

/** Right after «Создать заведение»: connect its cash register with the code, the technical values folded. */
function BranchConnect({ res, onDone }: { res: CreateBranchResponse; onDone: () => void }) {
  return (
    <div className="sub-panel branch-connect" role="status">
      <h3>Заведение «{res.branch.name}» создано. Теперь подключите кассу</h3>
      <ConnectCash
        clubId={res.branch.id}
        clubName={res.branch.name}
        hubConnected={false}
        initial={{ hubId: res.hubId, apiKey: res.hubApiKey }}
      />
      <p className="hint">
        Код можно открыть позже: «Первые шаги» → «Подключите кассу». Программа для кассы — на странице{' '}
        <a className="link-inline" href="#/apps">
          «Скачать»
        </a>
        .
      </p>
      <div className="row wrap">
        <button type="button" className="btn" onClick={onDone}>
          Готово
        </button>
      </div>
    </div>
  );
}

function BranchList({ branches, onAdd }: { branches: BranchView[]; onAdd: (() => void) | null }) {
  if (branches.length === 0) {
    return (
      <div className="empty-state">
        <p className="muted">Заведений пока нет.</p>
        {onAdd && (
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            Добавьте первое заведение
          </button>
        )}
      </div>
    );
  }
  const now = Date.now();
  return (
    <ul className="plain-list">
      {branches.map((b) => {
        const seen = b.hubs.map((h) => h.lastSeenAt ?? 0).reduce((a, x) => Math.max(a, x), 0);
        return (
          <li key={b.id} className="list-item branch-item">
            <div className="list-main">
              <strong>{b.name}</strong>
              <span className="hint">
                {zoneLabel(b.timezone)} · {currencyName(b.currency)} ·{' '}
                {b.hubs.length === 0 ? 'касса не подключена' : seen ? `касса была на связи ${formatAgo(Math.max(0, now - seen))}` : 'касса ещё не подключена'}
              </span>
            </div>
            <span className="row wrap branch-actions">
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

export function CompanyPage({ companyId }: { companyId: string }) {
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
      <StartCard companyId={companyId} />

      <Section
        title="Заведения"
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
                {limitReached && status?.maxClubs != null ? clubLimitText(status.maxClubs) : 'Добавить заведение'}
              </button>
            )}
          </span>
        }
      >
        {limitReached && <p className="hint">Чтобы открыть ещё одно заведение, расширьте лицензию у команды TS.</p>}
        {status?.readOnly && <p className="hint">Лицензия в режиме «только чтение» — новые заведения не добавить.</p>}
        {adding && (
          <NewBranch
            onCancel={() => setAdding(false)}
            onCreated={(res) => {
              rememberHubCode(res.branch.id, { hubId: res.hubId, apiKey: res.hubApiKey });
              setAdding(false);
              setCreated(res);
              void branches.reload();
              void lic.reload();
            }}
          />
        )}
        {created && <BranchConnect res={created} onDone={() => setCreated(null)} />}
        {branches.data ? (
          <BranchList branches={branches.data} onAdd={allowed && !adding && !created ? () => setAdding(true) : null} />
        ) : (
          <p className="empty">{loadingText(branches.error, 'заведения')}</p>
        )}
      </Section>

      <LicenseSection license={license} error={lic.error} />
    </div>
  );
}
