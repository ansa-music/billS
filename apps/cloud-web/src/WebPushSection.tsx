import { useState } from 'react';
import { Section } from './shared.tsx';
import { enableWebPush, webPushDeviceId, webPushSupport } from './webPush.ts';
import type { WebPushSupport } from './webPush.ts';

function supportText(s: Exclude<WebPushSupport, { ok: true }>): string {
  switch (s.reason) {
    case 'no-key':
      return 'В этой сборке кабинета push-уведомления браузера не настроены. Используйте ntfy ниже.';
    case 'insecure':
      return 'Push-уведомления работают только по HTTPS.';
    case 'ios-not-installed':
      return 'На iPhone и iPad уведомления приходят только в приложение с экрана «Домой» (iOS 16.4 и новее): в Safari нажмите «Поделиться» → «На экран „Домой“», откройте TS с экрана «Домой» и включите уведомления там.';
    case 'unsupported':
      return 'Этот браузер не умеет push-уведомления. Откройте кабинет в Chrome, Edge, Firefox или Safari либо используйте ntfy ниже.';
  }
}

type State =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'on' }
  | { state: 'error'; message: string };

/** «Включить уведомления на этом устройстве»: Web Push of the browser / installed PWA (Supabase mode). */
export function WebPushSection({ onChange }: { onChange: () => Promise<void> | void }) {
  const support = webPushSupport();
  const [state, setState] = useState<State>(() => (webPushDeviceId() ? { state: 'on' } : { state: 'idle' }));
  const permission = typeof Notification === 'undefined' ? 'default' : Notification.permission;

  async function enable() {
    setState({ state: 'pending' });
    const r = await enableWebPush();
    if (r.ok) {
      setState({ state: 'on' });
      await onChange();
    } else if (r.reason === 'denied') {
      setState({
        state: 'error',
        message: 'Уведомления запрещены для этого сайта. Разрешите их в настройках браузера (значок замка у адреса) и нажмите кнопку ещё раз.',
      });
    } else {
      setState({ state: 'error', message: `Не удалось включить уведомления: ${r.message}` });
    }
  }

  return (
    <Section title="Уведомления на этом устройстве">
      {!support.ok ? (
        <p className="phone-status" data-tone="muted">
          {supportText(support)}
        </p>
      ) : (
        <>
          <p className="phone-status" data-tone={state.state === 'on' ? 'ok' : state.state === 'error' ? 'warn' : 'muted'}>
            {state.state === 'on'
              ? 'Уведомления на этом устройстве включены'
              : state.state === 'pending'
                ? 'Включаем уведомления…'
                : state.state === 'error'
                  ? state.message
                  : permission === 'denied'
                    ? 'Уведомления запрещены для этого сайта в настройках браузера.'
                    : 'Тревоги клуба будут приходить сюда, даже когда кабинет закрыт.'}
          </p>
          <div className="row wrap">
            <button
              type="button"
              className="btn btn-primary"
              disabled={state.state === 'pending'}
              onClick={() => void enable()}
            >
              {state.state === 'on' ? 'Обновить подписку' : 'Включить уведомления на этом устройстве'}
            </button>
          </div>
          <p className="hint">
            На телефоне лучше установить кабинет: в Chrome — «Установить приложение», на iPhone — «На экран „Домой“»
            (только так iPhone получает уведомления).
          </p>
        </>
      )}
    </Section>
  );
}
