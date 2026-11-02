import { Fragment } from 'react';
import type { CheckView, ClubSettings, CreateCounterOrderResponse, HubState, Minor, ReceiptData, ReceiptOrderInfo } from '@bills/domain';
import { buildReceipt, formatMoney, normalizeReceiptSettings } from '@bills/domain';
import { formatClock, formatMinutes } from '../../format.ts';
import { QrCode } from '../../QrCode.tsx';
import { formatStamp, Info, Row, Sep } from './blocks.tsx';
import { getPaper } from './paper.ts';
import { printForm } from './printForm.tsx';

/** What a screen holds that a receipt needs: the club and its settings (HubState has both). */
export interface ReceiptContext {
  club: HubState['club'];
  settings: ClubSettings;
}

export interface ReceiptOptions {
  /** Table id → name: titles bar lines whose game is not on the check (billiards). */
  names?: ReadonlyMap<string, string> | undefined;
  /** Counter orders the screen already holds (the counter's fresh order). */
  orders?: readonly ReceiptOrderInfo[] | undefined;
  now?: number | undefined;
}

/**
 * The receipt of a check as it prints: buildReceipt (packages/domain receipt.ts) with the club's
 * «Чек» settings. Print after payment, reprint, archive and preview all come through here.
 */
export function receiptOf(check: CheckView, ctx: ReceiptContext, options: ReceiptOptions = {}): ReceiptData {
  return buildReceipt({
    check,
    club: ctx.club,
    settings: normalizeReceiptSettings(ctx.settings.receipt),
    business: ctx.settings.business?.type,
    now: options.now ?? Date.now(),
    tableNames: options.names,
    orders: options.orders,
  });
}

/**
 * Prints the guest check on this device's paper; an OPEN check comes out as «Предчек» with what
 * is still due. `copies` — the venue's number of copies (the print right after payment);
 * a reprint or a precheck is one copy.
 */
export function printReceipt(check: CheckView, ctx: ReceiptContext, options: ReceiptOptions & { copies?: boolean } = {}): void {
  const data = receiptOf(check, ctx, options);
  const copies = options.copies && !data.precheck ? data.copies : 1;
  printForm(
    Array.from({ length: copies }, (_, i) => <ReceiptForm key={i} data={data} copy={i + 1} />),
    getPaper(),
  );
}

/** The counter's receipt right after the order was taken (and paid): the venue's copies. */
export function printCounterReceipt(res: CreateCounterOrderResponse, ctx: ReceiptContext): void {
  printReceipt(res.check, ctx, { orders: [res.order], copies: true });
}

/** A receipt on screen exactly as it prints, at the given paper width. */
export function ReceiptPreview({ data, paper }: { data: ReceiptData; paper?: '58' | '80' }) {
  return (
    <div className="receipt-sheet">
      <div className="pf-preview" data-paper={paper ?? data.paper} aria-label="Чек, как он будет напечатан">
        <ReceiptForm data={data} />
      </div>
    </div>
  );
}

