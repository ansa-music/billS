import { useState } from 'react';
import { hintName } from '@bills/domain';
import { Icon } from '../icons.tsx';
import { useStockAlerts } from '../stock/alerts.ts';

const DISMISSED_KEY = 'ts.stockStrip.dismissed';

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/**
 * «Заканчивается: молоко, стаканы 0,4» on the barista's screen. «Понятно» hides it on this
 * device until something else runs low; it never blocks anything.
 */
export function StockStrip() {
  const alerts = useStockAlerts();
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const low = alerts?.low ?? [];
  if (low.length === 0 || low.every((l) => dismissed.has(l.id))) return null;
  const dismiss = () => {
    const ids = new Set(low.map((l) => l.id));
    setDismissed(ids);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
    } catch {
      // Private mode: hidden until the page reloads.
    }
  };
  return (
    <div className="stock-strip" role="status">
      <Icon name="alert" size={20} />
      <span className="stock-strip-text">
        <strong>Заканчивается:</strong> {low.map((l) => hintName(l.name) + (l.out ? ' (нет)' : '')).join(', ')}
      </span>
      <button type="button" className="btn btn-small" onClick={dismiss} aria-label="Скрыть: понятно">
        Понятно
      </button>
    </div>
  );
}
