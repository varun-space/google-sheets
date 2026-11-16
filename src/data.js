// Reads the FMS tab once, turns each row into a task object, and caches the result for 120 s.
// Role filtering happens here so a doer's browser never receives other people's rows.

import { readRange } from './sheets.js';
import { clean, dept, idNum, padId, person, priority, project, toMs } from './normalize.js';

// Easy-to-edit config (CLAUDE.md §8).
export const OWNERS = { coordinator: 'Video Coordinator', qc: 'Princy (QC)' };
export const TARGETS = { s1OnTime: 85, qc: 95, tatHours: 24, overdue: 0, qcWaitHours: 24, staleDays: 2 };

const CACHE_MS = 120 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// FMS column indexes (0-based), see CLAUDE.md §4.
export const COL = {
  id: 0, ts: 1, requester: 3, dept: 4, project: 5, type: 6, platform: 7, duration: 8, raw: 9, script: 10,
  captions: 11, music: 12, ref: 13, brief: 14, format: 15, deadline: 16, priority: 17, revisions: 18,
  assigned: 19, assignedAt: 21, p1: 22, a1: 23, s1: 24, qc: 26, p2: 27, a2: 28, s2: 29, editor: 33, file: 34,
};

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const is = (v, word) => String(v ?? '').trim().toLowerCase() === word;

/**
 * Stage rules (CLAUDE.md §4). Takes the raw cells so actions.js can use the exact same logic.
 * done → un → working → qcwait → final
 */
export function stageOf({ assigned, a1, s1, qc, a2, s2 }) {
  if (has(a2) || is(s2, 'done')) return 'done';
  if (!has(assigned)) return 'un';
  if (!has(a1) && !is(s1, 'done')) return 'working';
  if (!is(qc, 'yes')) return 'qcwait';
  return 'final';
}

export function cellsOf(row) {
  const c = (i) => row[i] ?? '';
  return { assigned: c(COL.assigned), a1: c(COL.a1), s1: c(COL.s1), qc: c(COL.qc), a2: c(COL.a2), s2: c(COL.s2) };
}

/** Days past due for open tasks; 0 for done. */
export function overdueDays(t, now, targets = TARGETS) {
  let due = null;
  if (t.stage === 'working') due = t.p1;
  else if (t.stage === 'qcwait') due = t.a1 != null ? t.a1 + targets.qcWaitHours * HOUR : null;
  else if (t.stage === 'final') due = t.p2 ?? t.a1;
  else if (t.stage === 'un') due = t.ts;
  return due == null ? 0 : Math.max(0, (now - due) / DAY);
}

export function buildTask(row, now) {
  const num = idNum(row[COL.id]);
  if (num == null) return null;
  const c = (i) => row[i] ?? '';
  const stage = stageOf(cellsOf(row));
  const t = {
    num,
    id: padId(num),
    ts: toMs(c(COL.ts)),
    requester: person(c(COL.requester)),
    dept: dept(c(COL.dept)),
    project: project(c(COL.project)),
    type: clean(c(COL.type)) || '(Not specified)',
    priority: priority(c(COL.priority)),
    person: person(c(COL.assigned)),
    p1: toMs(c(COL.p1)),
    a1: toMs(c(COL.a1)),
    p2: toMs(c(COL.p2)),
    a2: toMs(c(COL.a2)),
    qc: is(c(COL.qc), 'yes'),
    s1Done: is(c(COL.s1), 'done'),
    s2Done: is(c(COL.s2), 'done'),
    stage,
    briefBlank: !has(c(COL.brief)),
  };
  t.odDays = Math.round(overdueDays(t, now) * 10) / 10;
  t.tat = t.a2 != null && t.ts != null ? Math.round(((t.a2 - t.ts) / HOUR) * 10) / 10 : null;

  // Full details only for open tasks — the queue needs them, history doesn't, and it keeps the payload small.
  if (stage !== 'done') {
    const s = (i) => String(c(i)).trim();
    t.details = {
      platform: s(COL.platform), duration: s(COL.duration), raw: s(COL.raw), script: s(COL.script),
      captions: s(COL.captions), music: s(COL.music), ref: s(COL.ref), brief: s(COL.brief), format: s(COL.format),
      deadline: toMs(c(COL.deadline)), revisions: s(COL.revisions), file: s(COL.file),
    };
  }
  return t;
}

let cache = { at: 0, data: null };

export function clearCache() {
  cache = { at: 0, data: null };
}

/** All tasks (unfiltered) + editor list. Cached in memory for 120 s per Worker isolate. */
export async function getAll(env, { refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && cache.data && now - cache.at < CACHE_MS) return cache.data;

  const rows = await readRange(env, "'Video Tracker-FMS'!A9:AI");
  const tasks = rows.map((r) => buildTask(r, now)).filter(Boolean);
  const editors = [...new Set(tasks.map((t) => t.person).filter(Boolean))].sort();
  const lastRequestAt = tasks.reduce((m, t) => (t.ts && t.ts > m ? t.ts : m), 0) || null;

  cache = { at: now, data: { tasks, editors, lastRequestAt, readAt: now } };
  return cache.data;
}

/** Server-side filter: only rows assigned to this person. */
export const tasksFor = (tasks, name) => tasks.filter((t) => t.person === name);