export function ReceiptForm({ data, copy = 1 }: { data: ReceiptData; copy?: number }) {
  const money = (a: Minor) => formatMoney(a, data.currency);
  const tz = data.timezone;
  const { venue } = data;
  const counter = data.orderNumbers.length > 0;
  const orderSub = [data.service, data.guestName].filter(Boolean).join(' · ');
  const extras = data.wifi || data.instagram || data.qr;

  return (
    <div className="pf pf-receipt">
      <header className="pf-head">
        {venue.logo && <img className="pf-logo" src={venue.logo} alt="" />}
        <p className="pf-club">{venue.name}</p>
        {venue.address && <p>{venue.address}</p>}
        {venue.phone && <p>{venue.phone}</p>}
        {venue.taxId && <p>БИН/ИИН {venue.taxId}</p>}
        {venue.header && <p className="pf-strong">{venue.header}</p>}
      </header>
      {copy > 1 && <p className="pf-copy">Копия</p>}
      {data.precheck && <p className="pf-title pf-center">Предчек</p>}

      {counter ? (
        <>
          <Sep />
          <div className="pf-order">
            <p className="pf-strong">Заказ</p>
            <p className="pf-order-number">{data.orderNumbers.join(', ')}</p>
            {orderSub && <p className="pf-order-sub">{orderSub}</p>}
          </div>
          <Sep />
          <div className="pf-meta">
            <span>Счёт №{data.checkNumber}</span>
            <span>{formatStamp(data.at, tz)}</span>
          </div>
        </>
      ) : (
        <div className="pf-head">
          <p className={data.precheck ? 'pf-strong' : 'pf-title'}>Счёт №{data.checkNumber}</p>
          <p>{formatStamp(data.at, tz)}</p>
          {orderSub && <p className="pf-strong">{orderSub}</p>}
        </div>
      )}
      {data.status === 'VOID' && <p className="pf-strong pf-center">Аннулирован</p>}
      {data.cashier && <Info label={data.cashier.label}>{data.cashier.name}</Info>}

      <Sep />
      {data.groups.map((g) => (
        <Fragment key={g.key}>
          {g.heading && <p className="pf-item pf-strong">{g.heading}</p>}
          {g.items.map((item) => (
            <div key={item.id} className="pf-item">
              <Row label={<span className="pf-name">{item.name}</span>} value={money(item.amount)} />
              {item.options.length > 0 && <p className="pf-sub">{item.options.join(' · ')}</p>}
              {item.qty != null && item.qty > 1 && item.unitPrice != null && (
                <p className="pf-sub">
                  {item.qty} × {money(item.unitPrice)}
                </p>
              )}
              {item.span && (
                <p className="pf-sub">
                  {formatClock(item.span.from, tz)}–{formatClock(item.span.to, tz)} · {formatMinutes(item.span.seconds)}
                </p>
              )}
            </div>
          ))}
        </Fragment>
      ))}
      {data.groups.length === 0 && <p className="pf-center">Позиций нет</p>}

      <Sep />
      {data.discount && (
        <>
          <Row label="Сумма" value={money(data.subtotal)} />
          <Row label={data.discount.label} value={`−${money(data.discount.amount)}`} />
          {data.discount.reason && <p className="pf-sub">{data.discount.reason}</p>}
        </>
      )}
      <div className="pf-row pf-total">
        <span className="pf-label">ИТОГО</span>
        <span className="pf-value">{money(data.total)}</span>
      </div>

      {(data.payments.length > 0 || data.refunds.length > 0) && (
        <>
          <Sep />
          {data.payments.map((p) => (
            <div key={p.id} className="pf-item">
              <Row label={p.at != null ? `${p.label} · ${formatClock(p.at, tz)}` : p.label} value={money(p.amount)} />
              {p.tendered != null && (
                <>
                  <Row sub label="Получено" value={money(p.tendered)} />
                  <Row sub label="Сдача" value={money(p.change ?? 0)} />
                </>
              )}
            </div>
          ))}
          {data.refunds.map((r) => (
            <div key={r.id} className="pf-item">
              <Row label={r.label} value={`−${money(r.amount)}`} />
              {r.reason && <p className="pf-sub">{r.reason}</p>}
            </div>
          ))}
        </>
      )}
      {(data.paid != null || data.refunded != null || data.due != null) && <Sep />}
      {data.paid != null && <Row label="Оплачено" value={money(data.paid)} strong />}
      {data.refunded != null && <Row label="Возвращено" value={money(data.refunded)} strong />}
      {data.due != null && <Row label="К оплате" value={money(data.due)} big />}

      <Sep />
      {data.thanks.map((line, i) => (
        <p key={i} className="pf-thanks">
          {line}
        </p>
      ))}
      {extras && (
        <div className="pf-extra">
          {data.wifi && (
            <p>
              Wi-Fi: <span className="pf-strong">{data.wifi.name}</span>
              {data.wifi.password && (
                <>
                  {' '}
                  · пароль: <span className="pf-strong">{data.wifi.password}</span>
                </>
              )}
            </p>
          )}
          {data.instagram && <p>Instagram: {data.instagram}</p>}
          {data.qr && (
            <div className="pf-qr">
              <QrCode value={data.qr.url} size={84} label={data.qr.caption} />
              <p>{data.qr.caption}</p>
            </div>
          )}
        </div>
      )}
      <p className="pf-center pf-notice">{data.notice}</p>
    </div>
  );
}
