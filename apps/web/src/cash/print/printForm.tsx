import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { isDesktopApp, printSilently } from '../../desktop.ts';
import type { Paper } from './paper.ts';
import { getPaper } from './paper.ts';
import './print.css';

const ROOT_ID = 'print-root';
const PAGE_STYLE_ID = 'print-page';
/** CSS px are 1/96 in. */
const MM_PER_PX = 25.4 / 96;
/** Rounding and font differences between screen and print must not spill onto a second page. */
const SLACK_MM = 2;

let cleanup: (() => void) | null = null;

/**
 * Prints one form on the receipt printer: renders it into #print-root (a direct child of
 * <body>; @media print shows only that, open dialogs included), sizes the page to the paper
 * width and the form's height, calls window.print() and removes everything on `afterprint`.
 * In the TS desktop app the same print view goes to the receipt printer without the dialog.
 *
 * An array prints each form on a page of its own (two copies of a receipt: the printer cuts
 * between them); the page is as tall as the tallest form.
 *
 * @page cannot be scoped by a class, so the rule is injected into <head> for this print only.
 * The height is measured on screen: the form uses mm units and the same styles in both media.
 */
export function printForm(form: ReactNode | readonly ReactNode[], paper: Paper = getPaper()): void {
  cleanup?.();

  const pages: readonly ReactNode[] = Array.isArray(form) ? form : [form];
  const container = document.createElement('div');
  container.id = ROOT_ID;
  container.dataset.paper = paper;
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <>
        {pages.map((page, i) => (
          <div key={i} className="pf-page">
            {page}
          </div>
        ))}
      </>,
    ),
  );

  const page = document.createElement('style');
  page.id = PAGE_STYLE_ID;
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
  // Out of the event: afterprint can fire inside window.print(), still in a React handler.
  const onAfterPrint = () => window.setTimeout(finish, 0);
  cleanup = finish;

  const print = () => {
    if (done) return;
    const tallest = Math.max(0, ...[...container.querySelectorAll<HTMLElement>(':scope > .pf-page')].map((p) => p.getBoundingClientRect().height));
    const heightMm = Math.ceil(tallest * MM_PER_PX) + SLACK_MM;
    document.getElementById(PAGE_STYLE_ID)?.remove();
    page.textContent = `@page { size: ${paper}mm ${heightMm}mm; margin: 0; }`;
    document.head.append(page);
    const withDialog = () => {
      if (done) return;
      window.addEventListener('afterprint', onAfterPrint);
      window.print();
    };
    if (!isDesktopApp()) {
      withDialog();
      return;
    }
    // TS desktop app: straight to the receipt printer; if that fails, the usual print dialog.
    printSilently(Number(paper), heightMm).then(finish, withDialog);
  };

  // A picture (the receipt logo) has no height until it is decoded, even from a data URL:
  // measured too early, the page is cut short and the end of the receipt spills onto a new page.
  const pending = [...container.querySelectorAll('img')].filter((img) => !img.complete || img.naturalHeight === 0);
  if (pending.length === 0) {
    print();
    return;
  }
  const decoded = Promise.all(pending.map((img) => img.decode().catch(() => undefined)));
  const timeout = new Promise((resolve) => window.setTimeout(resolve, IMAGE_WAIT_MS));
  void Promise.race([decoded, timeout]).then(print);
}

/** A broken picture must not hold the receipt back. */
const IMAGE_WAIT_MS = 1500;
