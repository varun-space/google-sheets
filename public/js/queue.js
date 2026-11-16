// Work queue: open tasks with the next action for each one. The server has already filtered rows by role.
// Row buttons/details come from tasks-ui.js (shared with the dashboard).

(function () {
  const { t, esc, api, toast, fmtDate, fmtDateTime } = SW;
  const $ = (id) => document.getElementById(id);

  const STAGES = ['un', 'working', 'qcwait', 'final'];

  const state = {
    me: null,
    data: null,
    allEditors: [],
    stage: 'all',
    search: '',
    viewAs: new URLSearchParams(location.search).get('as') || '',
  };

  const isAdmin = () => state.me?.role === 'admin';
  // In "view as" mode the admin sees the doer's layout (but keeps admin buttons).
  const adminLayout = () => isAdmin() && !state.viewAs;

  const ui = SW.taskUI.create({
    me: () => state.me,
    tasks: () => state.data?.tasks || [],
    editors: () => (isAdmin() ? state.allEditors : [state.me.name]),
    reload: () => load(true),
  });

  // ---------- data ----------
  async function load(refresh = false) {
    $('errorBox').classList.add('hidden');
    const qs = new URLSearchParams();
    if (refresh) qs.set('refresh', '1');
    if (state.viewAs) qs.set('as', state.viewAs);
    try {
      const res = await api('/api/data?' + qs);
      if (!res.ok) throw new Error(res.msg);
      state.data = res;
      if (isAdmin() && !state.viewAs) state.allEditors = res.editors;
      render();
      SW.renderFooter(res.readAt);
    } catch (err) {
      $('errorBox').textContent = '⚠️ ' + err.message;
      $('errorBox').classList.remove('hidden');
      if (!state.data) $('tableCard').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  const openTasks = () => state.data.tasks.filter((x) => x.stage !== 'done');

  function visibleTasks() {
    const q = state.search.trim().toLowerCase();
    return openTasks()
      .filter((x) => state.stage === 'all' || x.stage === state.stage)
      .filter((x) => !q || [x.id, x.project, x.requester, x.type, x.person, x.dept].join(' ').toLowerCase().includes(q))
      .sort((a, b) => a.priority - b.priority || b.odDays - a.odDays || (a.ts || 0) - (b.ts || 0));
  }

  // ---------- render ----------
  function render() {
    renderStatic();
    renderPills();
    renderTable();
  }

  function renderStatic() {
    document.title = `${t('queue')} · Video Ops`;
    $('title').textContent = t('queue');
    $('refreshBtn').textContent = t('refresh');
    $('newBtn').textContent = t('newRequest');
    $('search').placeholder = t('search');
    $('subtitle').textContent = `${openTasks().length} ${t('openTasks')}`;

    $('newBtn').classList.toggle('hidden', !isAdmin());
    $('viewAsWrap').classList.toggle('hidden', !isAdmin());
    if (isAdmin()) {
      $('viewAsLabel').textContent = t('viewAs');
      $('viewAs').innerHTML = `<option value="">${esc(t('everyone'))}</option>` +
        state.allEditors.map((n) => `<option value="${esc(n)}" ${n === state.viewAs ? 'selected' : ''}>${esc(n)}</option>`).join('');
    }
    $('viewAsBar').classList.toggle('hidden', !state.viewAs);
    $('viewAsText').textContent = '👁 ' + t('viewingAs', { name: state.viewAs });
    $('backBtn').textContent = t('backToEveryone');
  }

  function renderPills() {
    const open = openTasks();
    const count = (s) => (s === 'all' ? open.length : open.filter((x) => x.stage === s).length);
    const list = ['all', ...STAGES.filter((s) => s !== 'un' || adminLayout())];
    if (!list.includes(state.stage)) state.stage = 'all';
    $('pills').innerHTML = list.map((s) =>
      `<button class="pill ${state.stage === s ? 'active' : ''}" data-stage="${s}">${esc(s === 'all' ? t('allOpen') : t(s))}<span class="count">${count(s)}</span></button>`
    ).join('');
  }

  function renderTable() {
    const rows = visibleTasks();
    const showAssigned = adminLayout();
    if (!rows.length) {
      $('tableCard').innerHTML = `<div class="empty">${esc(t('nothing'))}</div>`;
      return;
    }
    const cols = showAssigned ? 10 : 9;
    const head = ['id', 'requested', 'requester', 'project', 'type', 'priority', ...(showAssigned ? ['assigned'] : []), 'stage', 'late']
      .map((k) => `<th>${esc(t(k))}</th>`).join('') + `<th class="r">${esc(t('action'))}</th>`;
    const body = rows.map((x) => rowHtml(x, showAssigned) + ui.detailsHtml(x, cols)).join('');
    $('tableCard').innerHTML = `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function rowHtml(x, showAssigned) {
    const cell = (label, html) => `<td data-label="${esc(t(label))}">${html}</td>`;
    return `<tr class="task ${ui.isOpen(x.num) ? 'open' : ''}" data-num="${x.num}">
      <td class="id-cell">${ui.idCell(x)}</td>
      ${cell('requested', `<span title="${esc(fmtDateTime(x.ts))}">${esc(fmtDate(x.ts))}</span>`)}
      ${cell('requester', esc(x.requester || '—'))}
      ${cell('project', `<b>${esc(x.project)}</b><div class="sub">${esc(x.dept)}</div>`)}
      ${cell('type', esc(x.type))}
      ${cell('priority', SW.prioHtml(x.priority))}
      ${showAssigned ? cell('assigned', x.person ? esc(x.person) : '<span class="muted">—</span>') : ''}
      ${cell('stage', SW.stageHtml(x.stage))}
      ${cell('late', SW.lateHtml(x.odDays))}
      <td class="act-cell"><div class="actions">${ui.actionsHtml(x)}</div></td>
    </tr>`;
  }

  ui.bind($('tableCard'), renderTable);

  // ---------- new request modal ----------
  function openNewRequest() {
    const o = state.data.options || {};
    const sel = (key, label) => `<div><label for="nr_${key}">${esc(t(label))}</label><select id="nr_${key}" name="${key}">
      <option value="">${esc(t('select'))}</option>${(o[key] || []).map((v) => `<option>${esc(v)}</option>`).join('')}</select></div>`;
    const inp = (key, label, attrs = '', req = false, full = false) =>
      `<div class="${full ? 'full' : ''}"><label for="nr_${key}" class="${req ? 'req' : ''}">${esc(t(label))}</label><input id="nr_${key}" name="${key}" ${attrs} ${req ? 'required' : ''}></div>`;
    $('newTitle').textContent = t('newRequest').replace('＋ ', '');
    $('newSubmit').textContent = t('create');
    $('newCancel').textContent = t('cancel');
    $('newBody').innerHTML =
      inp('name', 'name', 'maxlength="80"', true) + inp('project', 'project', 'maxlength="120"', true) +
      sel('dept', 'dept') + sel('type', 'type') + sel('platform', 'platform') + sel('duration', 'duration') +
      sel('priority', 'priority') + sel('format', 'format') +
      inp('deadline', 'deadline', 'type="date"') + inp('revisions', 'revisions', 'maxlength="50"') +
      inp('raw', 'raw', 'type="url" placeholder="https://"') + inp('ref', 'ref', 'type="url" placeholder="https://"') +
      inp('script', 'script', 'maxlength="500"') + inp('captions', 'captions', 'maxlength="200"') +
      inp('music', 'music', 'maxlength="200"', false, true) +
      `<div class="full"><label for="nr_brief">${esc(t('brief'))}</label><textarea id="nr_brief" name="brief" maxlength="2000"></textarea></div>`;
    $('newDlg').showModal();
    $('nr_name').focus();
  }

  $('newForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData($('newForm')).entries());
    for (const k of ['raw', 'ref']) if (body[k] && !/^https:\/\//.test(body[k])) return toast('Links must start with https://', 'err');
    $('newSubmit').disabled = true;
    try {
      const res = await api('/api/action', { body: { action: 'newRequest', ...body } });
      toast(res.msg, res.ok ? 'ok' : 'err');
      if (res.ok) { $('newDlg').close(); await load(true); }
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      $('newSubmit').disabled = false;
    }
  });
  document.querySelectorAll('#newDlg [data-close]').forEach((b) => (b.onclick = () => $('newDlg').close()));

  // ---------- toolbar ----------
  $('pills').addEventListener('click', (e) => {
    const p = e.target.closest('[data-stage]');
    if (!p) return;
    state.stage = p.dataset.stage;
    renderPills();
    renderTable();
  });
  $('search').addEventListener('input', (e) => { state.search = e.target.value; renderTable(); });
  $('refreshBtn').onclick = () => load(true);
  $('newBtn').onclick = openNewRequest;

  function setViewAs(name) {
    state.viewAs = name;
    ui.clear();
    const url = new URL(location.href);
    name ? url.searchParams.set('as', name) : url.searchParams.delete('as');
    history.replaceState(null, '', url);
    load();
  }
  $('viewAs').onchange = (e) => setViewAs(e.target.value);
  $('backBtn').onclick = () => setViewAs('');

  // ---------- start ----------
  (async function start() {
    state.me = await SW.initPage('queue', () => state.data && render());
    if (!isAdmin()) state.viewAs = '';
    // Admin opening a view-as link directly still needs the full editor list for the dropdowns.
    if (isAdmin() && state.viewAs) state.allEditors = (await api('/api/editors')).editors || [];
    await load();
  })();
})();
