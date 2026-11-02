/**
 * «Облачная касса» (VITE_CLOUD_HUB=1, apps/cloud-hub): the screens of a café whose cash desk lives in the TS
 * cloud. Nothing is installed and nothing of the café is kept on the device.
 *
 * - CloudCafeCode: the first screen on a new phone, tablet or computer — «Код кофейни», once per device.
 * - CloudCafeGate: before sign-in, a line says which café this is, with «Сменить кофейню».
 * - CloudBadge: at the bottom of the menu — the café, its code (to open it on another device), the terms,
 *   «Скачать копию» for the director and «Сменить кофейню».
 */
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { formatCafeCodeInput, normalizeCafeCode } from '@bills/domain';
import { BrandMark } from '../BrandMark.tsx';
import { Field, Modal } from '../ui.tsx';
import { AUTH_CHANGED_EVENT, readAuth } from '../auth.ts';
import { useHub } from '../useHub.tsx';
import { cafeLink, checkCafe, cloudCafeCode, forgetCafe, rememberCafe, rememberedVenue, shownCafeCode } from './cloud-cafe.ts';
import { downloadCloudBackup } from './cloud-backup.ts';
import '../onboarding/onboarding.css';
import '../trial/trial.css';
import './cloud.css';

const PROBLEM: Record<'unknown' | 'moving' | 'offline', string> = {
  unknown: 'Такой кофейни нет. Проверьте буквы и цифры кода.',
  moving: 'Кофейня как раз переезжает в облако. Подождите минуту и нажмите ещё раз.',
  offline: 'Нет связи с облаком TS. Проверьте интернет и попробуйте ещё раз.',
};

function openCafe(code: string, venue: string | null): void {
  rememberCafe(code, venue);
  window.location.replace(`${window.location.pathname}${window.location.search}#/login`);
  window.location.reload();
}

export function CloudCafeCode({ problem }: { problem?: 'unknown' | 'moving' | null }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(problem ? PROBLEM[problem] : null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeCafeCode(code);
    if (!normalized) {
      setError('В коде 12 букв и цифр, например K7F3-92QX-M4P8.');
      return;
    }
    setBusy(true);
    const result = await checkCafe(normalized);
    setBusy(false);
    if (!result.ok) {
      setError(PROBLEM[result.problem]);
      return;
    }
    openCafe(normalized, result.hello.venue);
  };

  return (
    <section className="page onboarding trial-welcome cloud-code">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">Код кофейни</h1>
          <p className="page-lead">Один раз на этом телефоне, планшете или компьютере. Потом каждый входит своим кодом сотрудника.</p>
        </div>
      </header>
      <form className="onboarding-card trial-form" onSubmit={(e) => void submit(e)} autoComplete="off">
        <Field label="Код кофейни" error={error} hint="12 букв и цифр. Его знает директор: меню → «Облачная касса».">
          <input
            className="trial-code-input"
            value={code}
            placeholder="XXXX-XXXX-XXXX"
            autoFocus
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            maxLength={20}
            aria-invalid={error ? true : undefined}
            readOnly={busy}
            onChange={(e) => {
              setCode(formatCafeCodeInput(e.target.value));
              setError(null);
            }}
          />
        </Field>
        <div className="onboarding-actions">
          <button type="submit" className="btn btn-primary btn-large" disabled={busy}>
            {busy ? 'Проверяем код…' : 'Открыть кофейню'}
          </button>
        </div>
      </form>
      <p className="onboarding-foot">Касса работает в облаке TS: устройства кофейни видят одни и те же заказы, где бы они ни были.</p>
    </section>
  );
}

/** «Сменить кофейню»: this device forgets the café and its session, then asks for a code again. */
function switchCafe(): void {
  forgetCafe();
  window.location.replace(`${window.location.pathname}${window.location.search}#/`);
  window.location.reload();
}

