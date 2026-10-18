import './hall.css';

/** Shown while the screen cannot reach the HUB. The HUB itself keeps running games and lamps. */
export function OfflineBanner({ online }: { online: boolean }) {
  if (online) return null;
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
