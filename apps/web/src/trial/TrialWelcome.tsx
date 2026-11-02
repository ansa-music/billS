import { useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { TRIAL_DELETED_MESSAGE } from '@bills/domain';
import { BrandMark } from '../BrandMark.tsx';
import { Field } from '../ui.tsx';
import type { NewTrial } from '../demo-hub/boot.ts';
import type { TrialInfo } from '../demo-hub/trial-store.ts';
import {
  currentTrial,
  subscribeTrial,
  TRIAL_DAYS,
  trialAwaiting,
  trialCheckNow,
  trialLastCheck,
  trialPermanent,
  trialVersion,
} from '../demo-hub/trial-store.ts';
import type { TrialEntryMode } from './TrialSignIn.tsx';
import { TrialEntry } from './TrialSignIn.tsx';
import '../onboarding/onboarding.css';
import './trial.css';

/**
 * First visit of the browser trial: two fields and one button. The coffee shop is created in
 * this browser, then «Готово» shows the director's (role manager) six-digit key once, big, to write down.
 * First the choice «Новая кофейня» / «У меня уже есть TS — войти» (TrialSignIn.tsx: move the cash desk here,
 * work with it as a device, or restore a «Скачать копию» file) — the form only for a new café.
 */
export function TrialWelcome({ onStart, onRestored }: { onStart: (t: NewTrial) => void; onRestored: () => void }) {
  const [mode, setMode] = useState<TrialEntryMode>('choose');
  const [venue, setVenue] = useState('');
  const [managerName, setManagerName] = useState('');
  const [withMenu, setWithMenu] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!venue.trim()) {
      setError('Напишите название кофейни');
      return;
    }
    onStart({ venue: venue.trim(), managerName: managerName.trim(), withMenu });
  };

  if (mode !== 'new') return <TrialEntry mode={mode} onMode={setMode} onRestored={onRestored} />;

  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">TS для кофейни — {TRIAL_DAYS} дней бесплатно</h1>
          <p className="page-lead">Касса, экран бариста и отчёты прямо в браузере. Ничего не нужно устанавливать.</p>
        </div>
      </header>

      <form className="onboarding-card trial-form" onSubmit={submit} autoComplete="off" noValidate>
        <Field label="Название кофейни" error={error}>
          <input
            value={venue}
            maxLength={80}
            placeholder="Например: Кофейня «Утро»"
            autoFocus
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setVenue(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field label="Ваше имя" hint="Так вас будет видно в журнале и отчётах.">
          <input value={managerName} maxLength={80} placeholder="Например: Айгерим" onChange={(e) => setManagerName(e.target.value)} />
        </Field>
        <label className="trial-check">
          <input type="checkbox" checked={withMenu} onChange={(e) => setWithMenu(e.target.checked)} />
          <span>
            <strong>Заполнить меню примером</strong>
            <span className="muted">Кофе с размерами и молоком, чай, выпечка — цены потом поправите в «Меню».</span>
          </span>
        </label>
        <div className="onboarding-actions">
          <button type="submit" className="btn btn-primary btn-large">
            Начать пробный период
          </button>
        </div>
        <p className="onboarding-note">
          Всё хранится в этом браузере на этом устройстве. Работайте с одного компьютера или планшета и раз в несколько дней нажимайте «Скачать копию».
        </p>
      </form>

      <p className="onboarding-foot">
        Кофейня уже работает на другом компьютере?{' '}
        <button type="button" className="onboarding-link" onClick={() => setMode('signin')}>
          У меня уже есть TS — войти
        </button>
      </p>
    </section>
  );
}

/**
 * «Готово»: the director's key, once, big. After TS approved the request (`approved`) it says so; a trial
 * TS made permanent straight away says «Полная версия» instead of the 14 days.
 */
