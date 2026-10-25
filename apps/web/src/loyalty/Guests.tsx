import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { LoyaltyGuestDetail, LoyaltyGuestRow, LoyaltySettings } from '@bills/domain';
import { formatMoney, minorPerMajor } from '@bills/domain';
import { toActionError } from '../cash/desk.ts';
import { FormError } from '../cash/Modal.tsx';
import { actorName } from '../auth.ts';
import { formatDate, formatDateTime, Modal, Section } from '../ui.tsx';
import { adjustGuest, fetchGuest, fetchGuests } from './model.ts';
import './loyalty.css';

const KIND_LABEL: Record<LoyaltyGuestDetail['moves'][number]['kind'], string> = {
  ACCRUE: 'Начислено',
  REDEEM: 'Списано',
  REVERSE: 'Отменено возвратом',
  RETURN: 'Возвращено',
  ADJUST: 'Вручную',
};

/**
 * «Гости» (manager): everyone who left a phone — visits, last visit, bonuses or stamps.
 * Search by the last digits of the number or by name; the full number is shown only here.
 * A manual change needs a reason and lands in the journal.
 */
export function Guests({ currency, timezone, settings, online }: { currency: string; timezone: string; settings: LoyaltySettings; online: boolean }) {
  const money = (a: number) => formatMoney(a, currency);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<LoyaltyGuestRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (query: string) => {
    try {
      const res = await fetchGuests(query);
      setRows(res.guests);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(toActionError(e).message);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  const balance = (g: LoyaltyGuestRow) =>
    settings.program === 'stamps' ? `${g.stamps} из ${settings.stampsEvery}` : money(g.bonus);

  return (
    <Section title="Гости" aside={rows ? <span className="muted">{total}</span> : undefined}>
      <div className="loy-guests-search">
        <input
          type="search"
          value={q}
          placeholder="Последние цифры номера или имя"
          aria-label="Поиск гостя"
          autoComplete="off"
          inputMode="search"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
      {rows && rows.length === 0 && (
        <p className="empty">{q ? `Никого не нашлось по «${q}».` : 'Пока никого: гость появится после первой оплаты с номером телефона.'}</p>
      )}
      {rows && rows.length > 0 && (
        <ul className="loy-guests">
          {rows.map((g) => (
            <li key={g.id} className="loy-guest">
              <button type="button" onClick={() => setOpen(g.id)} aria-label={`Гость ${g.name ?? g.phoneFull}`}>
                <span className="loy-guest-who">
                  <strong>{g.name ?? 'Без имени'}</strong>
                  <span className="muted">{g.phoneFull}</span>
                </span>
                <span className="loy-guest-visits muted">
                  Визитов: {g.visits}
                  {g.lastVisitAt ? ` · ${formatDate(g.lastVisitAt, timezone)}` : ''}
                </span>
                <span className="loy-guest-balance">{balance(g)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <GuestDialog
          id={open}
          money={money}
          step={minorPerMajor(currency)}
          timezone={timezone}
          settings={settings}
          online={online}
          onClose={() => setOpen(null)}
          onChanged={() => void load(q)}
        />
      )}
    </Section>
  );
}

function GuestDialog({
  id,
  money,
  step,
  timezone,
  settings,
  online,
  onClose,
  onChanged,
}: {
  id: string;
  money: (a: number) => string;
  /** Minor units in one tenge: the bonus field is typed in tenge. */
  step: number;
  timezone: string;
  settings: LoyaltySettings;
  online: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<LoyaltyGuestDetail | null>(null);
  const [name, setName] = useState('');
  const [bonus, setBonus] = useState('');
  const [stamps, setStamps] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchGuest(id).then(
      (d) => {
        setDetail(d);
        setName(d.guest.name ?? '');
      },
      (e: unknown) => setError(toActionError(e).message),
    );
  }, [id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!detail || busy) return;
    const b = bonus.trim() ? Math.round(Number(bonus.replace(',', '.').replace(/\s/g, '')) * step) : 0;
    const s = stamps.trim() ? Number(stamps) : 0;
    if (!Number.isFinite(b) || !Number.isInteger(s)) {
      setError('Бонусы — сумма, штампы — целое число (можно со знаком минус)');
      return;
    }
    const newName = name.trim() || null;
    setBusy(true);
    setError(null);
    try {
      const next = await adjustGuest(actorName(), id, {
        ...(b ? { bonus: b } : {}),
        ...(s ? { stamps: s } : {}),
        ...(newName !== detail.guest.name ? { name: newName } : {}),
        reason: reason.trim(),
      });
      setDetail(next);
      setBonus('');
      setStamps('');
      setReason('');
      onChanged();
    } catch (err) {
      setError(toActionError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const g = detail?.guest;
  return (
    <Modal open title={g ? (g.name ?? g.phoneFull) : 'Гость'} onClose={onClose}>
      {!g ? (
        error ? <p className="form-error">{error}</p> : <p className="muted">Загрузка…</p>
      ) : (
        <div className="form">
          <dl className="kv">
            <div>
              <dt>Телефон</dt>
              <dd>{g.phoneFull}</dd>
            </div>
            <div>
              <dt>{settings.program === 'stamps' ? 'Штампы' : 'Бонусы'}</dt>
              <dd>{settings.program === 'stamps' ? `${g.stamps} из ${settings.stampsEvery}` : money(g.bonus)}</dd>
            </div>
            {g.expiring && settings.program === 'cashback' && (
              <div>
                <dt>Сгорят</dt>
                <dd>
                  {money(g.expiring.amount)} · {formatDate(g.expiring.at, timezone)}
                </dd>
              </div>
            )}
            <div>
              <dt>Визитов</dt>
              <dd>
                {g.visits}
                {g.lastVisitAt ? ` · последний ${formatDate(g.lastVisitAt, timezone)}` : ''}
              </dd>
            </div>
          </dl>
          <form className="form" onSubmit={(e) => void submit(e)}>
            <h3 className="cash-sub">Изменить вручную</h3>
            <div className="loy-adjust">
              <label className="field">
                <span>Имя</span>
                <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span>Бонусы, ₸ (+ или −)</span>
                <input inputMode="decimal" value={bonus} placeholder="+500" onChange={(e) => setBonus(e.target.value)} />
              </label>
              <label className="field">
                <span>Штампы (+ или −)</span>
                <input inputMode="numeric" value={stamps} placeholder="+1" onChange={(e) => setStamps(e.target.value)} />
              </label>
            </div>
            <label className="field loy-reason">
              <span>Причина</span>
              <input value={reason} maxLength={300} placeholder="Например: день рождения, ошибка кассира" onChange={(e) => setReason(e.target.value)} />
            </label>
            <FormError error={error} />
            <div className="modal-actions">
              <button type="submit" className="btn btn-primary" disabled={busy || !online}>
                {busy ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </div>
          </form>
          <h3 className="cash-sub">История</h3>
          {detail.moves.length === 0 ? (
            <p className="muted">Пока пусто.</p>
          ) : (
            <ul className="loy-moves">
              {detail.moves.map((m, i) => (
                <li key={i}>
                  <span className="muted">{formatDateTime(m.at, timezone)}</span>
                  <span>
                    {KIND_LABEL[m.kind]}
                    {m.checkNumber ? ` · счёт №${m.checkNumber}` : ''}
                    {m.kind === 'ADJUST' && m.reason ? ` · ${m.reason}` : ''}
                  </span>
                  <span className="money">
                    {m.bonus !== 0 ? `${m.bonus > 0 ? '+' : '−'}${money(Math.abs(m.bonus))}` : ''}
                    {m.bonus !== 0 && m.stamps !== 0 ? ' ' : ''}
                    {m.stamps !== 0 ? `${m.stamps > 0 ? '+' : '−'}${Math.abs(m.stamps)} шт.` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
