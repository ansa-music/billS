import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

const ROOT_ID = 'print-sheet';
const PAGE_STYLE_ID = 'print-sheet-page';

let cleanup: (() => void) | null = null;

/**
 * Prints one sheet on an ordinary printer (A4): renders `sheet` into #print-sheet, a direct
 * child of <body> that @media print in stock.css shows alone (the app and open dialogs
 * hidden), calls window.print() and removes it all on `afterprint`. Receipts go through
 * cash/print/printForm.tsx instead — that one sizes the page to the receipt paper.
 */
export function printSheet(sheet: ReactNode): void {
  cleanup?.();
  const container = document.createElement('div');
  container.id = ROOT_ID;
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(sheet));
  const page = document.createElement('style');
  page.id = PAGE_STYLE_ID;
  page.textContent = '@page { size: A4; margin: 14mm; }';
  document.head.append(page);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('afterprint', onAfterPrint);
    if (cleanup === finish) cleanup = null;
    root.unmount();
    container.remove();
    page.remove();
  };
  const onAfterPrint = () => window.setTimeout(finish, 0);
  cleanup = finish;
  window.addEventListener('afterprint', onAfterPrint);
  window.print();
}
