import { Loading, Page, Section } from '../ui.tsx';
import { useHub } from '../useHub.tsx';
import { LicenseFacts, useLicenseInfo } from './settings/LicenseSection.tsx';
import './settings.css';

/**
 * Address of the platform's cloud cabinet, when the build knows it
 * (VITE_CABINET_URL); without it the page names it in words.
 */
const CABINET_URL = String(import.meta.env.VITE_CABINET_URL ?? '').trim();

/**
 * «Платформа» (owner, tech) on a club's HUB. Clients, their licenses and the
 * support team live in the platform's cloud cabinet; here — only what this HUB
 * knows: its own license and its id for support.
 */
export function PlatformPage() {
  const { state, online, version } = useHub();
  const { info, error } = useLicenseInfo(version);
  return (
    <Page title="Платформа" subtitle="Поддержка TS на HUB этого филиала.">
      <Section title="Клиенты и лицензии">
        <p>
          Клиенты и лицензии — в облачном кабинете платформы
          {CABINET_URL ? (
            <>
              : <a href={CABINET_URL}>{CABINET_URL.replace(/^https?:\/\//, '')}</a>.
            </>
          ) : (
            '.'
          )}{' '}
          Там владелец TS создаёт клиента и управляющего, выдаёт и продлевает лицензию, блокирует доступ. Облако само
          раздаёт подписанную лицензию HUB каждого филиала; HUB без облака получает её вставкой текста в «Настройки клуба»
          → «Лицензия».
        </p>
      </Section>
      <Section title={`Лицензия этого HUB${state ? ` · ${state.club.name}` : ''}`}>
        {error && <p className="field-error">{error}</p>}
        {!info && !error && <Loading online={online} />}
        {info && <LicenseFacts info={info} timeZone={state.club.timezone} />}
      </Section>
    </Page>
  );
}
