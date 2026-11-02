import { isLinkMode } from './demo-hub/link-mode.ts';

/**
 * Shown while the screen cannot reach the HUB. The HUB itself keeps running games and lamps.
 * A device working through the trial cash desk says it in its own words instead (trial/LinkBanner.tsx).
 */
export function OfflineBanner({ online }: { online: boolean }) {
  if (online || isLinkMode()) return null;
  return (
    <div className="hall-offline" role="status">
      <span className="hall-offline-dot" aria-hidden="true" />
      <p className="hall-offline-text">
        <strong>Нет связи с HUB.</strong> Игры и свет продолжают работать в HUB — кнопки вернутся, как только связь
        восстановится.
      </p>
    </div>
  );
}
