/**
 * HTTPS in the club network: what the HUB reports about its certificates
 * (GET /api/tls) and how staff install the club's root certificate on a device.
 * The same steps are shown on the «Оборудование» page and on the HUB's own /ca page.
 */

export interface TlsStatus {
  /** HUB serves HTTPS (HUB_TLS_CERT / HUB_TLS_KEY set). */
  enabled: boolean;
  /** mDNS name the HUB announces, e.g. `hub.local`; null when off. */
  mdnsName: string | null;
  httpsPort: number | null;
  /** Plain-HTTP port that redirects to HTTPS and serves the root certificate; null when off. */
  httpPort: number | null;
  /** Root certificate: subject, SHA-256 fingerprint (`AA:BB:…`), expiry (ms). */
  caSubject: string | null;
  caFingerprint: string | null;
  caValidTo: number | null;
  /** HUB certificate expiry (ms) and whether it is time to run `bills ca init` again. */
  serverValidTo: number | null;
  renewSoon: boolean;
  /** Names and addresses the HUB certificate covers. */
  dnsNames: string[];
  ips: string[];
  /** Page with the certificate and instructions — for the QR code; LAN addresses first. */
  caPageUrls: string[];
  /** Where the app lives over HTTPS once the certificate is installed. */
  appUrls: string[];
}

export interface CaInstallGuide {
  device: string;
  steps: string[];
}

export const CA_INSTALL_GUIDES: readonly CaInstallGuide[] = [
  {
    device: 'Планшет Android',
    steps: [
      'Отсканируйте QR-код камерой и откройте страницу, нажмите «Скачать сертификат» — файл сохранится в «Загрузки».',
      'Настройки → Безопасность (или «Безопасность и конфиденциальность») → Другие настройки безопасности → Шифрование и учётные данные → Установить сертификат → Сертификат ЦС.',
      'Нажмите «Всё равно установить», выберите скачанный файл TS-root.crt.',
      'Откройте в Chrome адрес HUB по https — замка с предупреждением больше нет, приложение можно установить.',
    ],
  },
  {
    device: 'iPad / iPhone',
    steps: [
      'Откройте страницу из QR-кода в Safari и нажмите «Скачать сертификат» → «Разрешить».',
      'Настройки → «Профиль загружен» (вверху) → Установить → введите код-пароль → Установить.',
      'Настройки → Основные → Об этом устройстве → Доверие сертификатам (в самом низу) → включите переключатель у сертификата TS.',
      'Откройте адрес HUB по https в Safari.',
    ],
  },
  {
    device: 'ПК Windows',
    steps: [
      'Откройте страницу сертификата в браузере и скачайте TS-root.crt.',
      'Двойной щелчок по файлу → «Установить сертификат…» → «Локальный компьютер» (нужны права администратора) → «Поместить все сертификаты в следующее хранилище» → «Доверенные корневые центры сертификации» → Готово.',
      'Перезапустите Chrome или Edge и откройте адрес HUB по https.',
    ],
  },
];

/** `https://host[:port]/` without the default port. */
export function originUrl(scheme: 'http' | 'https', host: string, port: number | null): string {
  const defaultPort = scheme === 'https' ? 443 : 80;
  const h = host.includes(':') ? `[${host}]` : host;
  return `${scheme}://${h}${port === null || port === defaultPort ? '' : `:${port}`}`;
}
