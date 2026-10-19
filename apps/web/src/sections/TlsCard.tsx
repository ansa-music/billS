import { useState } from 'react';
import { CA_INSTALL_GUIDES } from '@bills/domain';
import { fetchTls } from '../api.ts';
import { SectionCard, Segmented } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { QrCode } from '../QrCode.tsx';
import { useHub, useLive } from '../useHub.tsx';

const day = (ms: number) => new Date(ms).toLocaleDateString('ru-RU');

/**
 * HTTPS in the club network: QR code to the HUB's /ca page (root certificate +
 * instructions) and the same steps per device, so the tablet installs the
 * club's certificate once and the app works over https://hub.local.
 */
export function TlsCard() {
  const hub = useHub();
  const tls = useLive(fetchTls, [], hub.version);
  const [device, setDevice] = useState(CA_INSTALL_GUIDES[0]!.device);
  const s = tls.data;

  const badge = !s ? null : !s.enabled ? (
    <span className="status-badge" data-tone="warn">HTTP</span>
  ) : s.renewSoon ? (
    <span className="status-badge" data-tone="warn">продлить</span>
  ) : (
    <span className="status-badge" data-tone="good">HTTPS</span>
  );

  return (
    <SectionCard
      className="tls-card"
      title={
        <>
          <Icon name="check" size={18} /> Сертификат клуба
        </>
      }
      actions={badge}
    >
      {!s ? (
        <p className="hint">{tls.error ?? 'Загрузка…'}</p>
      ) : !s.enabled ? (
        <div className="tls-off">
          <p>
            HUB работает по обычному HTTP. Планшеты Android и ПК с Chrome не дадут установить приложение без защищённого
            адреса. Включите HTTPS на сервере клуба одной командой:
          </p>
          <pre className="tls-cmd">sudo bills ca init</pre>
          <p className="hint">
            Она создаст корневой сертификат клуба, переведёт HUB на https://hub.local и откроет здесь QR-код для установки
            сертификата на планшеты. Для разработки: <code>node apps/hub/src/cli.ts ca init</code> и переменные HUB_TLS_CERT /
            HUB_TLS_KEY.
          </p>
        </div>
      ) : (
        <div className="tls-body">
          <div className="tls-qr">
            {s.caPageUrls[0] && <QrCode value={s.caPageUrls[0]} size={184} label="QR-код страницы сертификата" />}
            <a className="tls-link" href={s.caPageUrls[0]} target="_blank" rel="noreferrer">
              {s.caPageUrls[0]}
            </a>
            <a className="btn btn-primary" href="/ca.crt" download="TS-root.crt">
              Скачать сертификат
            </a>
          </div>
          <div className="tls-guide">
            <p>
              Отсканируйте QR-код камерой планшета — откроется страница с сертификатом. Установить его нужно один раз на каждое
              устройство.
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
            </ol>
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
          </div>
        </div>
      )}
    </SectionCard>
  );
}
