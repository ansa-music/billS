import { useState } from 'react';
import { CA_INSTALL_GUIDES } from '@bills/domain';
import { fetchTls } from '../api.ts';
import { Segmented } from '../components.tsx';
import { QrCode } from '../QrCode.tsx';
import { Section } from '../ui.tsx';
import { useHub, useLive } from '../useHub.tsx';

const day = (ms: number) => new Date(ms).toLocaleDateString('ru-RU');

/**
 * «Настройки → Установка на планшеты»: how to open the cash desk on a tablet
 * or phone of the club, step by step. With HTTPS on, the tablet first installs
 * the club's certificate (QR code to the HUB's /ca page), then the app can be
 * installed. Server commands and certificate details are for support only.
 */
export function TlsCard() {
  const hub = useHub();
  const tls = useLive(fetchTls, [], hub.version);
  const [device, setDevice] = useState(CA_INSTALL_GUIDES[0]!.device);
  const s = tls.data;
  const here = typeof window === 'undefined' ? '' : window.location.origin + window.location.pathname;
  const appUrl = s?.enabled ? (s.appUrls[0] ?? here) : here;

  return (
    <Section title="Установка на планшеты">
      {!s ? (
        <p className="hint">{tls.error ?? 'Загрузка…'}</p>
      ) : (
        <div className="tls-body">
          <div className="tls-qr">
            {s.enabled && s.caPageUrls[0] ? (
              <QrCode value={s.caPageUrls[0]} size={184} label="QR-код страницы установки" />
            ) : (
              appUrl && <QrCode value={appUrl} size={184} label="QR-код адреса кассы" />
            )}
            <a className="tls-link" href={s.enabled ? s.caPageUrls[0] : appUrl} target="_blank" rel="noreferrer">
              {s.enabled ? s.caPageUrls[0] : appUrl}
            </a>
            {s.enabled && (
              <a className="btn btn-primary" href="/ca.crt" download="TS-root.crt">
                Скачать сертификат
              </a>
            )}
          </div>
          <div className="tls-guide">
            {s.enabled ? (
              <>
                <p>
                  Наведите камеру планшета на QR-код — откроется страница установки. Сделать это нужно один раз на каждом
                  планшете, телефоне или компьютере кассы.
                </p>
                <Segmented
                  label="Устройство"
                  value={device}
                  options={CA_INSTALL_GUIDES.map((g) => ({ value: g.device, label: g.device }))}
                  onChange={setDevice}
                />
                <ol className="tls-steps">
                  {(CA_INSTALL_GUIDES.find((g) => g.device === device) ?? CA_INSTALL_GUIDES[0]!).steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                  <li>Войдите своим ключом из 6 цифр. В меню браузера выберите «Добавить на главный экран» — касса откроется как приложение.</li>
                </ol>
                {s.renewSoon && <p className="hint">Скоро закончится срок защищённого соединения — сообщите в поддержку TS.</p>}
              </>
            ) : (
              <>
                <ol className="tls-steps">
                  <li>Подключите планшет к Wi-Fi заведения — той же сети, что и компьютер кассы.</li>
                  <li>Наведите камеру планшета на QR-код или наберите адрес под ним в браузере.</li>
                  <li>Войдите своим ключом из 6 цифр.</li>
                  <li>В меню браузера выберите «Добавить на главный экран», чтобы касса открывалась одним нажатием.</li>
                </ol>
                <p className="hint">
                  Если браузер не предлагает добавить кассу на главный экран, попросите поддержку TS включить защищённое
                  соединение — это делается один раз.
                </p>
              </>
            )}
          </div>
        </div>
      )}
      {s && (
        <details className="support-details">
          <summary>Для техподдержки</summary>
          {s.enabled ? (
            <dl className="tls-facts">
              <dt>Адрес приложения</dt>
              <dd>{s.appUrls.join(' · ') || '—'}</dd>
              <dt>Отпечаток</dt>
              <dd>
                <code>{s.caFingerprint}</code>
              </dd>
              <dt>Сертификат HUB</dt>
              <dd>
                до {s.serverValidTo ? day(s.serverValidTo) : '—'}
                {s.renewSoon ? ' — пора выполнить «bills ca init» на сервере' : ''}
              </dd>
              <dt>Корневой</dt>
              <dd>до {s.caValidTo ? day(s.caValidTo) : '—'}</dd>
              {s.mdnsName && (
                <>
                  <dt>Имя в сети</dt>
                  <dd>{s.mdnsName}</dd>
                </>
              )}
            </dl>
          ) : (
            <>
              <p className="hint">HUB работает по HTTP. Включить HTTPS на сервере клуба:</p>
              <pre className="tls-cmd">sudo bills ca init</pre>
              <p className="hint">
                Команда создаст корневой сертификат клуба, переведёт HUB на https://hub.local и покажет здесь QR-код для
                установки сертификата. Для разработки: <code>node apps/hub/src/cli.ts ca init</code> и переменные
                HUB_TLS_CERT / HUB_TLS_KEY.
              </p>
            </>
          )}
        </details>
      )}
    </Section>
  );
}
