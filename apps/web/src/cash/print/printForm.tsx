import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
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
 *
 * @page cannot be scoped by a class, so the rule is injected into <head> for this print only.
 * The height is measured on screen: the form uses mm units and the same styles in both media.
 */
export function printForm(form: ReactNode, paper: Paper = getPaper()): void {
  cleanup?.();

  const container = document.createElement('div');
  container.id = ROOT_ID;
  container.dataset.paper = paper;
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(form));

  const heightMm = Math.ceil(container.getBoundingClientRect().height * MM_PER_PX) + SLACK_MM;
  document.getElementById(PAGE_STYLE_ID)?.remove();
  const page = document.createElement('style');
  page.id = PAGE_STYLE_ID;
  page.textContent = `@page { size: ${paper}mm ${heightMm}mm; margin: 0; }`;
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
  // Out of the event: afterprint can fire inside window.print(), still in a React handler.
  const onAfterPrint = () => window.setTimeout(finish, 0);
  cleanup = finish;
  window.addEventListener('afterprint', onAfterPrint);
  window.print();
}
