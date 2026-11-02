/**
 * «Облачная касса» in the platform cabinet (packages/domain/src/cloud-cafe.ts): the café's link once it is in the
 * cloud («В облаке», «Открыть кассу клиента», copy / WhatsApp, the café code, a terms warning with «Повторить»),
 * «Перевести в облако» for a browser trial (the cash desk is asked for a fresh copy, up to 75 s, else the last copy
 * after the person agrees) and the result of «Подтвердить в облаке» (the director's code once).
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { CloudHubStatus, TrialCloudApproved } from '@bills/domain';
import { CLOUD_HUB_NOT_CONFIGURED_MESSAGE, TRIAL_CLOUD_MOVE, formatCafeCode } from '@bills/domain';
import { moveTrialToCloud, retryTrialCloudTerms, startTrialCloudMove, trialCloudMoveState } from './api.ts';
import { CopyButton } from './cabinet-ui.tsx';
import { describeCabinetError } from './license-form.ts';
import type { TrialView } from './trials.ts';
import { CLOUD_MOVE_IDLE, canMoveToCloud, cloudMoveReducer, cloudShareText, copyTimeText, isWorkingNow, trialDate, whatsAppLink } from './trials.ts';

/** «В облаке»: the link to open the café, copy / WhatsApp, the café code. */
export function CloudLinkBlock({ trial }: { trial: TrialView }) {
  const cloud = trial.cloud;
  if (!cloud) return null;
  const share = cloudShareText(trial.venue, cloud.url, cloud.code);
  return (
    <div className="trial-cloud-link">
      <p className="lic-line">
        <span className="lic-chip" data-tone="ok">
          В облаке
        </span>
        <span className="muted">
          с {trialDate(cloud.at, trial.timezone)} · {cloud.origin === 'new' ? 'подтверждена сразу в облаке' : 'касса переехала из браузера'}
        </span>
      </p>
      <p>
        Код кофейни: <code className="trial-cloud-code">{formatCafeCode(cloud.code)}</code>
      </p>
      {cloud.url ? (
        <div className="row wrap">
          <a className="btn btn-primary" href={cloud.url} target="_blank" rel="noreferrer">
            Открыть кассу клиента
          </a>
          <CopyButton text={cloud.url}>Скопировать ссылку</CopyButton>
          <a className="btn btn-small" href={whatsAppLink(share)} target="_blank" rel="noreferrer">
            Отправить в WhatsApp
          </a>
        </div>
      ) : (
        <p className="hint">{CLOUD_HUB_NOT_CONFIGURED_MESSAGE}: ссылки пока нет, есть только код.</p>
      )}
      <p className="hint">
        «Открыть кассу клиента» — та же касса, что у кофейни: войдите кодом директора («Коды для входа» ниже) и исправьте, что нужно. Всё
        меняется сразу у кофейни.
      </p>
    </div>
  );
}

