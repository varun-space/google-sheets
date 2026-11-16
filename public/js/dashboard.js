// Dashboard page: period filter → KPIs, health ring, flags, Expert Desk, charts, people table, detail table.
// All maths lives in kpi.js; this file only renders. Rows are already filtered by the server for the viewer's role.

(function () {
  const { esc, api, fmtDate, fmtDateTime, fmtNum } = SW;
  const $ = (id) => document.getElementById(id);
  const L = (en, hi) => (SW.lang === 'hi' ? hi : en);
  const r0 = (v) => (v == null ? '—' : Math.round(v));

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const state = {
    me: null,
    data: null,
    allEditors: [],
    period: 'thisMonth',
    custom: { from: '', to: '' },
    tab: 'requested',
    search: '',
    showAll: false,
    viewAs: new URLSearchParams(location.search).get('as') || '',
    charts: [],
    view: null, // computed numbers for the current period
  };

  const isAdmin = () => state.me?.role === 'admin';
  const adminLayout = () => isAdmin() && !state.viewAs;

  const ui = SW.taskUI.create({
    me: () => state.me,
    tasks: () => state.data?.tasks || [],
    editors: () => (isAdmin() ? state.allEditors : [state.me.name]),
    reload: () => load(true),
  });

  const PERIODS = () => [
    ['thisMonth', L('This month so far', 'Is mahine abhi tak')],
    ['lastWeek', L('Last week', 'Pichla hafta')],
    ['lastMonth', L('Last month', 'Pichla mahina')],
    ['last3', L('Last 3 months', 'Pichle 3 mahine')],
    ['custom', L('Custom', 'Custom')],
  ];

  // ---------- load ----------
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
      if (!state.data) $('content').innerHTML = `<div class="card empty">${esc(err.message)}</div>`;
    }
  }

  // ---------- compute ----------
  function compute() {
    const { tasks, targets: T, owners: O, now, lastRequestAt } = state.data;
    const range = KPI.periodRange(state.period, now, state.custom);
    const m = KPI.metrics(tasks, range, T);
    const prev = KPI.metrics(tasks, KPI.shift(range, 1), T);
    const series = [5, 4, 3, 2, 1, 0].map((k) => KPI.metrics(tasks, KPI.shift(range, k), T));
    const people = KPI.byPerson(tasks, range, T);
    const overdue = KPI.overdueList(tasks);
    const flags = KPI.buildFlags({ tasks, m, prev, people, now, lastRequestAt, admin: adminLayout(), me: state.viewAs || state.me.name, targets: T, owners: O, L });
    const expert = adminLayout() ? KPI.buildExpert({ tasks, m, prev, people, targets: T, L }) : [];
    const stale = lastRequestAt ? now - lastRequestAt > T.staleDays * KPI.DAY : true;

    // Month-end pace for Requests (only meaningful for "this month so far").
    let reqPace = null;
    if (state.period === 'thisMonth') {
      const { y, m: mo } = KPI.istYMD(now);
      const monthLen = KPI.istStart(y, mo + 1, 1) - range.start;
      const elapsed = Math.max(now - range.start, KPI.HOUR);
      reqPace = Math.round((m.reqN * monthLen) / elapsed);
    }

    const tiles = [
      { key: 'req', label: L('Requests', 'Requests'), value: m.reqN, prev: prev.reqN, spark: series.map((s) => s.reqN), owner: O.coordinator, tab: 'requested',
        sub: reqPace != null ? L(`→ ~${reqPace} by month-end`, `→ mahine ke end tak ~${reqPace}`) : '' },
      { key: 'del', label: L('Delivered', 'Deliver hue'), value: m.delN, prev: prev.delN, spark: series.map((s) => s.delN), owner: O.coordinator, tab: 'delivered' },
      { key: 's1', label: L('Stage 1 on time', 'Stage 1 time par'), value: m.s1Pct, prev: prev.s1Pct, pctUnit: true, spark: series.map((s) => s.s1Pct), target: T.s1OnTime, owner: O.coordinator, tab: 's1late',
        sub: L(`${m.s1N} edits finished`, `${m.s1N} edit poore`) },
      ...(adminLayout() ? [{ key: 'qc', label: L('QC done', 'QC hua'), value: m.qcPct, prev: prev.qcPct, pctUnit: true, spark: series.map((s) => s.qcPct), target: T.qc, owner: O.qc, tab: 'qcskipped' }] : []),
      { key: 'tat', label: L('Within turnaround', 'Turnaround ke andar'), value: m.tatPct, prev: prev.tatPct, pctUnit: true, spark: series.map((s) => s.tatPct), target: 50, owner: O.coordinator, tab: 'delivered',
        sub: L(`≤ ${T.tatHours}h · median ${r0(m.medTat)}h`, `≤ ${T.tatHours} ghante · median ${r0(m.medTat)}h`) },
      { key: 'od', label: L('Overdue 2+ days', '2+ din late'), value: overdue.length, prev: null, spark: null, target: T.overdue, lowerBetter: true, owner: O.coordinator, tab: 'overdue',
        sub: L('right now', 'abhi') },
    ];
    tiles.forEach((tl) => (tl.pace = KPI.pace(tl.value, tl.target, tl.lowerBetter)));

    // Exactly one highlighted tile: worst pace → "Needs attention"; if all on target, best → "Star metric".
    const withPace = tiles.filter((tl) => tl.pace != null);
    if (withPace.length) {
      const worst = withPace.reduce((a, b) => (b.pace < a.pace ? b : a));
      if (worst.pace < 1) worst.badge = 'attention';
      else withPace.filter((tl) => !tl.lowerBetter).reduce((a, b) => (b.pace > a.pace ? b : a), withPace[0]).badge = 'star';
    }

    const critical = flags.filter((f) => f.sev === 'MOST CRITICAL' || f.sev === 'CRITICAL').length;
    const health = KPI.healthScore(withPace.map((tl) => tl.pace), critical, stale);
    state.view = { range, m, prev, people, overdue, flags, expert, tiles, health, stale };
  }

  // ---------- render ----------
  function render() {
    renderChrome();
    compute();
    const v = state.view;
    $('periodLabel').textContent = `${fmtDate(v.range.start)} – ${fmtDate(v.range.end - 1)} · ${fmtNum(state.data.tasks.length)} ${L('tasks in view', 'tasks')}`;
    $('content').innerHTML = `
      <section class="top-row">
        ${healthHtml(v.health)}
        <div class="kpi-grid">${v.tiles.map(tileHtml).join('')}</div>
      </section>
      <section class="two-col ${adminLayout() ? '' : 'single'}">
        ${flagsHtml(v.flags)}
        ${adminLayout() ? expertHtml(v.expert) : ''}
      </section>
      <section class="chart-grid">
        ${chartCard('cTime', L('Requests over time', 'Samay ke saath requests'))}
        ${adminLayout() ? chartCard('cDel', L('Delivered by person', 'Kisne kitna deliver kiya')) : ''}
        ${adminLayout() ? chartCard('cS1', L('Stage 1 on time % by person', 'Stage 1 time par % — har editor')) : ''}
        ${chartCard('cDept', L('Requests by department (top 8)', 'Department ke hisaab se (top 8)'))}
        ${chartCard('cType', L('Requests by type (top 8)', 'Type ke hisaab se (top 8)'))}
      </section>
      ${adminLayout() ? peopleHtml(v.people) : ''}
      <section class="card detail" id="detail">
        <div class="detail-head">
          <h2>${esc(L('Task list', 'Task list'))}</h2>
          <input type="search" id="dSearch" placeholder="${esc(L('Search ID, project, person…', 'ID, project, naam dhoondo…'))}" value="${esc(state.search)}">
        </div>
        <div class="pills tabs" id="dTabs"></div>
        <div id="dTable"></div>
      </section>`;
    drawCharts();
    renderDetail();
  }

  function renderChrome() {
    document.title = `${L('Dashboard', 'Dashboard')} · Video Ops`;
    $('title').textContent = L('Dashboard', 'Dashboard');
    $('refreshBtn').textContent = SW.t('refresh');
    $('printBtn').textContent = L('🖨 Print', '🖨 Print');
    $('periodPills').innerHTML = PERIODS().map(([k, label]) => `<button class="pill ${state.period === k ? 'active' : ''}" data-period="${k}">${esc(label)}</button>`).join('');
    $('customBox').classList.toggle('hidden', state.period !== 'custom');
    $('cFromLabel').textContent = L('From', 'Kab se');
    $('cToLabel').textContent = L('To', 'Kab tak');
    $('cApply').textContent = L('Apply', 'Lagao');
    $('viewAsWrap').classList.toggle('hidden', !isAdmin());
    if (isAdmin()) {
      $('viewAsLabel').textContent = SW.t('viewAs');
      $('viewAs').innerHTML = `<option value="">${esc(SW.t('everyone'))}</option>` +
        state.allEditors.map((n) => `<option value="${esc(n)}" ${n === state.viewAs ? 'selected' : ''}>${esc(n)}</option>`).join('');
    }
    $('viewAsBar').classList.toggle('hidden', !state.viewAs);
    $('viewAsText').textContent = '👁 ' + SW.t('viewingAs', { name: state.viewAs });
    $('backBtn').textContent = SW.t('backToEveryone');
  }

  function healthHtml(score) {
    const color = score >= 75 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
    const label = score >= 75 ? L('On track', 'Sahi chal raha') : score >= 50 ? L('Needs push', 'Thoda push chahiye') : L('Fire — act today', 'Aag lagi hai — aaj action lo');
    const icon = score >= 75 ? '✓' : score >= 50 ? '!' : '✕';
    const C = 2 * Math.PI * 52;
    return `<div class="card health">
      <div class="k">${esc(L('Health score', 'Health score'))}</div>
      <svg viewBox="0 0 120 120" class="ring" role="img" aria-label="${esc(L('Health score', 'Health score'))} ${score} / 100">
        <circle cx="60" cy="60" r="52" fill="none" stroke="var(--light)" stroke-width="10"/>
        <circle cx="60" cy="60" r="52" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
          stroke-dasharray="${(C * score) / 100} ${C}" transform="rotate(-90 60 60)"/>
        <text x="60" y="58" text-anchor="middle" class="ring-num">${score}</text>
        <text x="60" y="78" text-anchor="middle" class="ring-sub">/ 100</text>
      </svg>
      <div class="chip" style="--c:${color}">${icon} ${esc(label)}</div>
      ${state.view?.stale ? `<div class="sub warn">${esc(L('⚠ No new requests recently', '⚠ Haal me koi nayi request nahi'))}</div>` : ''}
    </div>`;
  }

  function spark(values) {
    const pts = (values || []).map((v, i) => [i, v]).filter(([, v]) => v != null);
    if (pts.length < 2) return '';
    const vals = pts.map(([, v]) => v);
    const min = Math.min(...vals), max = Math.max(...vals);
    const xy = pts.map(([i, v]) => `${(i / 5) * 96 + 2},${26 - ((v - min) / (max - min || 1)) * 22}`).join(' ');
    const [lx, ly] = xy.split(' ').at(-1).split(',');
    return `<svg class="spark" viewBox="0 0 100 28" aria-hidden="true"><polyline points="${xy}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="${lx}" cy="${ly}" r="2.5" fill="currentColor"/></svg>`;
  }

  function tileHtml(tl) {
    const fmt = (v) => (v == null ? '—' : tl.pctUnit ? `${Math.round(v)}%` : fmtNum(v));
    let delta = '';
    if (tl.prev != null && tl.value != null) {
      const d = tl.value - tl.prev;
      const good = tl.lowerBetter ? d < 0 : d > 0;
      const txt = tl.pctUnit ? `${Math.abs(Math.round(d))} pts` : fmtNum(Math.abs(d));
      delta = d === 0 ? `<span class="delta">= ${esc(L('same as before', 'pehle jaisa'))}</span>`
        : `<span class="delta ${good ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${txt} <span class="muted">${esc(L('vs prev', 'pichle se'))}</span></span>`;
    }
    let status = '';
    if (tl.pace != null) {
      const [cls, icon, text] = tl.pace >= 1 ? ['good', '✓', L('On target', 'Target par')] : tl.pace >= 0.85 ? ['warn', '!', L('Close', 'Kareeb')] : ['bad', '✕', L('Behind', 'Peeche')];
      const tgt = tl.lowerBetter ? `${tl.target}` : `${tl.target}%`;
      status = `<div class="progress"><span style="width:${Math.min(tl.pace, 1) * 100}%" class="${cls}"></span></div>
        <div class="tile-foot"><span class="chip ${cls}">${icon} ${esc(text)}</span><span class="muted">${esc(L('Target', 'Target'))} ${esc(tgt)}</span></div>`;
    }
    const badge = tl.badge === 'attention' ? `<div class="badge attention">${esc(L('🔍 Needs attention', '🔍 Dhyan do'))}</div>`
      : tl.badge === 'star' ? `<div class="badge star">${esc(L('🔥 Star metric', '🔥 Star metric'))}</div>` : '';
    return `<button class="tile ${tl.badge || ''}" data-tab="${tl.tab}" title="${esc(L('Show tasks', 'Tasks dikhao'))}">
      ${badge}
      <div class="k">${esc(tl.label)}</div>
      <div class="tile-main"><span class="v num">${fmt(tl.value)}</span>${spark(tl.spark)}</div>
      ${delta}
      ${tl.sub ? `<div class="sub">${esc(tl.sub)}</div>` : ''}
      ${status}
      <div class="owner">${esc(L('Owner', 'Zimmedar'))}: ${esc(tl.owner)}</div>
    </button>`;
  }

  function flagsHtml(flags) {
    const acks = store.get('sw_acks', {});
    const key = (f) => `${f.id}|${state.period}`;
    const sevClass = { 'MOST CRITICAL': 'mc', CRITICAL: 'c', 'RED FLAG': 'rf', WATCH: 'w', POSITIVE: 'p' };
    const items = flags.map((f) => {
      const acked = acks[key(f)];
      return `<li class="flag ${sevClass[f.sev]} ${acked ? 'acked' : ''}">
        <div class="flag-top"><span class="sev">${esc(f.sev)}</span>
          ${acked ? `<span class="muted sm-txt">✓ ${esc(L('Acknowledged', 'Dekh liya'))}</span>` : `<button class="ghost sm" data-ack="${esc(key(f))}">${esc(L('Acknowledge', 'Dekh liya'))}</button>`}</div>
        <div>${esc(f.text)}</div>
        <div class="ask">→ ${esc(L('Ask', 'Poocho'))} <b>${esc(f.owner)}</b>: ${esc(f.q)}</div>
        ${f.tab ? `<button class="linkish" data-tab="${f.tab}">${esc(L('See tasks ↓', 'Tasks dekho ↓'))}</button>` : ''}
      </li>`;
    }).join('');
    return `<div class="card flags"><h2>${esc(L('Flags', 'Flags'))} <span class="count num">${flags.length}</span></h2>
      ${flags.length ? `<ul>${items}</ul>` : `<div class="empty">${esc(L('No flags — all good.', 'Koi flag nahi — sab theek.'))}</div>`}</div>`;
  }

  function expertHtml(items) {
    const label = { suggestion: L('Suggestion', 'Sujhav'), bottleneck: L('Bottleneck', 'Rukawat'), pitfall: L('Pitfall', 'Khatra') };
    const order = ['bottleneck', 'pitfall', 'suggestion'];
    const sorted = [...items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const hl = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<mark>$1</mark>');
    return `<div class="expert">
      <h2>${esc(L('Expert Desk', 'Expert Desk'))}</h2>
      <div class="expert-sub">${esc(L('Creative Operations Head — 25 years running agency production', 'Creative Operations Head — 25 saal agency production ka tajurba'))}</div>
      ${sorted.length ? `<ul>${sorted.map((x) => `<li><span class="kind ${x.kind}">${esc(label[x.kind])}</span><p>${hl(x.text)}</p></li>`).join('')}</ul>`
        : `<p class="expert-sub">${esc(L('No major issues for this period. Keep the rhythm.', 'Is period me koi badi dikkat nahi. Yahi rhythm rakho.'))}</p>`}
    </div>`;
  }

  const chartCard = (id, title) => `<div class="card chart-card"><h3>${esc(title)}</h3><div class="chart-box"><canvas id="${id}" role="img" aria-label="${esc(title)}"></canvas></div></div>`;

  function peopleHtml(people) {
    const T = state.data.targets;
    const cls = (v, good, warn, lower) => (v == null ? '' : lower ? (v <= good ? 'good' : v <= warn ? 'warn' : 'bad') : v >= good ? 'good' : v >= warn ? 'warn' : 'bad');
    const pc = (v) => (v == null ? '—' : `${Math.round(v)}%`);
    const rows = people.filter((p) => p.delivered || p.open || p.s1N).map((p) => `<tr>
      <td data-label="${esc(L('Person', 'Naam'))}"><b>${esc(p.name)}</b></td>
      <td data-label="${esc(L('Delivered', 'Deliver'))}" class="r num">${p.delivered}</td>
      <td data-label="${esc(L('Open now', 'Abhi open'))}" class="r num">${p.open}</td>
      <td data-label="${esc(L('Stage 1 on time', 'Stage 1 time par'))}" class="r num"><span class="cell ${cls(p.s1Pct, T.s1OnTime, 60)}">${pc(p.s1Pct)}</span></td>
      <td data-label="${esc(L('QC stage on time', 'QC stage time par'))}" class="r num"><span class="cell ${cls(p.s2Pct, T.s1OnTime, 60)}">${pc(p.s2Pct)}</span></td>
      <td data-label="${esc(L('Median TAT', 'Median TAT'))}" class="r num"><span class="cell ${cls(p.medTat, T.tatHours, T.tatHours * 2, true)}">${p.medTat == null ? '—' : r0(p.medTat) + 'h'}</span></td>
      <td data-label="${esc(L('Within target', 'Target ke andar'))}" class="r num"><span class="cell ${cls(p.tatPct, 50, 35)}">${pc(p.tatPct)}</span></td>
    </tr>`).join('');
    const h = [L('Person', 'Naam'), L('Delivered', 'Deliver'), L('Open now', 'Abhi open'), L('Stage 1 on time', 'Stage 1 time par'), L('QC stage on time', 'QC stage time par'), L('Median TAT', 'Median TAT'), L('Within target', 'Target ke andar')];
    return `<section class="card people"><h2>${esc(L('People', 'Team'))}</h2>
      <table class="tbl"><thead><tr>${h.map((x, i) => `<th class="${i ? 'r' : ''}">${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty">${esc(L('No data in this period.', 'Is period me data nahi.'))}</td></tr>`}</tbody></table></section>`;
  }

  // ---------- detail table ----------
  function tabLists() {
    const v = state.view;
    const tasks = state.data.tasks;
    return [
      ['requested', L('Requested', 'Maange gaye'), [...v.m.req].sort((a, b) => b.ts - a.ts)],
      ['delivered', L('Delivered', 'Deliver hue'), [...v.m.del].sort((a, b) => b.a2 - a.a2)],
      ['open', L('Open', 'Open'), tasks.filter((t) => t.stage !== 'done').sort((a, b) => a.priority - b.priority || b.odDays - a.odDays)],
      ['overdue', L('Overdue', 'Late'), [...v.overdue].sort((a, b) => b.odDays - a.odDays)],
      ['s1late', L('Stage 1 late', 'Stage 1 late'), [...v.m.s1Late].sort((a, b) => b.a1 - a.a1)],
      ...(adminLayout() ? [['qcskipped', L('QC skipped', 'QC skip'), [...v.m.qcSkippedList].sort((a, b) => b.a2 - a.a2)]] : []),
    ];
  }

  function renderDetail() {
    const lists = tabLists();
    if (!lists.some(([k]) => k === state.tab)) state.tab = 'requested';
    $('dTabs').innerHTML = lists.map(([k, label, list]) => `<button class="pill ${state.tab === k ? 'active' : ''}" data-dtab="${k}">${esc(label)}<span class="count">${list.length}</span></button>`).join('');
    const q = state.search.trim().toLowerCase();
    let rows = lists.find(([k]) => k === state.tab)[2]
      .filter((x) => !q || [x.id, x.project, x.requester, x.type, x.person, x.dept].join(' ').toLowerCase().includes(q));
    const total = rows.length;
    if (!state.showAll) rows = rows.slice(0, 150);
    if (!total) { $('dTable').innerHTML = `<div class="empty">${esc(L('No tasks here.', 'Yahan koi task nahi.'))}</div>`; return; }

    const showPerson = adminLayout();
    const cols = showPerson ? 10 : 9;
    const H = [SW.t('id'), SW.t('requested'), SW.t('project'), SW.t('type'), ...(showPerson ? [SW.t('assigned')] : []), SW.t('stage'), 'Stage 1', 'TAT', SW.t('late')];
    const s1Cell = (x) => (x.a1 == null ? '<span class="muted">—</span>'
      : x.p1 != null && x.a1 > x.p1 ? `<span class="late soft">${esc(L('late', 'late'))} ${r0((x.a1 - x.p1) / KPI.HOUR)}h</span>`
      : `<span class="ontime">${esc(L('on time', 'time par'))}</span>`);
    const body = rows.map((x) => {
      const c = (label, html, cls = '') => `<td data-label="${esc(label)}" class="${cls}">${html}</td>`;
      return `<tr class="task ${ui.isOpen(x.num) ? 'open' : ''}" data-num="${x.num}">
        <td class="id-cell">${ui.idCell(x)}</td>
        ${c(SW.t('requested'), `<span title="${esc(fmtDateTime(x.ts))}">${esc(fmtDate(x.ts))}</span>`)}
        ${c(SW.t('project'), `<b>${esc(x.project)}</b><div class="sub">${esc(x.requester)}</div>`)}
        ${c(SW.t('type'), esc(x.type))}
        ${showPerson ? c(SW.t('assigned'), x.person ? esc(x.person) : '<span class="muted">—</span>') : ''}
        ${c(SW.t('stage'), SW.stageHtml(x.stage))}
        ${c('Stage 1', s1Cell(x))}
        ${c('TAT', x.tat == null ? '<span class="muted">—</span>' : `<span class="num">${r0(x.tat)}h</span>`, 'num')}
        ${c(SW.t('late'), SW.lateHtml(x.odDays))}
        <td class="act-cell"><div class="actions">${ui.actionsHtml(x)}</div></td>
      </tr>` + ui.detailsHtml(x, cols);
    }).join('');
    $('dTable').innerHTML = `<table class="tbl"><thead><tr>${H.map((h) => `<th>${esc(h)}</th>`).join('')}<th class="r">${esc(SW.t('action'))}</th></tr></thead><tbody>${body}</tbody></table>
      ${total > rows.length ? `<div class="empty"><button class="ghost" id="showAll">${esc(L(`Show all ${total}`, `Sab ${total} dikhao`))}</button></div>` : ''}`;
  }

  // ---------- charts ----------
  const INK = '#0e0e0e', MUTED = '#72685e', RULE = '#e0d9ce', SERIES = '#2a4f8a';
  const STATUS = { good: '#1a6638', warn: '#b86b00', bad: '#c0321e' };

  function baseOptions(horizontal, extra = {}) {
    const valueAxis = { beginAtZero: true, grid: { color: RULE }, border: { display: false }, ticks: { color: MUTED, precision: 0, ...(extra.ticks || {}) }, ...(extra.max != null ? { max: extra.max } : {}) };
    // Dates may skip labels; names and categories never should (every bar needs its label).
    const catAxis = { grid: { display: false }, border: { color: RULE }, ticks: { color: INK, autoSkip: !!extra.skipLabels, maxRotation: extra.skipLabels ? 0 : 45 } };
    return {
      responsive: true, maintainAspectRatio: false, animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 300 },
      indexAxis: horizontal ? 'y' : 'x',
      plugins: { legend: { display: false }, tooltip: { backgroundColor: INK, padding: 10, cornerRadius: 6, displayColors: false, callbacks: extra.tooltip || {} } },
      scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
      interaction: { mode: 'index', intersect: false },
    };
  }

  function bar(id, labels, data, { horizontal = false, colors, max, tooltip, ticks, skipLabels } = {}) {
    const el = $(id);
    if (!el || typeof Chart === 'undefined') return;
    state.charts.push(new Chart(el, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: colors || SERIES, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, borderWidth: 0 }] },
      options: baseOptions(horizontal, { max, tooltip, ticks, skipLabels }),
    }));
  }

  function drawCharts() {
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
    if (typeof Chart === 'undefined') {
      document.querySelectorAll('.chart-box').forEach((b) => (b.innerHTML = `<div class="empty">${esc(L('Charts could not load (offline?).', 'Charts load nahi hue (internet?).'))}</div>`));
      return;
    }
    Chart.defaults.font.family = "'Sora', system-ui, sans-serif";
    Chart.defaults.font.size = 11;
    const { range, m, people } = state.view;

    // Requests over time: daily up to 35 days, otherwise weekly.
    const days = Math.ceil((range.end - range.start) / KPI.DAY);
    const step = days <= 35 ? KPI.DAY : 7 * KPI.DAY;
    const buckets = [];
    for (let s = range.start; s < range.end; s += step) buckets.push({ s, n: 0 });
    m.req.forEach((t) => { const i = Math.floor((t.ts - range.start) / step); if (buckets[i]) buckets[i].n++; });
    bar('cTime', buckets.map((b) => fmtDate(b.s)), buckets.map((b) => b.n), {
      skipLabels: true,
      tooltip: { title: (it) => (step > KPI.DAY ? L('Week of ', 'Hafta: ') : '') + it[0].label, label: (it) => `${it.raw} ${L('requests', 'requests')}` },
    });

    if (adminLayout()) {
      const ppl = people.filter((p) => p.delivered || p.s1N);
      bar('cDel', ppl.map((p) => p.name), ppl.map((p) => p.delivered), { tooltip: { label: (it) => `${it.raw} ${L('delivered', 'deliver')}` } });
      const T = state.data.targets.s1OnTime;
      const s1 = ppl.filter((p) => p.s1Pct != null);
      bar('cS1', s1.map((p) => p.name), s1.map((p) => Math.round(p.s1Pct)), {
        max: 100,
        ticks: { callback: (v) => v + '%' },
        colors: s1.map((p) => (p.s1Pct >= T ? STATUS.good : p.s1Pct >= 60 ? STATUS.warn : STATUS.bad)),
        tooltip: { label: (it) => { const p = s1[it.dataIndex]; return `${it.raw}% ${L('on time', 'time par')} · ${p.s1N} ${L('edits', 'edits')} · ${it.raw >= T ? L('on target', 'target par') : L('below target', 'target se neeche')} (${T}%)`; } },
      });
    }

    const top8 = (f) => KPI.countBy(m.req, f).slice(0, 8);
    const dept = top8((t) => t.dept);
    bar('cDept', dept.map(([k]) => k), dept.map(([, n]) => n), { horizontal: true, tooltip: { label: (it) => `${it.raw} ${L('requests', 'requests')}` } });
    const type = top8((t) => t.type);
    bar('cType', type.map(([k]) => (k.length > 28 ? k.slice(0, 28) + '…' : k)), type.map(([, n]) => n), {
      horizontal: true, tooltip: { title: (it) => type[it[0].dataIndex][0], label: (it) => `${it.raw} ${L('requests', 'requests')}` },
    });
  }

  // ---------- events ----------
  function goToTab(tab) {
    state.tab = tab;
    state.showAll = false;
    renderDetail();
    $('detail').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  $('content').addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) return goToTab(tabBtn.dataset.tab);
    const dtab = e.target.closest('[data-dtab]');
    if (dtab) { state.tab = dtab.dataset.dtab; state.showAll = false; return renderDetail(); }
    const ack = e.target.closest('[data-ack]');
    if (ack) {
      const acks = store.get('sw_acks', {});
      acks[ack.dataset.ack] = Date.now();
      store.set('sw_acks', acks);
      return render();
    }
    if (e.target.id === 'showAll') { state.showAll = true; return renderDetail(); }
  });
  $('content').addEventListener('input', (e) => {
    if (e.target.id === 'dSearch') { state.search = e.target.value; renderDetail(); }
  });
  ui.bind($('content'), renderDetail);

  $('periodPills').addEventListener('click', (e) => {
    const p = e.target.closest('[data-period]');
    if (!p) return;
    state.period = p.dataset.period;
    store.set('sw_period', state.period);
    if (state.period === 'custom' && !state.custom.from) { $('customBox').classList.remove('hidden'); renderChrome(); return; }
    render();
  });
  $('cApply').onclick = () => {
    state.custom = { from: $('cFrom').value, to: $('cTo').value };
    if (!state.custom.from || !state.custom.to) return SW.toast(L('Pick both dates.', 'Dono dates chuno.'), 'err');
    render();
  };
  $('refreshBtn').onclick = () => load(true);
  $('printBtn').onclick = () => window.print();

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

  (async function start() {
    state.me = await SW.initPage('dashboard', () => state.data && render());
    if (!isAdmin()) state.viewAs = '';
    const saved = store.get('sw_period', 'thisMonth');
    if (saved !== 'custom') state.period = saved;
    if (isAdmin() && state.viewAs) state.allEditors = (await api('/api/editors')).editors || [];
    await load();
  })();
})();
