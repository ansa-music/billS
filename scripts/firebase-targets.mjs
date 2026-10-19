// Fills the Hosting targets of .firebaserc from its one line "default": "<project>".
//
//   cabinet → site <project>        (owner's cabinet, apps/cloud-web)    https://<project>.web.app
//   demo    → site <project>-demo   (public demo of the club screen)     https://<project>-demo.web.app
//
// Rename the project by editing only "default" in .firebaserc; CI runs this script before
// deploying (and so can you: `node scripts/firebase-targets.mjs`). Site names that differ
// (taken globally, chosen by hand) come from FIREBASE_CABINET_SITE / FIREBASE_DEMO_SITE.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../.firebaserc', import.meta.url));
const rc = JSON.parse(readFileSync(file, 'utf8'));
const project = process.env.FIREBASE_PROJECT?.trim() || rc.projects?.default;
if (!project) throw new Error('.firebaserc: нет projects.default');

const cabinet = process.env.FIREBASE_CABINET_SITE?.trim() || project;
const demo = process.env.FIREBASE_DEMO_SITE?.trim() || `${project}-demo`;
rc.projects = { ...rc.projects, default: project };
rc.targets = { [project]: { hosting: { cabinet: [cabinet], demo: [demo] } } };
writeFileSync(file, `${JSON.stringify(rc, null, 2)}\n`);
console.log(`Firebase project ${project}: cabinet → https://${cabinet}.web.app, demo → https://${demo}.web.app`);
