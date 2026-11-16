// Shared task-row UI used by both the Work queue and the Dashboard detail table:
// action buttons per stage/role, expandable details, confirm dialog, and posting to /api/action.
// The server re-checks everything; this only decides which buttons are worth showing.

(function () {
  const { t, esc, api, toast, fmtDate } = SW;

  let confirmDlg;
  function confirmBox({ title, text, withLink }) {
    if (!confirmDlg) {
      confirmDlg = document.createElement('dialog');
      confirmDlg.innerHTML = `<form method="dialog">
        <div class="m-head"><h2 data-f="title"></h2></div>
        <div class="m-body"><p class="full" data-f="text" style="margin:0"></p>
          <div class="full" data-f="linkWrap"><label data-f="linkLabel" for="cfLink"></label><input id="cfLink" type="url" placeholder="https://"></div></div>
        <div class="m-foot"><button type="button" class="ghost" data-f="cancel"></button><button type="submit">OK</button></div></form>`;
      document.body.appendChild(confirmDlg);
    }
    const f = (k) => confirmDlg.querySelector(`[data-f="${k}"]`);
    const linkInput = confirmDlg.querySelector('#cfLink');
    f('title').textContent = title;
    f('text').textContent = text;
    f('linkWrap').classList.toggle('hidden', !withLink);
    f('linkLabel').textContent = t('optionalLink');
    f('cancel').textContent = t('cancel');
    linkInput.value = '';
    return new Promise((resolve) => {
      const done = (val) => { confirmDlg.close(); resolve(val); };
      confirmDlg.querySelector('form').onsubmit = (e) => {
        e.preventDefault();
        const link = linkInput.value.trim();
        if (link && !/^https:\/\//.test(link)) return toast('File link must start with https://', 'err');
        done({ link });
      };
      f('cancel').onclick = () => done(null);
      confirmDlg.oncancel = () => resolve(null);
      confirmDlg.showModal();
    });
  }

  /**
   * ctx = { me(), tasks(), editors(), reload() }
   * Returns helpers bound to one page's state.
   */
  function create(ctx) {
    const open = new Set();
    const isAdmin = () => ctx.me().role === 'admin';
    const canWork = (x) => isAdmin() || x.person === ctx.me().name;

    function editorSelect(x) {
      return `<select data-role="editor" aria-label="${esc(t('assigned'))}"><option value="">${esc(t('pickEditor'))}</option>` +
        ctx.editors().map((n) => `<option value="${esc(n)}" ${n === x.person ? 'selected' : ''}>${esc(n)}</option>`).join('') + '</select>';
    }

    function actionsHtml(x) {
      const admin = isAdmin();
      const b = (act, label, cls = '') => `<button class="sm ${cls}" data-act="${act}">${esc(t(label))}</button>`;
      switch (x.stage) {
        case 'un':
          return admin ? editorSelect(x) + b('assign', 'assign') : `<span class="muted">${esc(t('waitingAssign'))}</span>`;
        case 'working':
          return (canWork(x) ? b('editDone', 'editDone', 'green') : '') + (admin ? editorSelect(x) + b('assign', 'reassign', 'ghost') : '');
        case 'qcwait':
          return admin
            ? b('qcPass', 'qcPass', 'green') + b('qcReject', 'sendBack', 'red') + editorSelect(x) + b('assign', 'reassign', 'ghost')
            : `<span class="muted">${esc(t('waitingQc'))}</span>`;
        case 'final':
          return (canWork(x) ? b('finalDone', 'finalDone', 'green') : '') + (admin ? editorSelect(x) + b('assign', 'reassign', 'ghost') : '');
        default:
          return '';
      }
    }

    function idCell(x) {
      if (!x.details) return `<span class="mono"><b>${esc(x.id)}</b></span>`;
      return `<button class="id-btn" data-act="toggle" aria-expanded="${open.has(x.num)}"><span class="caret">▸</span>${esc(x.id)}</button>`;
    }

    function detailsHtml(x, cols) {
      if (!open.has(x.num) || !x.details) return '';
      const d = x.details;
      const val = (v) => {
        const s = String(v ?? '').trim();
        if (!s) return '<span class="muted">—</span>';
        if (/^https?:\/\//i.test(s)) return `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(s.length > 60 ? s.slice(0, 60) + '…' : s)}</a>`;
        return esc(s);
      };
      const item = (k, v, wide) => `<div class="${wide ? 'wide' : ''}"><div class="k">${esc(t(k))}</div><div class="v">${v}</div></div>`;
      const linkBox = canWork(x) && x.stage !== 'un'
        ? `<div class="linkbox"><input type="url" data-role="link" placeholder="${esc(t('fileLink'))}"><button class="sm" data-act="addLink">${esc(t('saveLink'))}</button></div>`
        : '';
      return `<tr class="details" data-num="${x.num}"><td colspan="${cols}">
        <div class="dgrid">
          ${item('platform', val(d.platform))}${item('duration', val(d.duration))}${item('format', val(d.format))}
          ${item('deadline', val(d.deadline ? fmtDate(d.deadline) : ''))}${item('revisions', val(d.revisions))}
          ${item('script', val(d.script))}${item('captions', val(d.captions))}${item('music', val(d.music))}
          ${item('raw', val(d.raw))}${item('ref', val(d.ref))}${item('file', val(d.file))}
          ${item('brief', val(d.brief), true)}
        </div>${linkBox}</td></tr>`;
    }

    async function run(payload) {
      const els = document.querySelectorAll(`tr[data-num="${payload.num}"] button, tr[data-num="${payload.num}"] select`);
      els.forEach((el) => (el.disabled = true));
      toast(t('saving'));
      try {
        const res = await api('/api/action', { body: payload });
        toast(res.msg || (res.ok ? 'Done' : 'Failed'), res.ok ? 'ok' : 'err');
        if (res.ok) return ctx.reload();
      } catch (err) {
        toast(err.message, 'err');
      }
      els.forEach((el) => (el.disabled = false));
    }

    /** Wire once on a container; returns true when the click was a task action. `rerender` redraws after expand/collapse. */
    function bind(container, rerender) {
      container.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn || !btn.closest('tr[data-num]')) return;
        const rowEl = btn.closest('tr');
        const num = Number(rowEl.dataset.num);
        const x = ctx.tasks().find((y) => y.num === num);
        if (!x) return;
        const act = btn.dataset.act;

        if (act === 'toggle') {
          open.has(num) ? open.delete(num) : open.add(num);
          return rerender();
        }
        if (act === 'assign') {
          const editor = rowEl.querySelector('select[data-role="editor"]')?.value;
          if (!editor) return toast(t('pickEditor'), 'err');
          if (editor === x.person) return toast(t('sameEditor'), 'err');
          return run({ action: 'assign', num, editor });
        }
        if (act === 'qcReject') {
          if (await confirmBox({ title: t('sendBack'), text: t('confirmSendBack', { id: x.id }) })) run({ action: 'qcReject', num });
          return;
        }
        if (act === 'finalDone') {
          const ok = await confirmBox({ title: t('finalDone'), text: t('confirmFinal', { id: x.id }), withLink: true });
          if (ok) run({ action: 'finalDone', num, link: ok.link });
          return;
        }
        if (act === 'addLink') {
          const link = rowEl.querySelector('input[data-role="link"]').value.trim();
          if (!/^https:\/\/\S+$/.test(link)) return toast('File link must start with https://', 'err');
          return run({ action: 'addLink', num, link });
        }
        run({ action: act, num }); // editDone, qcPass
      });
    }

    return { actionsHtml, idCell, detailsHtml, bind, isOpen: (n) => open.has(n), clear: () => open.clear() };
  }

  SW.taskUI = { create };
})();
