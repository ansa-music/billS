import { useState } from 'react';
import { hintName } from '@bills/domain';
import { Icon } from '../icons.tsx';
import { useStockAlerts } from '../stock/alerts.ts';

const DISMISSED_KEY = 'ts.stockStrip.dismissed';

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * «Заканчивается: молоко (нет), стакан 0,3» on the barista's screen, from the levels and the
 * minimums of «Склад». «Понятно» hides it on this device until something else runs low (or what
 * was low runs out); it never blocks anything.
 */
export function StockStrip() {
  const alerts = useStockAlerts();
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const low = alerts?.low ?? [];
  const keys = low.map((l) => `${l.id}:${l.out ? 'out' : 'low'}`);
  if (low.length === 0 || keys.every((k) => dismissed.has(k))) return null;
  const dismiss = () => {
    const next = new Set(keys);
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
    } catch {
      // A private window: hidden until the page reloads.
    }
  };
  return (
    <div className="stock-strip" role="status">
      <Icon name="alert" size={20} />
      <span className="stock-strip-text">
        <strong>Заканчивается:</strong>{' '}
        {low.map((l, i) => (
          <span key={l.id}>
            {i > 0 && ', '}
            {hintName(l.name)}
            {l.out && <span className="stock-strip-out"> (нет)</span>}
          </span>
        ))}
      </span>
      <button type="button" className="btn btn-small" onClick={dismiss}>
        Понятно
      </button>
    </div>
  );
}