export function TrialReady({
  venue,
  managerKey,
  onContinue,
  approved = false,
  permanent = false,
}: {
  venue: string;
  managerKey: string;
  onContinue: () => void;
  approved?: boolean;
  permanent?: boolean;
}) {
  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">{approved ? `Готово! TS подтвердил заявку «${venue}»` : `Готово! «${venue}» создана`}</h1>
          <p className="page-lead">{permanent ? 'Полная версия — без срока.' : `Пробный период — ${TRIAL_DAYS} дней, с сегодняшнего дня.`}</p>
        </div>
      </header>
      <div className="onboarding-card onboarding-done">
        <p>Ваш код входа (директор):</p>
        <p className="trial-key" aria-label={`Код входа ${managerKey.split('').join(' ')}`}>
          {managerKey.slice(0, 3)} {managerKey.slice(3)}
        </p>
        <p className="onboarding-note">
          Запишите его. Код спросят при входе в кассу. Если забудете — внизу меню нажмите «{permanent ? 'Полная версия' : 'Пробная'}» → «Код директора».
        </p>
        <ol className="trial-next">
          <li>Войдите с этим кодом.</li>
          <li>«Смена» → «Открыть смену» и принимайте заказы на «Кассе».</li>
          <li>Сотрудников добавьте в «Сотрудники» — каждый получит свой код.</li>
        </ol>
        <div className="onboarding-actions">
          <button type="button" className="btn btn-primary btn-large" onClick={onContinue}>
            Перейти ко входу
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * In front of the cash desk: while the request waits for TS — «Заявка отправлена»; when TS turned it
 * down — «Заявка отклонена»; when TS approved it (or the trial is new without the TS cloud) — «Готово»
 * with the director's code once; then the cash desk itself. It follows the trial store, so the cash desk
 * opens by itself the moment the terms say «approved»: no reload, nothing typed again.
 */
export function TrialGate({ fresh, children }: { fresh: boolean; children: ReactNode }) {
  useSyncExternalStore(subscribeTrial, trialVersion);
  const info = currentTrial();
  const waiting = info ? trialAwaiting(info) : false;
  const [ready, setReady] = useState(fresh);
  const [approved, setApproved] = useState(false);
  // Remembered from the last render: leaving «waiting» means TS just said yes.
  const [wasWaiting, setWasWaiting] = useState(waiting);
  if (waiting !== wasWaiting) {
    setWasWaiting(waiting);
    if (!waiting) {
      setReady(true);
      setApproved(true);
    }
  }
  if (!info) return <>{children}</>;
  if (waiting) return info.status === 'rejected' ? <TrialRejected info={info} /> : <TrialPending info={info} />;
  if (ready) {
    return (
      <TrialReady
        venue={info.venue}
        managerKey={info.managerKey}
        approved={approved}
        permanent={trialPermanent(info)}
        onContinue={() => setReady(false)}
      />
    );
  }
  return <>{children}</>;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** «Заявка отправлена»: the request waits for TS; the page asks every half a minute and opens the cash desk itself. */
export function TrialPending({ info }: { info: TrialInfo }) {
  const [busy, setBusy] = useState(false);
  const check = trialLastCheck();
  const sent = Boolean(info.cloudId);
  const state = !check
    ? sent
      ? 'Ждём подтверждения TS…'
      : 'Отправляем заявку…'
    : check.ok
      ? `Ждём подтверждения TS · проверено в ${clock(check.at)}`
      : sent
        ? 'Нет связи с TS — проверим снова через полминуты. Заявка уже у TS.'
        : 'Нет связи с TS — заявка уйдёт, как только появится интернет. Всё, что вы ввели, сохранено.';
  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">Заявка отправлена</h1>
          <p className="page-lead">TS подтвердит её в ближайшее время — касса откроется сама.</p>
        </div>
      </header>
      <div className="onboarding-card trial-wait">
        <p className="trial-wait-venue">
          <span className="muted">Кофейня</span> <strong>«{info.venue}»</strong>
          {info.managerName ? <span className="muted"> · {info.managerName}</span> : null}
        </p>
        <p className="trial-wait-state" data-offline={check && !check.ok ? '' : undefined} role="status" aria-live="polite">
          <span className="trial-wait-dot" aria-hidden="true" />
          {state}
        </p>
        <p className="onboarding-note">
          Страницу можно не закрывать: как только TS подтвердит заявку, касса откроется здесь сама. Закроете — откройте TS потом в этом же
          браузере: название и меню сохранены.
        </p>
        <p className="onboarding-note">Долго нет ответа? Напишите TS.</p>
        <div className="onboarding-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void trialCheckNow().finally(() => setBusy(false));
            }}
          >
            {busy ? 'Проверяем…' : 'Проверить сейчас'}
          </button>
        </div>
      </div>
    </section>
  );
}

/** «Заявка отклонена», with TS's message when there is one. The page stops sending requests. */
export function TrialRejected({ info }: { info: TrialInfo }) {
  const message = info.message?.trim() || null;
  const deleted = message === TRIAL_DELETED_MESSAGE;
  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">Заявка отклонена</h1>
          <p className="page-lead">{deleted ? message : `TS не подтвердил заявку «${info.venue}» на пробную версию.`}</p>
        </div>
      </header>
      {!deleted && (
        <div className="onboarding-card trial-wait">
          {message && (
            <blockquote className="trial-wait-message">
              <span className="muted">Сообщение от TS:</span>
              <span>{message}</span>
            </blockquote>
          )}
          <p className="onboarding-note">Если это ошибка — напишите TS.</p>
        </div>
      )}
    </section>
  );
}

/** Another tab of this browser already runs the trial: two in-page HUBs would overwrite each other. */
export function TrialBusy() {
  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">TS уже открыт в другой вкладке</h1>
          <p className="page-lead">Пробная версия работает в одной вкладке браузера. Закройте эту и вернитесь в ту, или закройте ту и обновите эту страницу.</p>
        </div>
      </header>
      <div className="onboarding-actions">
        <button type="button" className="btn btn-primary btn-large" onClick={() => window.location.reload()}>
          Обновить страницу
        </button>
      </div>
    </section>
  );
}
