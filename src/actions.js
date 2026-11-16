// Workflow actions (CLAUDE.md §6). Every action re-reads the row from the sheet first and re-checks
// role, ownership and stage on the server — the buttons in the browser are only a convenience.
// Only the manual columns X, Y, AA, AC, AD of the FMS tab are ever written; everything else is formula.

import { appendRows, batchUpdate, getMeta, readRange, writeRange, writeRanges } from './sheets.js';
import { cellsOf, COL, stageOf } from './data.js';
import { idNum, isoDateToSerial, istDateTimeText, padId, person, safeText, serialNow } from './normalize.js';

const FMS = "'Video Tracker-FMS'";
const COORD = "'Coordinator Assign Task'";
const FR2 = "'Form responses 2'";
const FR3 = "'Form responses 3'";
const LOG = 'Action_Log';

// Exact dropdown values the Google Form writes (CLAUDE.md §8). Served to the New request modal too.
export const OPTIONS = {
  dept: ['📣 Marketing', '🎨 Creative', '🤝 Client Servicing', '👔 Management', '💻 Tech / Development', '💰 Sales', '👥 HR'],
  type: ['🎬 Reel / Short Form (under 60 sec)', '📹 Long Form Video (1-10 min)', '🎥 YouTube Video (10 min+)',
    '📢 Ad Creative (Meta / Google)', '📷 Shoot', '🎤 Talking Head / Interview', '🎞️ Product Demo / Explainer'],
  platform: ['▶️ YouTube', '📸 Instagram Reel', '🎯 Meta Ad (FB/IG)', '🌐 Website Embed', '💼 LinkedIn',
    '📲 WhatsApp / Internal Use', '🎤 Event / Presentation'],
  duration: ['⚡ Under 30 sec', '🎬 30–60 sec', '📹 1–3 min', '🎥 3–10 min', '📽️ 10 min+', '🤷 Editor decide kare'],
  priority: ['🔴 Urgent (Today)', '🟠 High (1-2 days)', '🟡 Normal (3-5 days)', '🟢 Low (this week)'],
  format: ['📱 Vertical 9:16 (Reels/Stories)', '🖥️ Horizontal 16:9 (YouTube/Website)', '⬜ Square 1:1'],
};

const fail = (msg) => ({ ok: false, msg });
const isLink = (v) => /^https:\/\/\S+$/.test(String(v ?? '').trim());
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const is = (v, word) => String(v ?? '').trim().toLowerCase() === word;

/** Finds the FMS row for a task number and returns its fresh cells. */
async function loadTask(env, num) {
  const ids = await readRange(env, `${FMS}!A9:A`);
  const idx = ids.findIndex((r) => idNum(r[0]) === num);
  if (idx < 0) return null;
  const rowNum = 9 + idx;
  const [row = []] = await readRange(env, `${FMS}!A${rowNum}:AI${rowNum}`);
  const cells = cellsOf(row);
  return { rowNum, row, cells, stage: stageOf(cells), owner: person(cells.assigned), editingDone: has(cells.a1) || is(cells.s1, 'done') };
}

const ownsOrAdmin = (session, task) => session.role === 'admin' || task.owner === session.name;

// --- individual actions. Each returns {ok, msg, details?} ---

async function assign(env, session, num, task, body) {
  if (session.role !== 'admin') return fail('Only admin can assign tasks.');
  if (task.stage === 'done') return fail(`${padId(num)} is already done.`);
  const editor = person(safeText(body.editor, 60));
  if (!editor) return fail('Pick an editor to assign.');

  // FMS looks up the FIRST Coordinator row for the Task-ID, so re-assigning must edit that row.
  const rows = await readRange(env, `${COORD}!A2:D`);
  const idx = rows.findIndex((r) => idNum(r[2]) === num);
  if (idx >= 0) {
    await writeRange(env, `${COORD}!D${idx + 2}`, [[editor]]);
  } else {
    let last = rows.length - 1;
    while (last >= 0 && !rows[last].some(has)) last--;
    const r = last + 3; // rows[] starts at sheet row 2
    const { date, time } = istDateTimeText();
    await writeRange(env, `${COORD}!A${r}:F${r}`, [[serialNow(), '', padId(num), editor, date, time]]);
  }
  const verb = task.owner ? `re-assigned from ${task.owner} to` : 'assigned to';
  return { ok: true, msg: `${padId(num)}: ${verb} ${editor}.`, details: editor };
}

async function editDone(env, session, num, task) {
  if (!ownsOrAdmin(session, task)) return fail('This task is not assigned to you.');
  if (task.stage === 'un') return fail(`${padId(num)} is not assigned yet.`);
  if (task.editingDone) return fail(`${padId(num)}: editing is already marked done.`);
  const data = [{ range: `${FMS}!X${task.rowNum}:Y${task.rowNum}`, values: [[serialNow(), 'Done']] }];
  // Old rows can carry a pre-filled QC "Yes" — clear it so the task still goes through QC.
  if (is(task.cells.qc, 'yes')) data.push({ range: `${FMS}!AA${task.rowNum}`, values: [['']] });
  await writeRanges(env, data);
  return { ok: true, msg: `${padId(num)}: editing marked done — sent to QC.` };
}

async function qcPass(env, session, num, task) {
  if (session.role !== 'admin') return fail('Only admin can pass QC.');
  if (task.stage === 'done') return fail(`${padId(num)} is already done.`);
  if (!task.editingDone) return fail(`${padId(num)}: editing is not done yet.`);
  if (is(task.cells.qc, 'yes')) return fail(`${padId(num)}: QC already passed.`);
  await writeRange(env, `${FMS}!AA${task.rowNum}`, [['Yes']]);
  return { ok: true, msg: `${padId(num)}: QC passed — ready for final output.` };
}

