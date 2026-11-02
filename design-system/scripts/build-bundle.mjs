// Rebuilds design-system/project/components/bundle.js (window.TS) from the apps' real components.
// Run from anywhere: node design-system/scripts/build-bundle.mjs [out.js]
// One classic IIFE script: React comes from window.React (React 18 on the page), JSX goes through createElement.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const out = process.argv[2] ?? join(here, '../project/components/bundle.js');

// The components that get a card, in catalogue order (the @ds-bundle header).
const names = ['BrandMark', 'CabinetNav', 'Section', 'StatTile', 'MethodSplit', 'Difference', 'HubBadge', 'LicenseChip', 'OfflineBanner', 'AlertList', 'CopyValue', 'ShownOnce',
  'PosSection', 'PosField', 'PosSegmented', 'PosSkeletonList', 'PosToast', 'PosModal', 'PosConfirm'];
const entry = `
export { BrandMark } from './apps/cloud-web/src/BrandMark.tsx';
export { CabinetNav } from './apps/cloud-web/src/CabinetNav.tsx';
export { Section, StatTile, MethodSplit, Difference, HubBadge, OfflineBanner, AlertList } from './apps/cloud-web/src/shared.tsx';
export { LicenseChip, LicenseLine, CopyValue, CopyButton, ShownOnce } from './apps/cloud-web/src/cabinet-ui.tsx';
export { Section as PosSection, Empty as PosEmpty, SkeletonList as PosSkeletonList, Loading as PosLoading, Field as PosField, Segmented as PosSegmented, Toast as PosToast, Modal as PosModal, Confirm as PosConfirm } from './apps/web/src/ui.tsx';
`;
const REACT_SHIM = `const R = window.React;
export default R;
export const { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useReducer, useContext, useId, createContext, Fragment, createElement } = R;`;
const JSX_SHIM = `const R = window.React;
function jsx(type, props, key) { return R.createElement(type, key === undefined ? props : Object.assign({}, props, { key })); }
function jsxs(type, props, key) { const { children, ...rest } = props; if (key !== undefined) rest.key = key; return R.createElement(type, rest, ...children); }
export { jsx, jsxs };
export const Fragment = R.Fragment;`;

const header = `/* @ds-bundle: ${JSON.stringify({ format: 4, namespace: 'TS', components: names.map((name) => ({ name })) })} */`;
await build({
  stdin: { contents: entry, resolveDir: repo, sourcefile: 'design-system-entry.ts', loader: 'ts' },
  bundle: true, format: 'iife', globalName: '__TS', minify: true, target: 'es2020',
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  outfile: out, charset: 'utf8', legalComments: 'none',
  banner: { js: header }, footer: { js: 'window.TS=__TS;' },
  plugins: [{
    name: 'react-globals',
    setup(b) {
      b.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, () => ({ path: 'jsx', namespace: 'ds-shim' }));
      b.onResolve({ filter: /^react(-dom)?$/ }, () => ({ path: 'react', namespace: 'ds-shim' }));
      b.onLoad({ filter: /.*/, namespace: 'ds-shim' }, (a) => ({ contents: a.path === 'jsx' ? JSX_SHIM : REACT_SHIM, loader: 'js' }));
    },
  }],
});
const js = readFileSync(out, 'utf8');
// The page inlines the bundle into <script>: these would end or escape it.
if (/<\/script|<!--/i.test(js)) throw new Error('bundle contains </script or <!--');
console.log(`${relative(process.cwd(), out)}: ${js.length} bytes, ${names.length} components`);
