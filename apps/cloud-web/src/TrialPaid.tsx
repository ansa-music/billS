/**
 * «Купили» in the platform cabinet (packages/domain/src/trial-paid.ts): the form («Оплачено до», the agreed sum,
 * a note — the last two only for TS, the café never sees them) and the payment history.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { TRIAL_PAID_NOTE_MAX } from '@bills/domain';
import { markTrialPaid } from './api.ts';
import { describeCabinetError } from './license-form.ts';
import type { TrialView } from './trials.ts';
import { endDateText, paidAmountText, paidDefaultUntil, parsePaidForm, trialDate, trialDateYear } from './trials.ts';
import { trialPaidRange } from '@bills/domain';

/** «Купили» / «Продлить оплату». */
export function PaidForm({
  trial,
  onDone,
  onCancel,
}: {
  trial: TrialView;
  onDone: (t: TrialView, text: string) => void;
  onCancel: () => void;
}) {
  const now = Date.now();
  const range = trialPaidRange(now, trial.timezone);
  const [until, setUntil] = useState(() => paidDefaultUntil(trial, now));
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const again = trial.status === 'paid';

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = parsePaidForm({ until, amount, note }, Date.now(), trial.timezone);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    markTrialPaid(trial.id, parsed.body)
      .then((next) => onDone(next, `Оплачено до ${endDateText(parsed.body.until)} ${parsed.body.until.slice(0, 4)} включительно. Кофейня видит «Полная версия» — без срока и без цены.`))
      .catch((err: unknown) => setError(describeCabinetError(err)))
      .finally(() => setBusy(false));
  }

  return (
    <form className="sub-panel trial-paid-form" onSubmit={submit} noValidate>
      <h3>{again ? `Продлить оплату «${trial.venue}»` : `«${trial.venue}» купили TS`}</h3>
      <label className="day-pick">
        <span>Оплачено до (включительно)</span>
        <input type="date" required min={range.min} max={range.max} value={until} onChange={(e) => setUntil(e.target.value)} />
      </label>
      <label className="field">
        <span>Сумма по договорённости, ₸ (необязательно)</span>
        <input inputMode="decimal" placeholder="например, 150 000" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="field">
        <span>Заметка (необязательно)</span>
        <textarea rows={2} maxLength={TRIAL_PAID_NOTE_MAX} placeholder="Например: оплатили Kaspi, договорились на год" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <p className="hint">Сумму и заметку видит только TS. Кофейня увидит «Полная версия» без срока; после этой даты касса перейдёт в «только чтение». За неделю до конца придёт напоминание.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Сохраняем…' : again ? 'Продлить оплату' : 'Сохранить: купили'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

/** The payments, newest first: when, until when, the sum and the note, who entered it. */
export function PaidHistory({ trial }: { trial: TrialView }) {
  const paid = trial.paid;
  if (!paid) return null;
  return (
    <div className="trial-paid-history">
      <h3>Оплаты</h3>
      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Когда</th>
              <th>Оплачено до</th>
              <th>Сумма</th>
              <th>Заметка</th>
            </tr>
          </thead>
          <tbody>
            {paid.payments.map((p) => (
              <tr key={`${p.at}-${p.until}`}>
                <td>
                  {trialDate(p.at, trial.timezone)}
                  {p.by ? <span className="muted"> · {p.by}</span> : null}
                </td>
                <td>{trialDateYear(Date.UTC(Number(p.until.slice(0, 4)), Number(p.until.slice(5, 7)) - 1, Number(p.until.slice(8, 10)), 12), 'UTC')}</td>
                <td>{paidAmountText(p.amount)}</td>
                <td>{p.note ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