/** The app of a known café; before sign-in a line says which café this is and lets the device switch. */
export function CloudCafeGate({ code, children }: { code: string; children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(() => readAuth() !== null);
  const [venue, setVenue] = useState(() => rememberedVenue());
  useEffect(() => {
    const onAuth = () => setSignedIn(readAuth() !== null);
    window.addEventListener(AUTH_CHANGED_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onAuth);
  }, []);
  // The café's name for the line (a device that came by a link has not seen it yet).
  useEffect(() => {
    if (venue) return;
    void checkCafe(code).then((r) => {
      if (r.ok && r.hello.venue) {
        rememberCafe(code, r.hello.venue);
        setVenue(r.hello.venue);
      }
    });
  }, [code, venue]);
  return (
    <>
      {children}
      {!signedIn && (
        <p className="cloud-gate" role="note">
          <span className="cloud-gate-text">
            {venue ? `${venue} · ` : 'Кофейня '}
            <span className="cloud-gate-code">{shownCafeCode(code)}</span>
          </span>
          <button type="button" className="onboarding-link" onClick={switchCafe}>
            Сменить кофейню
          </button>
        </p>
      )}
    </>
  );
}

function untilText(ms: number | null): string | null {
  if (ms === null || ms >= Date.UTC(2099, 0, 1)) return null;
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The cloud café at the bottom of the menu, and its details on a click. */
export function CloudBadge({ place = 'sidebar' }: { place?: 'sidebar' | 'sheet' }) {
  const { license } = useHub();
  const [open, setOpen] = useState(false);
  const code = cloudCafeCode();
  if (!code) return null;
  const venue = rememberedVenue();
  const over = license?.readOnly === true;
  const left = license?.daysLeft ?? null;
  const ending = !over && left !== null && untilText(license?.validUntil ?? null) !== null && left <= 7;
  const label = over ? 'Облачная касса · только чтение' : ending ? `Облачная касса · ${left} дн.` : 'Облачная касса';
  return (
    <>
      <button
        type="button"
        className="trial-badge cloud-badge"
        data-place={place}
        data-over={over || undefined}
        title={venue ? `${venue} — касса в облаке TS` : 'Касса в облаке TS'}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="trial-badge-dot" aria-hidden="true" />
        <span className="trial-badge-text">{label}</span>
        <span className="trial-badge-short" aria-hidden="true">
          {over ? 'Чтение' : 'Облако'}
        </span>
      </button>
      {open && <CloudDetails code={code} onClose={() => setOpen(false)} />}
    </>
  );
}

function CloudDetails({ code, onClose }: { code: string; onClose: () => void }) {
  const { license, roles, notify } = useHub();
  const director = roles.includes('manager');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const venue = rememberedVenue();
  const until = untilText(license?.validUntil ?? null);
  const link = cafeLink(code);

  const download = async () => {
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const name = await downloadCloudBackup((done) => setProgress(done));
      notify(`Копия сохранена: ${name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось скачать копию.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Modal open title="Облачная касса" onClose={onClose}>
      <div className="trial-details cloud-details">
        <p className="trial-details-state" data-over={license?.readOnly ? '' : undefined}>
          {license?.readOnly
            ? (license.message ?? 'Касса в режиме «только чтение»: заказы не принимаются, данные можно смотреть и скачать.')
            : until
              ? `Касса работает до ${until}.`
              : 'Касса работает, срок не ограничен.'}
        </p>
        <div className="cloud-code-box">
          <span className="muted">{venue ?? 'Кофейня'} — код кофейни</span>
          <strong className="cloud-code-value">{shownCafeCode(code)}</strong>
          <span className="muted">
            На новом устройстве откройте этот сайт и введите код — или откройте ссылку:
          </span>
          <div className="cloud-code-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(
                  () => notify('Ссылка на кофейню скопирована'),
                  () => notify(link),
                );
              }}
            >
              Скопировать ссылку
            </button>
          </div>
        </div>
        <p className="muted">
          Данные кофейни хранятся в облаке TS: каждое изменение сразу видят все устройства. Раз в неделю директору стоит скачивать копию —
          её открывает любой браузер на странице пробной версии («Восстановить из копии»).
        </p>
        <div className="trial-details-actions">
          {director ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void download()}>
              {progress === null ? 'Скачать копию' : `Готовим копию… ${Math.round(progress * 100)}%`}
            </button>
          ) : (
            <p className="muted">Скачать копию может директор.</p>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (window.confirm('Сменить кофейню на этом устройстве? Нужно будет снова ввести код кофейни и свой код.')) switchCafe();
            }}
          >
            Сменить кофейню
          </button>
        </div>
        {error && <p className="trial-watch-error">{error}</p>}
        <p className="trial-details-foot">Продлить доступ или задать вопрос — напишите TS.</p>
      </div>
    </Modal>
  );
}
