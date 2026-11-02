/**
 * «Уведомления о заявках» of the platform cabinet (Supabase mode): every new trial request reaches the
 * platform owner in Telegram (the TS bot, one-time link) and/or as a push on this device (the installed
 * cabinet, VAPID). «Проверить» sends a test message to the person's own chats and devices.
 */
import { useCallback, useEffect, useState } from 'react';
import type { PlatformDevicesView } from '@bills/domain';
import { fetchPlatformDevices, registerPlatformDevice, removePlatformDevice, testPlatformNotify } from './api.ts';
import { describeCabinetError } from './license-form.ts';
import { Section } from './shared.tsx';
import { TelegramSection } from './TelegramSection.tsx';
import { enableWebPush, forgetPlatformWebPush, webPushDeviceId, webPushSupport } from './webPush.ts';
import { supportText } from './WebPushSection.tsx';

const SLOT = 'platform-webpush' as const;

function PlatformWebPush() {
  const support = webPushSupport();
  const [view, setView] = useState<PlatformDevicesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      setView(await fetchPlatformDevices());
    } catch (e) {
      setNote({ tone: 'warn', text: `Не удалось узнать устройства: ${describeCabinetError(e)}` });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const mine = webPushDeviceId(SLOT);
  const devices = view?.devices ?? [];
  const here = mine !== null && devices.some((d) => d.id === mine);

  async function enable() {
    setBusy(true);
    setNote(null);
    const r = await enableWebPush({ register: registerPlatformDevice, slot: SLOT });
    if (r.ok) {
      setNote({ tone: 'ok', text: 'Готово: заявки будут приходить на это устройство, даже когда кабинет закрыт.' });
      await reload();
    } else if (r.reason === 'denied') {
      setNote({ tone: 'warn', text: 'Уведомления запрещены для этого сайта. Разрешите их в настройках браузера (значок замка у адреса) и нажмите ещё раз.' });
    } else {
      setNote({ tone: 'warn', text: `Не удалось включить уведомления: ${r.message}` });
    }
    setBusy(false);
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Отключить уведомления о заявках на «${name}»?`)) return;
    setBusy(true);
    setNote(null);
    try {
      await removePlatformDevice(id);
      if (id === mine) forgetPlatformWebPush();
      await reload();
    } catch (e) {
      setNote({ tone: 'warn', text: `Не удалось отключить: ${describeCabinetError(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNote(null);
    try {
      const r = await testPlatformNotify();
      setNote(
        r.delivered > 0
          ? { tone: 'ok', text: `Проверка отправлена: ${r.delivered}${r.failed ? `, не дошло: ${r.failed}` : ''}.` }
          : { tone: 'warn', text: r.failed ? `Не дошло ни одно сообщение (${r.failed}). Подключите Telegram или устройство заново.` : 'Пока некуда отправлять: подключите Telegram или это устройство.' },
      );
    } catch (e) {
      setNote({ tone: 'warn', text: `Не получилось: ${describeCabinetError(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Заявки на этом устройстве">
      {view && !view.pushEnabled ? (
        <p className="phone-status" data-tone="muted">
          Уведомления браузера пока не настроены в облаке TS (ключи VAPID). Заявки придут в Telegram.
        </p>
      ) : !support.ok ? (
        <p className="phone-status" data-tone="muted">
          {supportText(support)}
        </p>
      ) : (
        <>
          <p className="phone-status" data-tone={here ? 'ok' : 'muted'}>
            {here ? '✓ На этом устройстве заявки включены' : 'Новая заявка появится уведомлением, даже когда кабинет закрыт.'}
          </p>
          <div className="row wrap">
            <button type="button" className={here ? 'btn' : 'btn btn-primary'} disabled={busy} onClick={() => void enable()}>
              {here ? 'Обновить подписку' : 'Получать заявки на этом устройстве'}
            </button>
          </div>
        </>
      )}
      {devices.length > 0 && (
        <ul className="trial-devices">
          {devices.map((d) => (
            <li key={d.id}>
              {d.name}
              {d.id === mine ? ' (это устройство)' : ''}
              {d.lastError ? <span className="muted"> · не доставлено: {d.lastError}</span> : null} ·{' '}
              <button type="button" className="btn-link" disabled={busy} onClick={() => void remove(d.id, d.name)}>
                отключить
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap">
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void test()}>
          Проверить уведомления
        </button>
      </div>
      {note && (
        <p className="phone-status" data-tone={note.tone} role="status">
          {note.text}
        </p>
      )}
    </Section>
  );
}

/** Telegram and this device: where the platform owner hears about new requests. */
export function TrialAlerts() {
  return (
    <>
      <TelegramSection variant="platform" />
      <PlatformWebPush />
    </>
  );
}
