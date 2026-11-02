// Rebuilds design-system/project/components/bundle.css from the apps' stylesheets.
// Run from anywhere: node design-system/scripts/build-css.cjs [out.css]
// bundle.css = shared colour-scheme + the cabinet sheet scoped to :root:not([data-surface="pos"]) + the POS sheets scoped to :root[data-surface="pos"].
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const postcss = require('postcss');
const R = path.join(__dirname, '../../apps');
const OUT = process.argv[2] ?? path.join(__dirname, '../project/components/bundle.css');
let REF = 'local';
try { REF = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch {}
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r/g, '');
const MONO = /font-family: ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;/g;

function scope(css, sc) {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    rule.selectors = rule.selectors.map((s) => {
      s = s.trim();
      if (/^html\b/.test(s)) return sc + s.slice(4);
      if (/^:root\b/.test(s)) return sc + s.slice(5);
      return `${sc} ${s}`;
    });
  });
  return root.toString();
}

// Cabinet: apps/cloud-web/src/styles.css after its two token blocks (lines 1–48).
const cabSrc = read(`${R}/cloud-web/src/styles.css`).split('\n');
if (!cabSrc[3].startsWith(':root {') || cabSrc[47] !== '}') throw new Error('cabinet layout changed');
const cab = `:root {\n  font-family: var(--font-sans);\n  font-size: 16px;\n  line-height: 1.4;\n}\n` +
  cabSrc.slice(48).join('\n').replace(MONO, 'font-family: var(--font-mono);')
    .replace('@keyframes blink {', '@keyframes cab-blink {').replace('animation: blink 1.6s', 'animation: cab-blink 1.6s');
if (!cab.includes('animation: cab-blink 1.6s')) throw new Error('blink rename failed');

// POS: apps/web/src/styles.css minus its token blocks, then app.css.
let pos = read(`${R}/web/src/styles.css`);
function cut(re) {
  const i = pos.search(re); if (i < 0) throw new Error('missing ' + re);
  let d = 0, j = pos.indexOf('{', i);
  for (; j < pos.length; j++) { if (pos[j] === '{') d++; else if (pos[j] === '}' && --d === 0) break; }
  pos = pos.slice(0, i) + pos.slice(j + 1);
}
cut(/^:root \{/m); cut(/^@media \(prefers-color-scheme: light\) \{/m); cut(/^:root\[data-theme='light'\] \{/m);
const posBase = `:root {
  --accent-soft: color-mix(in oklab, var(--accent) 16%, var(--surface));
  --dur-fast: 90ms;
  --dur: 160ms;
  --ease: cubic-bezier(0.2, 0.7, 0.3, 1);
  --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
  font-family: var(--font-inter);
  font-size: 16px;
  line-height: 1.45;
  /* tnum: money and clocks keep their width while they tick. */
  font-feature-settings: 'cv11', 'ss01', 'tnum';
  font-variant-numeric: tabular-nums;
}
`;
// Every stylesheet the screen loads, in the order the running app puts them in <head>
// (read from the dev server's <style data-vite-dev-id> tags; @fontsource is the fonts in tokens.json).
const POS_FILES = ['shell.css', 'hall.css', 'plan.css', 'sections.css', 'app.css', 'onboarding/onboarding.css', 'trial/trial.css', 'trial/trial-move.css',
  'cafe/staff-touch.css', 'hall/bookings.css', 'prepaid/prepaid.css', 'cash/cash.css', 'guest/guest.css', 'cash/print/print.css',
  'loyalty/loyalty.css', 'insights/insights.css', 'pages/apps.css', 'cafe/cafe.css', 'pages/bar.css', 'pages/settings.css',
  'pages/owner.css', 'pages/staff.css', 'cafe/edit/edit.css', 'cafe/pos-touch.css', 'stock/stock.css'];
let posAll = posBase + pos + POS_FILES.map((f) => `\n/* ---- apps/web/src/${f} ---- */\n` + read(`${R}/web/src/${f}`)).join('');
// Source theme ids → the system's POS theme ids.
posAll = posAll.replace(/\[data-theme=(['"])(light|dark)\1\]/g, (m, q, t) => `[data-theme=${q}pos-${t}${q}]`);
// The barista and guest-board stage colours live in tokens.json (kds-*, gb-*): drop their local declarations.
const MOVED = new Set(['--kds-new', '--kds-prep', '--kds-ready', '--kds-on-ready', '--kds-attn', '--gb-ready', '--gb-ready-ink']);
{
  const root = postcss.parse(posAll);
  root.walkDecls((d) => { if (MOVED.has(d.prop)) d.remove(); });
  let changed = true;
  while (changed) { changed = false; root.walk((n) => { if ((n.type === 'rule' || (n.type === 'atrule' && n.nodes)) && n.nodes.length === 0) { n.remove(); changed = true; } }); }
  posAll = root.toString();
}

const head = `/* TS — стили компонентов двух поверхностей (ansa-music/billS@${REF}).
   Кабинет владельца — apps/cloud-web/src/styles.css, действует по умолчанию (:root без data-surface="pos").
   Касса — все стили apps/web/src в порядке приложения (styles.css, shell.css … cafe/cafe.css, cafe/pos-touch.css, stock/stock.css), действует при <html data-surface="pos">.
   Цвета, тени, отступы, радиусы, размеры шрифта и высоты — в tokens.css (из tokens.json); темы: dark, light (кабинет), pos-dark, pos-light (касса).
   Отличия от исходников: блоки токенов вынесены в tokens.json, селекторы получили префикс поверхности,
   анимация мигания кабинета переименована в cab-blink (в кассе своя blink),
   темы кассы [data-theme=light|dark] → pos-light|pos-dark, цвета стадий бариста и экрана гостей (--kds-*, --gb-*) вынесены в tokens.json. */

:root,
[data-theme="dark"],
[data-theme="pos-dark"] {
  color-scheme: dark;
}

[data-theme="light"],
[data-theme="pos-light"] {
  color-scheme: light;
}

/* ===== Кабинет ===== */
`;
const out = head + scope(cab, ':root:not([data-surface="pos"])') + '\n\n/* ===== Касса ===== */\n' + scope(posAll, ':root[data-surface="pos"]');
if (/<\/style/i.test(out)) throw new Error('</style');
fs.writeFileSync(OUT, out);
const vars = [...new Set(out.match(/var\(--[a-z0-9-]+/g))].map((v) => v.slice(6)).sort();
console.log(`${path.relative(process.cwd(), OUT)}: ${out.length} chars, ${vars.length} variables`);
