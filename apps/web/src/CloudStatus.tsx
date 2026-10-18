import type { SyncStatus } from '@bills/domain';
import { formatClock } from './format.ts';

/** «Облако: …» next to the HUB link status; hidden when the club runs without a cloud. */
export function CloudStatus({ sync, timezone }: { sync: SyncStatus; timezone: string }) {
  if (!sync.enabled) return null;
  let state: 'ok' | 'queue' | 'error' | 'wait';
  let text: string;
  let title: string | undefined;
  if (sync.lastError) {
    state = 'error';
    text = 'Облако: нет связи';
    title = sync.lastErrorAt ? `${sync.lastError} (${formatClock(sync.lastErrorAt, timezone)})` : sync.lastError;
  } else if (sync.pending > 0) {
    state = 'queue';
    text = `Облако: ${sync.pending} в очереди`;
    title = sync.lastSentAt ? `Последняя отправка ${formatClock(sync.lastSentAt, timezone)}` : undefined;
  } else if (sync.lastSentAt) {
    state = 'ok';
    text = 'Облако: синхронизировано';
    title = `Последняя отправка ${formatClock(sync.lastSentAt, timezone)}`;
  } else {
    state = 'wait';
    text = 'Облако: подключение…';
  }
  return (
    <span className="cloud" data-state={state} title={title ?? text} aria-label={text}>
      <span className="cloud-text">{text}</span>
    </span>
  );
}