/** «Касса не приняла новый срок» with «Повторить»: never a silent mismatch between the cabinet and the cloud café. */
function CloudTermsWarning({ trial, editable, onChanged }: { trial: TrialView; editable: boolean; onChanged: (t: TrialView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const message = trial.cloud?.termsError;
  if (!message) return null;
  return (
    <div className="notice trial-cloud-warn" role="alert">
      <p>
        <strong>Облачная касса не приняла срок, который здесь указан.</strong> Пока не получится, у кофейни может действовать прежний срок.
      </p>
      <p className="muted">{message}</p>
      {error && <p className="form-error">{error}</p>}
      {editable && (
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            retryTrialCloudTerms(trial.id)
              .then(onChanged)
              .catch((err: unknown) => setError(describeCabinetError(err)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Отправляем…' : 'Повторить'}
        </button>
      )}
    </div>
  );
}

/**
 * The cloud part of a trial's details: the link and the terms warning for a café in the cloud; for a browser trial
 * what full editing needs and «Перевести в облако».
 */
export function CloudSection({
  trial,
  editable,
  cloudHub,
  now,
  onChanged,
}: {
  trial: TrialView;
  editable: boolean;
  cloudHub: CloudHubStatus;
  now: number;
  onChanged: (t: TrialView) => void;
}) {
  if (trial.cloud) {
    return (
      <div className="sub-panel trial-cloud">
        <h3>Облачная касса</h3>
        <CloudTermsWarning trial={trial} editable={editable} onChanged={onChanged} />
        <CloudLinkBlock trial={trial} />
      </div>
    );
  }
  if (!canMoveToCloud(trial)) return null;
  return (
    <div className="sub-panel trial-cloud">
      <h3>Облачная касса</h3>
      <p className="hint">
        Сейчас касса работает в браузере кофейни: отсюда её можно только посмотреть («Скачать копию данных»). Чтобы исправлять данные
        за кофейню и чтобы касса работала на любом телефоне и компьютере, переведите её в облако.
      </p>
      {editable && (cloudHub.configured ? <CloudMove trial={trial} now={now} onChanged={onChanged} /> : <p className="muted">{CLOUD_HUB_NOT_CONFIGURED_MESSAGE}.</p>)}
    </div>
  );
}

/** «Перевести в облако»: confirm → a fresh copy (up to 75 s) or the last one after the person agrees → import. */
function CloudMove({ trial, now, onChanged }: { trial: TrialView; now: number; onChanged: (t: TrialView) => void }) {
  const [s, dispatch] = useReducer(cloudMoveReducer, CLOUD_MOVE_IDLE);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const busy = useRef(false);

  // Waiting for the fresh copy: look every 3 s, give up after 75 s (the reducer decides).
  useEffect(() => {
    if (s.step !== 'waiting') return;
    const timer = setInterval(() => {
      tick();
      dispatch({ type: 'tick', now: Date.now() });
      if (busy.current) return;
      busy.current = true;
      trialCloudMoveState(trial.id)
        .then((state) => dispatch({ type: 'polled', state, now: Date.now() }))
        .catch(() => undefined)
        .finally(() => {
          busy.current = false;
        });
    }, TRIAL_CLOUD_MOVE.pollEveryMs);
    return () => clearInterval(timer);
  }, [s.step, trial.id]);

  useEffect(() => {
    if (s.step === 'asking') {
      startTrialCloudMove(trial.id)
        .then((state) => dispatch({ type: 'started', state, now: Date.now() }))
        .catch((err: unknown) => dispatch({ type: 'failed', message: describeCabinetError(err) }));
    }
    if (s.step === 'moving') {
      moveTrialToCloud(trial.id, s.acceptOlder)
        .then((view) => {
          onChanged(view);
          dispatch({ type: 'moved' });
        })
        .catch((err: unknown) => dispatch({ type: 'failed', message: describeCabinetError(err) }));
    }
    if (s.step === 'done') {
      // A second click or another person: the cloud already has it — the next list shows the link.
      trialCloudMoveState(trial.id)
        .then((state) => {
          if (state.cloud) onChanged({ ...trial, cloud: state.cloud });
        })
        .catch(() => undefined);
    }
    // onChanged and trial change with every poll; the step alone decides what to call.
  }, [s.step]);

  const online = isWorkingNow(trial.lastSeenAt, now);
  switch (s.step) {
    case 'idle':
    case 'error':
      return (
        <>
          {s.step === 'error' && (
            <p className="form-error" role="alert">
              {s.message}
            </p>
          )}
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: 'open' })}>
              Перевести в облако
            </button>
          </div>
        </>
      );
    case 'confirm':
      return (
        <div className="trial-cloud-confirm">
          <p>
            <strong>Перевести «{trial.venue}» в облако?</strong>
          </p>
          <ul className="hint">
            <li>TS попросит у кассы самые свежие данные (если она сейчас открыта — до минуты) и перенесёт их в облачную кассу.</li>
            <li>Касса в браузере перестанет принимать заказы и покажет кофейне ссылку на облачную кассу. Коды сотрудников — прежние.</li>
            <li>Срок остаётся тем же: {trial.status === 'permanent' ? 'постоянная' : 'пробный период или оплата — как сейчас'}.</li>
          </ul>
          <p className="muted">{online ? 'Касса сейчас на связи.' : 'Касса сейчас не на связи — перенесём последнюю копию, которая есть у TS.'}</p>
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: 'confirm' })}>
              Да, перевести
            </button>
            <button type="button" className="btn" onClick={() => dispatch({ type: 'cancel' })}>
              Отмена
            </button>
          </div>
        </div>
      );
    case 'asking':
      return <p className="muted" role="status">Связываемся с кассой…</p>;
    case 'waiting': {
      const left = Math.max(0, Math.ceil((s.until - Date.now()) / 1000));
      return (
        <div role="status">
          <p>Касса на связи — ждём её свежие данные… ещё до {left} с.</p>
          <div className="row wrap">
            <button type="button" className="btn" onClick={() => dispatch({ type: 'stopWaiting' })}>
              Не ждать
            </button>
          </div>
        </div>
      );
    }
    case 'older':
      return (
        <div className="trial-cloud-confirm">
          <p>
            {s.reason === 'offline' ? 'Касса сейчас не на связи.' : 'Касса не прислала свежие данные.'} Последняя копия у TS —{' '}
            <strong>{copyTimeText(s.snapshotAt, Date.now(), trial.timezone)}</strong>. Если на кассе что-то делали позже, это не перенесётся.
          </p>
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: 'confirmOlder' })}>
              Перевести с данными {copyTimeText(s.snapshotAt, Date.now(), trial.timezone)}
            </button>
            <button type="button" className="btn" onClick={() => dispatch({ type: 'cancel' })}>
              Отмена
            </button>
          </div>
        </div>
      );
    case 'empty':
      return (
        <div>
          <p className="form-error">
            Касса ещё не присылала данные — переводить нечего. Попросите открыть TS на кассе с интернетом и подождите пару минут.
          </p>
          <button type="button" className="btn btn-small" onClick={() => dispatch({ type: 'cancel' })}>
            Понятно
          </button>
        </div>
      );
    case 'moving':
      return <p className="muted" role="status">Переносим кассу в облако…</p>;
    case 'done':
      return (
        <p className="saved" role="status">
          Готово: касса в облаке. Ссылка — выше; отправьте её кофейне.
        </p>
      );
  }
}

/** After «Подтвердить в облаке»: the café's link and the director's code — shown here once. */
export function CloudApprovedNotice({ result, onDone }: { result: TrialCloudApproved<TrialView>; onDone: () => void }) {
  const { trial, managerKey } = result;
  return (
    <div className="new-key trial-cloud-approved" role="status">
      <p className="new-key-warn">
        <strong>«{trial.venue}» — касса готова в облаке.</strong> Страница заявки кофейни покажет ссылку и код директора сама; если она
        закрыта — отправьте их кофейне.
      </p>
      <CloudLinkBlock trial={trial} />
      {managerKey ? (
        <p>
          Код директора: <code className="trial-cloud-code">{/^\d{6}$/.test(managerKey) ? `${managerKey.slice(0, 3)} ${managerKey.slice(3)}` : managerKey}</code> <CopyButton text={managerKey}>Скопировать</CopyButton>
          <span className="hint"> Запишите или передайте директору: этот экран больше его не покажет (код виден владельцу в «Коды для входа»).</span>
        </p>
      ) : (
        <p className="hint">Код директора уже был показан раньше — он в «Коды для входа» у владельца.</p>
      )}
      <button type="button" className="btn" onClick={onDone}>
        Готово
      </button>
    </div>
  );
}
