import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const KPI = createRequire(import.meta.url)('../public/js/kpi.js');

const H = 3600e3, D = 24 * H;
const T = { s1OnTime: 85, qc: 95, tatHours: 24, overdue: 0, qcWaitHours: 24, staleDays: 2 };
const O = { coordinator: 'Coord', qc: 'QC' };
const L = (en) => en;

test('periods use IST calendar boundaries', () => {
  const now = Date.UTC(2026, 10, 14, 6, 0); // Sat 14 Nov 2026, 11:30 IST
  const tm = KPI.periodRange('thisMonth', now);
  assert.equal(tm.start, Date.UTC(2026, 10, 1) - 5.5 * H);
  assert.equal(tm.end, now);
  const lw = KPI.periodRange('lastWeek', now);
  assert.equal(lw.start, Date.UTC(2026, 10, 2) - 5.5 * H); // Mon 2 Nov
  assert.equal(lw.end - lw.start, 7 * D);
  const lm = KPI.periodRange('lastMonth', now);
  assert.equal(lm.start, Date.UTC(2026, 9, 1) - 5.5 * H);
  const c = KPI.periodRange('custom', now, { from: '2026-11-03', to: '2026-11-04' });
  assert.equal(c.end - c.start, 2 * D);
  const p = KPI.shift(lw, 1);
  assert.equal(p.end, lw.start);
});

test('median and quantile', () => {
  assert.equal(KPI.median([5, 1, 3]), 3);
  assert.equal(KPI.median([1, 2, 3, 4]), 2.5);
  assert.equal(KPI.median([]), null);
  assert.equal(KPI.quantile([0, 10], 0.9), 9);
});

test('metrics: on-time, QC, turnaround', () => {
  const s = 1e12, range = { start: s, end: s + 10 * D };
  const tasks = [
    { ts: s + H, a1: s + 2 * H, p1: s + 3 * H, a2: s + 10 * H, p2: s + 20 * H, qc: true, tat: 9, priority: 0, dept: 'X', type: 'Y' },
    { ts: s + H, a1: s + 5 * H, p1: s + 3 * H, a2: s + 40 * H, p2: s + 20 * H, qc: false, tat: 39, priority: 2, dept: '(Not specified)', type: 'Y' },
    { ts: s - D, a1: null, p1: null, a2: null, qc: false, tat: null, priority: 2, dept: 'X', type: 'Y' }, // outside window
  ];
  const m = KPI.metrics(tasks, range, T);
  assert.equal(m.reqN, 2);
  assert.equal(m.delN, 2);
  assert.equal(m.s1Pct, 50);
  assert.equal(m.qcPct, 50);
  assert.equal(m.tatPct, 50);
  assert.equal(m.medTat, 24);
  assert.equal(m.urgentShare, 50);
  assert.equal(m.blankShare, 50);
  assert.equal(m.s1Late.length, 1);
});

test('pace and health score', () => {
  assert.equal(KPI.pace(85, 85), 1);
  assert.equal(KPI.pace(42.5, 85), 0.5);
  assert.equal(KPI.pace(0, 0, true), 1);
  assert.equal(KPI.pace(5, 0, true), 0.5);
  assert.equal(KPI.pace(null, 85), null);
  assert.equal(KPI.healthScore([1, 1, 1], 0, false), 100);
  assert.equal(KPI.healthScore([0.5, 1.5], 0, false), Math.round(60 * 0.75 + 25 + 15));
  assert.equal(KPI.healthScore([1], 4, true), 60);
  assert.equal(KPI.healthScore([1], 8, false), 75); // critical part floors at 0
});

test('flags: overdue severity, doer sees only own', () => {
  const now = Date.now();
  const od = (person, d) => ({ person, stage: 'working', odDays: d, ts: now - 10 * D });
  const tasks = [od('A', 3), od('A', 4), od('B', 2), od('B', 9), od('B', 5)];
  const m = KPI.metrics(tasks, { start: now - D, end: now }, T);
  const base = { tasks, m, prev: m, people: [], now, lastRequestAt: now, targets: T, owners: O, L };
  const admin = KPI.buildFlags({ ...base, admin: true });
  assert.equal(admin[0].sev, 'MOST CRITICAL');
  const doerTasks = tasks.filter((t) => t.person === 'A');
  const doer = KPI.buildFlags({ ...base, tasks: doerTasks, admin: false, me: 'A' });
  assert.equal(doer.length, 1);
  assert.equal(doer[0].sev, 'CRITICAL');
  assert.ok(!doer.some((f) => f.id === 'unassigned' || f.id === 'stale'));
});

test('flags are sorted most critical first', () => {
  const now = Date.now();
  const people = [{ name: 'A', s1N: 20, s1Pct: 99 }, { name: 'B', s1N: 12, s1Pct: 40 }];
  const tasks = [{ person: 'B', stage: 'working', odDays: 3 }, { person: '', stage: 'un', odDays: 0, ts: now }];
  const m = KPI.metrics(tasks, { start: now - D, end: now }, T);
  const f = KPI.buildFlags({ tasks, m, prev: m, people, now, lastRequestAt: now - 5 * D, admin: true, targets: T, owners: O, L });
  const order = f.map((x) => KPI.SEVERITY.indexOf(x.sev));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(f.some((x) => x.id === 'stale'));
  assert.ok(f.some((x) => x.id === 'star-A'));
});
