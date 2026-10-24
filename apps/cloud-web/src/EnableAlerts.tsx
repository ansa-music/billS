/**
 * «Включить уведомления на этом телефоне» (Supabase mode): one button. Browser push when this
 * browser can do it (installed cabinet, desktop browsers); otherwise a free notifications app
 * (ntfy) in two steps. Own server, topics and other details stay in «Дополнительно» (NtfySection).
 */
import { useState } from 'react';
import type { TestPushResponse } from '@bills/domain';
import { sendTestPush } from './api.ts';
import { currentNtfyTopic, enableNtfy, newNtfyTopicUrl } from './ntfy.ts';
import { nativeBridge } from './platform.ts';
import { QrImage } from './QrImage.tsx';
import { Section } from './shared.tsx';
import { DEFAULT_NTFY_SERVER, isIos, ntfyLinks } from './supabase-util.ts';
import { enableWebPush, webPushDeviceId, webPushSupport } from './webPush.ts';

const GOOGLE_PLAY = 'https://play.google.com/store/apps/details?id=io.heckel.ntfy';
const APP_STORE = 'https://apps.apple.com/app/ntfy/id1625396347';

type State =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'on'; via: 'browser' | 'app' }
  | { kind: 'error'; message: string };

function deviceWord(): string {
  if (nativeBridge()) return 'телефоне';
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /Android|iPhone|iPad|Mobile/i.test(ua) || isIos(ua, navigator.maxTouchPoints) ? 'телефоне' : 'компьютере';
}

function testText(r: TestPushResponse): string {
  if (!r.pushEnabled) return 'Отправка уведомлений на сервере TS пока не настроена — напишите в поддержку.';
  if (r.sent === 0 && r.failed === 0) return 'Пока некуда отправить: включите уведомления кнопкой выше.';
  return r.failed > 0 ? `Отправлено: ${r.sent}, не дошло: ${r.failed}. Проверьте разрешения уведомлений.` : 'Отправили! Уведомление должно прийти через несколько секунд.';
}

export function EnableAlerts({ onChange }: { onChange: () => Promise<void> | void }) {
  const inApp = nativeBridge() !== null;
  const support = inApp ? null : webPushSupport();
  const browserPush = support?.ok === true;
  const ios = typeof navigator !== 'undefined' && isIos(navigator.userAgent, navigator.maxTouchPoints);
  const [topic, setTopic] = useState(() => currentNtfyTopic()?.topicUrl ?? null);
  const [state, setState] = useState<State>(() =>
    browserPush && webPushDeviceId() ? { kind: 'on', via: 'browser' } : topic ? { kind: 'on', via: 'app' } : { kind: 'idle' },
  );
  const [test, setTest] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const word = deviceWord();

  async function enable() {
    setState({ kind: 'pending' });
    setTest(null);
    if (browserPush) {
      const r = await enableWebPush();
      if (r.ok) {
        setState({ kind: 'on', via: 'browser' });
        await onChange();
      } else if (r.reason === 'denied') {
        setState({
          kind: 'error',
          message: 'Уведомления запрещены для этого сайта. Разрешите их в настройках браузера (значок замка рядом с адресом) и нажмите ещё раз.',
        });
      } else {
        setState({ kind: 'error', message: `Не получилось включить: ${r.message}` });
      }
      return;
    }
    try {
      const url = topic ?? newNtfyTopicUrl(DEFAULT_NTFY_SERVER);
      await enableNtfy(url);
      setTopic(url);
      setState({ kind: 'on', via: 'app' });
      await onChange();
    } catch (e) {
      setState({ kind: 'error', message: `Не получилось включить: ${(e as Error).message}` });
    }
  }

  async function sendTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(testText(await sendTestPush()));
      await onChange();
    } catch (e) {
      setTest(`Не получилось отправить: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  }

  const links = topic ? ntfyLinks(topic) : null;
  const showSteps = state.kind === 'on' && state.via === 'app' && links;

  return (
    <Section title={`Уведомления на этом ${word}`}>
      <p className="hint alerts-lead">
        Тревоги из заведения — касса без связи, долгая игра, недостача в смене — придут сюда, даже когда кабинет закрыт.
      </p>

      {state.kind === 'on' && state.via === 'browser' ? (
        <p className="phone-status" data-tone="ok">
          ✓ Уведомления на этом {word} включены
        </p>
      ) : state.kind === 'error' ? (
        <p className="phone-status" data-tone="warn" role="alert">
          {state.message}
        </p>
      ) : null}

      {!(state.kind === 'on') && (
        <button type="button" className="btn btn-primary btn-big-text alerts-main" disabled={state.kind === 'pending'} onClick={() => void enable()}>
          {state.kind === 'pending' ? 'Включаем…' : `Включить уведомления на этом ${word}`}
        </button>
      )}

      {showSteps && links && (
        <ol className="alerts-steps">
          <li>
            <strong>Установите бесплатное приложение для уведомлений</strong>
            <span className="hint">Без регистрации и рекламы.</span>
            <div className="row wrap">
              {!ios && (
                <a className="btn" href={GOOGLE_PLAY} target="_blank" rel="noreferrer">
                  Открыть Google Play
                </a>
              )}
              {(ios || word === 'компьютере') && (
                <a className="btn" href={APP_STORE} target="_blank" rel="noreferrer">
                  Открыть App Store
                </a>
              )}
            </div>
          </li>
          <li>
            <strong>Вернитесь сюда и нажмите «Подписаться»</strong>
            <span className="hint">Приложение откроется и начнёт получать тревоги этого кабинета.</span>
            <div className="row wrap">
              <a className="btn btn-primary" href={links.deepLink}>
                Подписаться
              </a>
              <button type="button" className="btn" disabled={testing} onClick={() => void sendTest()}>
                {testing ? 'Отправляем…' : 'Прислать пробное'}
              </button>
            </div>
            {word === 'компьютере' && (
              <div className="alerts-qr">
                <QrImage text={links.https} alt="QR-код: подписка на уведомления с телефона" />
                <span className="hint">На компьютере? Отсканируйте QR телефоном, на котором стоит приложение.</span>
              </div>
            )}
          </li>
        </ol>
      )}

      {state.kind === 'on' && state.via === 'browser' && (
        <div className="row wrap">
          <button type="button" className="btn" disabled={testing} onClick={() => void sendTest()}>
            {testing ? 'Отправляем…' : 'Прислать пробное уведомление'}
          </button>
        </div>
      )}

      {test && (
        <p className="saved" role="status">
          {test}
        </p>
      )}

      {!browserPush && !inApp && support && !support.ok && support.reason === 'ios-not-installed' && (
        <p className="hint">
          На iPhone можно и без приложения: в Safari нажмите «Поделиться» → «На экран „Домой“», откройте TS с экрана «Домой» и
          включите уведомления там.
        </p>
      )}
    </Section>
  );
}
