/**
 * «Коды для входа» in a café's details (packages/domain/src/trial-codes.ts) — for the platform owner only: the café
 * code and the director's sign-in code behind «Показать» (each look is written to the function's log, never the codes),
 * and «Выдать новый код директора» (shown once). Lets TS help a client sign in and fix things for them.
 */
import { useEffect, useState } from 'react';
import type { TrialCodesView } from '@bills/domain';
import { formatCafeCode } from '@bills/domain';
import { fetchTrialCodes, issueDirectorKey } from './api.ts';
import { CopyButton } from './cabinet-ui.tsx';
import { describeCabinetError } from './license-form.ts';
import type { TrialView } from './trials.ts';
import { trialDate } from './trials.ts';

function directorKeyText(key: string): string {
  return /^\d{6}$/.test(key) ? `${key.slice(0, 3)} ${key.slice(3)}` : key;
}

export function TrialCodesSection({ trial, onChanged }: { trial: TrialView; onChanged: (t: TrialView) => void }) {
  const [codes, setCodes] = useState<TrialCodesView | null>(null);
  const [issued, setIssued] = useState<{ key: string; applied: 'cloud' | 'next-report' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cloud = Boolean(trial.cloud);
  // Moved into the cloud: the codes shown before (the browser's café code, a code waiting for it) are gone.
  useEffect(() => {
    setCodes(null);
    setIssued(null);
  }, [trial.cloud?.code]);

  const run = (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    fn()
      .catch((err: unknown) => setError(describeCabinetError(err)))
      .finally(() => setBusy(false));
  };

  const show = () => {
    if (!window.confirm('Показать коды кофейни? Убедитесь, что экран не видят посторонние.')) return;
    run(async () => setCodes(await fetchTrialCodes(trial.id)));
  };

  const issue = () => {
    const what = cloud
      ? 'Выдать директору новый код? Старые коды директора в облачной кассе сразу перестанут работать.'
      : 'Выдать директору новый код? Касса в браузере получит его при следующей связи с TS (если она открыта — в течение 5 минут); старые коды директора тогда перестанут работать, и директора попросят войти заново.';
    if (!window.confirm(what)) return;
    run(async () => {
      const res = await issueDirectorKey(trial.id);
      setIssued({ key: res.managerKey, applied: res.applied });
      onChanged(res.trial);
      setCodes(await fetchTrialCodes(trial.id));
    });
  };

  return (
    <div className="sub-panel trial-codes">
      <h3>Коды для входа</h3>
      <p className="hint">Видит только владелец платформы. Чтобы помочь кофейне войти или исправить что-то за неё.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {issued && (
        <div className="new-key" role="status">
          <p className="new-key-warn">
            <strong>Новый код директора — показывается здесь один раз.</strong>{' '}
            {issued.applied === 'cloud'
              ? 'Он уже работает в облачной кассе.'
              : 'Касса в браузере получит его при следующей связи с TS; до этого работает старый.'}
          </p>
          <p>
            <code className="trial-cloud-code">{directorKeyText(issued.key)}</code> <CopyButton text={issued.key}>Скопировать</CopyButton>
          </p>
          <button type="button" className="btn btn-small" onClick={() => setIssued(null)}>
            Готово
          </button>
        </div>
      )}
      {codes ? (
        <dl className="facts">
          <div>
            <dt>{codes.cafeCodeKind === 'cloud' ? 'Код кофейни (облачная касса)' : 'Код кофейни (перенос кассы)'}</dt>
            <dd>
              {codes.cafeCode ? (
                <>
                  <code className="trial-cloud-code">{formatCafeCode(codes.cafeCode)}</code> <CopyButton text={formatCafeCode(codes.cafeCode)}>Скопировать</CopyButton>
                </>
              ) : (
                <span className="muted">касса ещё не прислала его (нужна связь с TS и свежая версия страницы)</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Код директора</dt>
            <dd>
              {codes.directorKey ? (
                <>
                  <code className="trial-cloud-code">{directorKeyText(codes.directorKey)}</code> <CopyButton text={codes.directorKey}>Скопировать</CopyButton>
                  {codes.directorKeyAt !== null && <span className="muted"> · на {trialDate(codes.directorKeyAt, trial.timezone)}</span>}
                </>
              ) : (
                <span className="muted">касса ещё не прислала его</span>
              )}
              {codes.directorKeyStale && (
                <p className="trial-dup">⚠ код мог быть изменён в кассе: касса сообщила, что этот код больше не работает. Выдайте новый.</p>
              )}
              {cloud && !codes.directorKeyStale && codes.directorKey && (
                <p className="hint">Если директор сам менял код в облачной кассе, этот мог перестать работать — тогда выдайте новый.</p>
              )}
              {codes.directorKeyPending && (
                <p className="hint">
                  Новый код <code>{directorKeyText(codes.directorKeyPending)}</code> ждёт кассу: она получит его при следующей связи с TS.
                </p>
              )}
              {codes.directorKeyRefused && <p className="form-error">Касса не смогла поставить новый код (такой уже есть у сотрудника) — выдайте ещё раз.</p>}
            </dd>
          </div>
        </dl>
      ) : null}
      <div className="row wrap">
        {codes ? (
          <button type="button" className="btn btn-small" onClick={() => setCodes(null)}>
            Скрыть коды
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={show}>
            Показать
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={issue}>
          Выдать новый код директора
        </button>
      </div>
    </div>
  );
}
