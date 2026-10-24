import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OnboardingClub } from '../src/onboarding.ts';
import { currentStep, doneCount, parseOnboarding, pickClub, stepsDone } from '../src/onboarding.ts';

const fresh: OnboardingClub = {
  clubId: 'c1',
  name: 'Coffee Point',
  businessType: 'cafe',
  hubConnected: false,
  lastSeenAt: null,
  staff: 1,
  tariffs: 0,
  shifts: 0,
};
const noMarks = { installed: false, loggedIn: false };

test('a fresh signup: only «Заведение создано» is done, the next step is install', () => {
  const d = stepsDone(fresh, noMarks);
  assert.equal(doneCount(d), 1);
  assert.equal(currentStep(d), 'install');
});

test('«Уже стоит» moves on to connecting the register', () => {
  assert.equal(currentStep(stepsDone(fresh, { installed: true, loggedIn: false })), 'connect');
});

test('a connected register finishes install, connect and (cafe) the menu step', () => {
  const d = stepsDone({ ...fresh, hubConnected: true }, noMarks);
  assert.equal(d.install, true);
  assert.equal(d.connect, true);
  assert.equal(d.menu, true);
  assert.equal(currentStep(d), 'login');
});

test('billiards needs a tariff; staff needs more than the manager; a shift finishes all', () => {
  const club = { ...fresh, businessType: 'billiards' as const, hubConnected: true };
  assert.equal(stepsDone(club, noMarks).menu, false);
  assert.equal(stepsDone({ ...club, tariffs: 2 }, noMarks).menu, true);
  assert.equal(stepsDone({ ...club, staff: 2 }, noMarks).staff, true);
  const all = stepsDone({ ...club, tariffs: 1, staff: 3, shifts: 1 }, noMarks);
  assert.equal(all.login, true, 'a shift means someone signed in');
  assert.equal(currentStep(all), null);
  assert.equal(doneCount(all), 7);
});

test('an unknown venue type is treated as billiards for the menu step', () => {
  assert.equal(stepsDone({ ...fresh, businessType: null, hubConnected: true }, noMarks).menu, false);
});

test('the route answer is parsed tolerantly', () => {
  const clubs = parseOnboarding({
    clubs: [
      { clubId: 'a', name: 'A', businessType: 'cafe', hubConnected: false, lastSeenAt: 123, staff: 2, tariffs: 0, shifts: 1 },
      { id: 'b', name: 'B', businessType: 'pizza', staff: -1 },
      { name: 'no id' },
      null,
    ],
  });
  assert.ok(clubs);
  assert.equal(clubs.length, 2);
  assert.equal(clubs[0]?.hubConnected, true, 'lastSeenAt means it connected');
  assert.equal(clubs[1]?.businessType, null);
  assert.equal(clubs[1]?.staff, 0);
  assert.equal(parseOnboarding({}), null);
  assert.equal(parseOnboarding(null), null);
});

test('the checklist is about the first venue with steps left', () => {
  const done = { ...fresh, clubId: 'done', hubConnected: true, staff: 2, shifts: 1 };
  const todo = { ...fresh, clubId: 'todo' };
  assert.equal(pickClub([done, todo], () => noMarks)?.clubId, 'todo');
  assert.equal(pickClub([done], () => noMarks)?.clubId, 'done');
  assert.equal(pickClub([done, todo], () => noMarks, 'done')?.clubId, 'done');
  assert.equal(pickClub([], () => noMarks), null);
});