async function qcReject(env, session, num, task, body) {
  if (session.role !== 'admin') return fail('Only admin can send a task back.');
  if (task.stage === 'done') return fail(`${padId(num)} is already done.`);
  if (!task.editingDone) return fail(`${padId(num)}: editing is not done yet.`);
  await writeRanges(env, [
    { range: `${FMS}!X${task.rowNum}:Y${task.rowNum}`, values: [['', '']] },
    { range: `${FMS}!AA${task.rowNum}`, values: [['']] },
  ]);
  return { ok: true, msg: `${padId(num)}: sent back to ${task.owner || 'the editor'} for changes.`, details: safeText(body.reason, 300) };
}

async function finalDone(env, session, num, task, body) {
  if (!ownsOrAdmin(session, task)) return fail('This task is not assigned to you.');
  if (task.stage === 'done') return fail(`${padId(num)} is already done.`);
  if (!task.editingDone) return fail(`${padId(num)}: editing is not done yet.`);
  if (!is(task.cells.qc, 'yes')) return fail(`${padId(num)}: waiting for QC — final output can't be marked yet.`);
  const link = String(body.link ?? '').trim();
  if (link && !isLink(link)) return fail('File link must start with https://');
  if (link) await appendRows(env, `${FR3}!A:C`, [[serialNow(), padId(num), link]]);
  await writeRange(env, `${FMS}!AC${task.rowNum}:AD${task.rowNum}`, [[serialNow(), 'Done']]);
  return { ok: true, msg: `${padId(num)}: final output done. 🎉`, details: link };
}

async function addLink(env, session, num, task, body) {
  if (!ownsOrAdmin(session, task)) return fail('This task is not assigned to you.');
  const link = String(body.link ?? '').trim();
  if (!isLink(link)) return fail('File link must start with https://');
  await appendRows(env, `${FR3}!A:C`, [[serialNow(), padId(num), link]]);
  return { ok: true, msg: `${padId(num)}: file link saved.`, details: link };
}

async function newRequest(env, session, body) {
  if (session.role !== 'admin') return fail('Only admin can add requests.');
  const name = safeText(body.name, 80);
  const proj = safeText(body.project, 120);
  if (!name || !proj) return fail('Name and project are required.');
  for (const key of Object.keys(OPTIONS)) {
    if (body[key] && !OPTIONS[key].includes(body[key])) return fail(`Invalid ${key} value.`);
  }
  const deadline = body.deadline ? isoDateToSerial(body.deadline) : '';
  if (deadline === null) return fail('Deadline must be a date.');
  for (const k of ['raw', 'ref']) if (body[k] && !isLink(body[k])) return fail('Links must start with https://');

  // Next free row after the last filled A cell (data starts at row 8). Task ID comes from the sheet's formula: row − 7.
  const colA = await readRange(env, `${FR2}!A8:A`);
  let last = colA.length - 1;
  while (last >= 0 && !has(colA[last][0])) last--;
  const r = 8 + last + 1;
  const t = (k, max) => safeText(body[k], max);
  await writeRange(env, `${FR2}!A${r}:R${r}`, [[
    serialNow(), name, body.dept || '', proj, body.type || '', body.platform || '', body.duration || '',
    t('raw', 500), t('script', 500), t('captions', 200), t('music', 200), t('ref', 500), t('brief', 2000),
    body.format || '', deadline, body.priority || '', t('revisions', 50), '',
  ]]);
  const id = padId(r - 7);
  return { ok: true, msg: `New request created: ${id}.`, id, details: `${name} · ${proj}` };
}

const TASK_ACTIONS = { assign, editDone, qcPass, qcReject, finalDone, addLink };

/** Entry point for POST /api/action. Logs every successful action to the Action_Log tab. */
export async function runAction(env, session, body) {
  const action = String(body?.action ?? '');
  let result;
  let taskId = '';

  if (action === 'newRequest') {
    result = await newRequest(env, session, body);
    taskId = result.id || '';
  } else if (TASK_ACTIONS[action]) {
    const num = Number(body.num);
    if (!Number.isInteger(num) || num <= 0) return fail('Missing task number.');
    taskId = padId(num);
    const task = await loadTask(env, num);
    if (!task) return fail(`${taskId} was not found in the sheet.`);
    result = await TASK_ACTIONS[action](env, session, num, task, body);
  } else {
    return fail(`Unknown action: ${action}`);
  }

  if (result.ok) {
    // A logging hiccup must not turn a successful sheet write into an error for the user.
    try {
      await logAction(env, session, action, taskId, result.details || '', result.msg);
    } catch (err) {
      result.msg += ' (Note: could not write Action_Log — ' + err.message + ')';
    }
  }
  delete result.details;
  return result;
}

let logReady = false;

async function logAction(env, session, action, taskId, details, msg) {
  if (!logReady) {
    const meta = await getMeta(env);
    if (!meta.sheets.some((s) => s.properties.title === LOG)) {
      await batchUpdate(env, [{ addSheet: { properties: { title: LOG } } }]);
      await writeRange(env, `${LOG}!A1:G1`, [['Time', 'Who', 'Role', 'Action', 'Task', 'Details', 'Result']]);
    }
    logReady = true;
  }
  await appendRows(env, `${LOG}!A:G`, [[serialNow(), session.name, session.role, action, taskId, details, msg]]);
}
