import { useCallback, useEffect, useState } from 'react';
import type { GuestLinksResponse, GuestLinkView } from '@bills/domain';
import { QrCode } from '../QrCode.tsx';
import { Confirm, Section } from '../ui.tsx';
import { useHub } from '../useHub.tsx';
import { fetchGuestLinks, guestUrl, rotateGuestLink, setGuestEnabled } from './api.ts';
import './guest.css';

/**
 * «QR для гостей» in «Настройки»: switch the guest page on or off (off by default),
 * print a QR per table (billiards) or one for the counter (coffee shop), and make a new
 * code for a sticker that was photographed or taken away — the old one stops working.
 */
export function GuestQrSection() {
  const hub = useHub();
  const canEdit = hub.canNow('tables.edit');
  const [data, setData] = useState<GuestLinksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotate, setRotate] = useState<GuestLinkView | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchGuestLinks());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const allowed = hub.can('tables.edit');
  useEffect(() => {
    if (allowed) void load();
  }, [load, hub.version, allowed]);

  if (!allowed) return null;
  const busy = hub.isBusy('guest-qr') || !hub.online;
  const cafe = data?.business === 'cafe';

  const toggle = (enabled: boolean) =>
    void hub.run('guest-qr', async () => {
      setData(await setGuestEnabled(hub.actor, enabled));
      hub.notify(enabled ? 'Страница гостя включена' : 'Страница гостя выключена');
    });

  const doRotate = (link: GuestLinkView) =>
    void hub.run('guest-qr', async () => {
      await rotateGuestLink(hub.actor, link.id);
      setRotate(null);
      await load();
      hub.notify(`${link.tableName ?? 'Стойка'}: новый QR-код — распечатайте и замените наклейку`);
    });

  return (
    <Section title="QR для гостей">
      <div className="guest-qr-print">
        <p className="hint">
          {cafe
            ? 'Гость сканирует QR у кассы или на столике, заказывает с телефона и платит на кассе как обычно. Заказ появляется на кассе: «Заказ гостя: Аня, 2 позиции». Потом гость видит номер и «Готово — заберите».'
            : 'Наклейка с QR на каждом столе: гость видит время, сумму и заказы своего стола, может позвать официанта, заказать из бара, попросить продлить игру или счёт. Деньги гость не меняет — запросы принимает сотрудник на экране зала.'}{' '}
          Работает по Wi-Fi заведения, без интернета.
        </p>
        {error && <p className="hint hint-warn">Не удалось загрузить: {error}</p>}
        {data && (
          <>
            <div className="guest-qr-head">
              <label className="check">
                <input type="checkbox" checked={data.enabled} disabled={!canEdit || busy} onChange={(e) => toggle(e.target.checked)} />
                Включить страницу гостя
              </label>
              {data.enabled && data.links.length > 0 && (
                <button type="button" className="btn btn-small" onClick={() => window.print()}>
                  Распечатать {cafe ? 'QR' : 'все QR'}
                </button>
              )}
            </div>
            {!data.enabled && <p className="hint">Выключено: по старым наклейкам гости увидят «Заказ по QR сейчас выключен».</p>}
            {data.enabled && (
              <div className="guest-qr-grid">
                {data.links.map((l) => {
                  const url = guestUrl(l.token);
                  return (
                    <div key={l.id} className="guest-qr-card">
                      <strong>{l.tableName ?? 'Заказ у стойки'}</strong>
                      <QrCode value={url} size={160} label={`QR: ${l.tableName ?? 'стойка'}`} />
                      <span className="guest-qr-url">{url}</span>
                      <span className="hint">Наведите камеру телефона</span>
                      {canEdit && (
                        <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => setRotate(l)}>
                          Новый код
                        </button>
                      )}
                    </div>
                  );
                })}
                {data.links.length === 0 && <p className="hint">Сначала добавьте столы.</p>}
              </div>
            )}
          </>
        )}
      </div>
      <Confirm
        open={rotate !== null}
        title={`Новый QR-код: ${rotate?.tableName ?? 'стойка'}?`}
        text="Старая наклейка перестанет работать сразу. Распечатайте новый код и замените наклейку."
        confirmLabel="Сделать новый"
        busy={busy}
        onConfirm={() => rotate && doRotate(rotate)}
        onCancel={() => setRotate(null)}
      />
    </Section>
  );
}
