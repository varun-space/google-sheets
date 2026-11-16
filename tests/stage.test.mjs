import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTask, overdueDays, stageOf } from '../src/data.js';
import { serialNow } from '../src/normalize.js';

const base = { assigned: 'Vansh', a1: '', s1: '', qc: '', a2: '', s2: '' };

test('stage rules', () => {
  assert.equal(stageOf({ ...base, assigned: '' }), 'un');
  assert.equal(stageOf(base), 'working');
  assert.equal(stageOf({ ...base, a1: 46100 }), 'qcwait');
  assert.equal(stageOf({ ...base, s1: 'Done' }), 'qcwait');
  assert.equal(stageOf({ ...base, a1: 46100, qc: 'Yes' }), 'final');
  assert.equal(stageOf({ ...base, a1: 46100, qc: 'Yes', a2: 46101 }), 'done');
  assert.equal(stageOf({ ...base, assigned: '', s2: 'Done' }), 'done'); // old rows: Done without times
});

test('pre-filled QC "Yes" before editing still counts as editing', () => {
  // TSK-391 style row: QC Yes but X/Y blank → must not skip to final.
  assert.equal(stageOf({ ...base, qc: 'Yes' }), 'working');
});

test('overdue days by stage', () => {
  const now = Date.UTC(2026, 10, 14);
  const day = 86400000;
  assert.equal(overdueDays({ stage: 'working', p1: now - 3 * day }, now), 3);
  assert.equal(overdueDays({ stage: 'working', p1: now + day }, now), 0);
  assert.equal(overdueDays({ stage: 'qcwait', a1: now - 2 * day }, now), 1); // 24 h QC allowance
  assert.equal(overdueDays({ stage: 'un', ts: now - day }, now), 1);
  assert.equal(overdueDays({ stage: 'done', p1: 0 }, now), 0);
});

test('buildTask maps a real-looking row', () => {
  const now = Date.now();
  const row = [];
  row[0] = 'TSK-12'; row[1] = serialNow(now - 86400000); row[3] = 'jyoti '; row[4] = '🤝 Client Servicing';
  row[5] = 'Nature mania '; row[6] = '📹 Long Form Video (1-10 min)'; row[17] = '🟠 High (1-2 days)'; row[19] = 'geetanshu';
  const t = buildTask(row, now);
  assert.equal(t.id, 'TSK-012');
  assert.equal(t.requester, 'Jyoti');
  assert.equal(t.project, 'NatureMania');
  assert.equal(t.type, 'Long Form Video (1-10 min)');
  assert.equal(t.priority, 1);
  assert.equal(t.person, 'Geetanshu');
  assert.equal(t.stage, 'working');
  assert.ok(t.details); // open task carries details
  assert.equal(buildTask(['Click'], now), null);
});
