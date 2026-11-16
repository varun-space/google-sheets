// Shared by every logged-in page: session check, header + nav, api() helper, EN/HI labels, toast, formatting.
// Exposes one global, `SW`, so page scripts stay plain <script> files with no build step.

(function () {
  // ---- i18n: English + Hinglish (Roman script). Missing keys fall back to English. ----
  const DICT = {
    en: {
      queue: 'Work queue', dashboard: 'Dashboard', logout: 'Log out', loggedInAs: 'Logged in as',
      allOpen: 'All open', un: 'Unassigned', working: 'Editing', qcwait: 'Waiting QC', final: 'Final output', done: 'Done',
      id: 'ID', requested: 'Requested', requester: 'Requester', project: 'Project', type: 'Type', priority: 'Priority',
      assigned: 'Assigned', stage: 'Stage', late: 'Late', action: 'Action', search: 'Search ID, project, requester…',
      viewAs: 'View as', everyone: 'Everyone (admin)', backToEveryone: '← Back to everyone', viewingAs: 'You are seeing exactly what {name} sees.',
      newRequest: '＋ New request', refresh: '↻ Refresh', assign: 'Assign', reassign: 'Re-assign', editDone: '✓ Editing done',
      qcPass: '✓ QC pass', sendBack: '↩ Send back', finalDone: '✓ Final done', saveLink: 'Save link', fileLink: 'File link (https://…)',
      waitingQc: 'Waiting for QC', waitingAssign: 'Not assigned yet', nothing: 'Nothing here — all clear. 🎉', loading: 'Loading tasks…',
      dLate: '{n}d late', pickEditor: '— pick editor —', saving: 'Saving…', cancel: 'Cancel', create: 'Create request',
      confirmSendBack: 'Send {id} back to editing? This clears editing-done and QC.', confirmFinal: 'Mark {id} final output as done?',
      openTasks: 'open tasks', dataAsOf: 'data as of', builtBy: '⚡ Built by MeDa Partners · Video Ops Dashboard',
      platform: 'Platform', duration: 'Duration', raw: 'Raw footage', script: 'Script / VO', captions: 'Captions', music: 'Music',
      ref: 'Reference', brief: 'Brief / instructions', format: 'Output format', deadline: 'Deadline', revisions: 'Revisions', file: 'Latest file',
      name: 'Requester name', dept: 'Department', select: '— select —', sameEditor: 'Already assigned to this editor — pick someone else.', optionalLink: 'Optional: final file link (https://…)',
    },
    hi: {
      queue: 'Kaam ki list', dashboard: 'Dashboard', logout: 'Log out', loggedInAs: 'Login hai:',
      allOpen: 'Sab open', un: 'Assign nahi hua', working: 'Editing chal rahi', qcwait: 'QC ka intezaar', final: 'Final output', done: 'Ho gaya',
      id: 'ID', requested: 'Kab maanga', requester: 'Kisne maanga', project: 'Project', type: 'Type', priority: 'Priority',
      assigned: 'Kisko diya', stage: 'Stage', late: 'Late', action: 'Kaam', search: 'ID, project, naam se dhoondo…',
      viewAs: 'Inki nazar se dekho', everyone: 'Sab (admin)', backToEveryone: '← Wapas sab par', viewingAs: 'Aap wahi dekh rahe ho jo {name} dekhta hai.',
      newRequest: '＋ Nayi request', refresh: '↻ Refresh', assign: 'Assign karo', reassign: 'Badlo', editDone: '✓ Editing ho gayi',
      qcPass: '✓ QC pass', sendBack: '↩ Wapas bhejo', finalDone: '✓ Final ho gaya', saveLink: 'Link save karo', fileLink: 'File link (https://…)',
      waitingQc: 'QC ka intezaar', waitingAssign: 'Abhi assign nahi', nothing: 'Kuch pending nahi — sab clear. 🎉', loading: 'Tasks load ho rahe…',
      dLate: '{n} din late', pickEditor: '— editor chuno —', saving: 'Save ho raha…', cancel: 'Cancel', create: 'Request banao',
      confirmSendBack: '{id} ko wapas editing me bhejein? Editing-done aur QC hat jayega.', confirmFinal: '{id} ka final output done mark karein?',
      openTasks: 'open tasks', dataAsOf: 'data', builtBy: '⚡ MeDa Partners ne banaya · Video Ops Dashboard',
      platform: 'Platform', duration: 'Duration', raw: 'Raw footage', script: 'Script / VO', captions: 'Captions', music: 'Music',
      ref: 'Reference', brief: 'Brief / instructions', format: 'Output format', deadline: 'Deadline', revisions: 'Revisions', file: 'Latest file',
      name: 'Request karne wale ka naam', dept: 'Department', select: '— chuno —', sameEditor: 'Ye pehle se isi editor ke paas hai — koi aur chuno.', optionalLink: 'Optional: final file ka link (https://…)',
    },
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: ignore */ } },
  };
  let lang = store.get('sw_lang') === 'hi' ? 'hi' : 'en';

  function t(key, vars) {
    let s = DICT[lang][key] ?? DICT.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace('{' + k + '}', v);
    return s;
  }

  // ---- HTML escaping: all sheet data is user-typed, never trust it as markup. ----
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- API ----
  async function api(path, opts = {}) {
    const init = { credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.method = 'POST';
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try { res = await fetch(path, init); }
    catch { throw new Error('Network error — check your connection.'); }
    const data = await res.json().catch(() => ({ ok: false, msg: `Server error (${res.status})` }));
    if (res.status === 401 && !opts.allow401) { location.href = '/login'; throw new Error(data.msg || 'Please log in.'); }
    return data;
  }

  // ---- Formatting (always IST) ----
  const TZ = 'Asia/Kolkata';
  const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short' }) : '—';
  const fmtDateTime = (ms) => ms ? new Date(ms).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
  const fmtTime = (ms) => ms ? new Date(ms).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e7) return (n / 1e7).toFixed(1).replace(/\.0$/, '') + ' Cr';
    if (a >= 1e5) return (n / 1e5).toFixed(1).replace(/\.0$/, '') + ' L';
    if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return Math.round(n).toLocaleString('en-IN');
  }

  // ---- Small shared cells (queue + dashboard) ----
  const PRIO = { en: ['Urgent', 'High', 'Normal', 'Low', 'Not set'], hi: ['Urgent', 'High', 'Normal', 'Low', 'Set nahi'] };
  const prioHtml = (p) => `<span class="prio p${p}">${esc(PRIO[lang][p] ?? '')}</span>`;
  const stageHtml = (s) => `<span class="stage ${s}">${esc(t(s))}</span>`;
  function lateHtml(odDays) {
    const d = Math.floor(odDays || 0);
    if (d < 1) return '<span class="muted">—</span>';
    return `<span class="late ${d < 2 ? 'soft' : ''}">${esc(t('dLate', { n: d }))}</span>`;
  }

  // ---- Toast ----
  let toastTimer;
  function toast(msg, kind = '') {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.className = 'show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = kind), kind === 'err' ? 6000 : 3500);
  }

  // ---- Header + footer ----
  function renderHeader(me, active, onLangChange) {
    const h = document.createElement('header');
    h.className = 'site-header';
    h.innerHTML = `<div class="inner">
      <a href="/"><img src="/img/meda-partners-white.png" alt="MeDa Partners"></a>
      <nav>
        <a href="/" class="${active === 'queue' ? 'active' : ''}">${esc(t('queue'))}</a>
        <a href="/dashboard" class="${active === 'dashboard' ? 'active' : ''}">${esc(t('dashboard'))}</a>
      </nav>
      <div class="right">
        <span class="who">${esc(t('loggedInAs'))} <b>${esc(me.name)}</b></span>
        <button class="on-dark sm" id="langBtn" title="English / Hinglish">${lang === 'en' ? 'हि HI' : 'EN'}</button>
        <button class="on-dark sm" id="logoutBtn">${esc(t('logout'))}</button>
      </div></div>`;
    document.body.prepend(h);
    h.querySelector('#logoutBtn').onclick = async () => { await api('/api/logout', { body: {} }); location.href = '/login'; };
    h.querySelector('#langBtn').onclick = () => {
      lang = lang === 'en' ? 'hi' : 'en';
      store.set('sw_lang', lang);
      h.remove();
      renderHeader(me, active, onLangChange);
      onLangChange?.();
    };
  }

  function renderFooter(readAt) {
    let f = document.querySelector('footer.site');
    if (!f) { f = document.createElement('footer'); f.className = 'site'; document.body.appendChild(f); }
    f.innerHTML = `<span>${esc(t('builtBy'))} · ${esc(t('dataAsOf'))} ${esc(fmtDateTime(readAt))}</span><span>MeDa Partners Pvt Ltd | www.meda.partners</span>`;
  }

  /** Call first on every logged-in page. Redirects to /login when there is no session. */
  async function initPage(active, onLangChange) {
    const res = await api('/api/me');
    if (!res.ok) { location.href = '/login'; return new Promise(() => {}); }
    renderHeader(res.me, active, onLangChange);
    return res.me;
  }

  window.SW = { t, esc, api, toast, prioHtml, stageHtml, lateHtml, initPage, renderFooter, fmtDate, fmtDateTime, fmtTime, fmtNum, get lang() { return lang; } };
})();
