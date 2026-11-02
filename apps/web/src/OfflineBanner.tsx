import { isLinkMode } from './demo-hub/link-mode.ts';

/**
 * Shown while the screen cannot reach the HUB. The HUB itself keeps running games and lamps.
 * A device working through the trial cash desk says it in its own words instead (trial/LinkBanner.tsx).
 */
export function OfflineBanner({ online }: { online: boolean }) {
  if (online || isLinkMode()) return null;
  // The shell marks a coffee shop on <html> (Shell.tsx): no games or lamps to mention there.
  const cafe = document.documentElement.dataset.business === 'cafe';
  return (
    <div className="hall-offline" role="status">
      <span className="hall-offline-dot" aria-hidden="true" />
      <p className="hall-offline-text">
        {cafe ? (
          <>
            <strong>Нет связи с TS.</strong> Заказы и деньги в сохранности — экран обновится сам, как только связь
            вернётся.
          </>
        ) : (
          <>
            <strong>Нет связи с HUB.</strong> Игры и свет продолжают работать в HUB — кнопки вернутся, как только связь
            восстановится.
          </>
        )}
      </p>
    </div>
  );
}
