import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoLayout, CUE_CLEARANCE_CM, footprint, layoutIssues, mergeLayout, validateLayout } from '../src/index.ts';
import type { HallLayout, TableKind } from '../src/index.ts';

const tables: Array<{ id: string; kind: TableKind }> = [
  { id: 't1', kind: 'pool' },
  { id: 't2', kind: 'pool' },
  { id: 't3', kind: 'pool' },
  { id: 't4', kind: 'russian' },
  { id: 't5', kind: 'russian' },
  { id: 't6', kind: 'snooker' },
];
const kinds = new Map(tables.map((t) => [t.id, t.kind]));

test('auto layout leaves room for a cue everywhere', () => {
  const layout = autoLayout(tables);
  assert.equal(layout.tables.length, 6);
  assert.deepEqual(layoutIssues(layout, kinds), []);
  assert.deepEqual(validateLayout(layout, new Set(kinds.keys())), []);
});

test('footprint swaps sides when a table is turned', () => {
  assert.deepEqual(footprint('russian', 0), { w: 400, h: 220 });
  assert.deepEqual(footprint('russian', 90), { w: 220, h: 400 });
});

test('issues: overlap, too close for a cue, against a wall, outside', () => {
  const base: HallLayout = { width: 1500, height: 1000, tables: [], landmarks: [] };
  const overlap = layoutIssues(
    { ...base, tables: [{ tableId: 't1', x: 400, y: 400, rotation: 0 }, { tableId: 't2', x: 450, y: 420, rotation: 0 }] },
    kinds,
  );
  assert.ok(overlap.some((i) => i.type === 'overlap' && i.tableId === 't1' && i.withId === 't2'));

  const tight = layoutIssues(
    { ...base, tables: [{ tableId: 't1', x: 400, y: 400, rotation: 0 }, { tableId: 't2', x: 400 + 285 + 90, y: 400, rotation: 0 }] },
    kinds,
  );
  assert.deepEqual(
    tight.filter((i) => i.type === 'tight').map((i) => (i.type === 'tight' ? i.gapCm : 0)),
    [90, 90],
  );

  const wall = layoutIssues({ ...base, tables: [{ tableId: 't1', x: 200, y: 500, rotation: 0 }] }, kinds);
  assert.deepEqual(wall, [{ type: 'wall', tableId: 't1', gapCm: Math.round(200 - 285 / 2) }]);

  const outside = layoutIssues({ ...base, tables: [{ tableId: 't1', x: 50, y: 500, rotation: 0 }] }, kinds);
  assert.equal(outside[0]?.type, 'outside');

  const onBar = layoutIssues(
    {
      ...base,
      tables: [{ tableId: 't1', x: 700, y: 500, rotation: 0 }],
      landmarks: [{ id: 'b', kind: 'bar', x: 700, y: 500, w: 400, h: 120 }],
    },
    kinds,
  );
  assert.ok(onBar.some((i) => i.type === 'overlap' && i.withId === 'b'));
});

test('merge keeps a saved plan, drops removed tables and finds room for new ones', () => {
  const saved: HallLayout = {
    width: 1500,
    height: 1000,
    tables: [
      { tableId: 't1', x: 400, y: 300, rotation: 90 },
      { tableId: 'gone', x: 900, y: 300, rotation: 0 },
    ],
    landmarks: [{ id: 'bar', kind: 'bar', x: 1200, y: 100, w: 400, h: 120 }],
  };
  const merged = mergeLayout(saved, [tables[0]!, tables[3]!]);
  assert.deepEqual(merged.tables[0], saved.tables[0]);
  assert.equal(merged.tables.length, 2);
  assert.equal(merged.tables[1]?.tableId, 't4');
  assert.equal(merged.landmarks.length, 1);
  const issues = layoutIssues(merged, kinds).filter((i) => i.tableId === 't4');
  assert.deepEqual(issues, []);
  assert.ok(CUE_CLEARANCE_CM > 0);
});

test('validateLayout rejects broken plans', () => {
  const ids = new Set(['t1', 't2']);
  assert.deepEqual(validateLayout(null, ids), ['layout must be an object']);
  assert.equal(validateLayout({ width: 100, height: 1000, tables: [], landmarks: [] }, ids).length, 1);
  const errors = validateLayout(
    {
      width: 1000,
      height: 800,
      tables: [
        { tableId: 't1', x: 2000, y: 100, rotation: 45 },
        { tableId: 'x', x: 100, y: 100, rotation: 0 },
      ],
      landmarks: [{ id: 'a', kind: 'pool', x: 10, y: 10, w: 10, h: 10 }],
    },
    ids,
  );
  assert.deepEqual(errors, [
    'tables[0]: position outside the hall',
    'tables[0]: rotation must be 0 or 90',
    'tables[1]: unknown table',
    'table t2 is not placed',
    'landmarks[0]: unknown kind',
    'landmarks[0]: size must be 30..10000 cm',
  ]);
});
