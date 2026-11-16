// Dashboard maths: periods, KPIs, per-person stats, health score, flags and Expert Desk rules.
// Pure functions with no DOM, so the same file runs in the browser (window.KPI) and in node tests (require).
// All tasks passed in are already filtered by the server for the viewer's role.

(function (root) {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const IST = 5.5 * HOUR;

  // ---------- periods (calendar boundaries in IST) ----------
  function istYMD(ms) {
    const d = new Date(ms + IST);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() };
  }
  const istStart = (y, m, d) => Date.UTC(y, m, d) - IST; // Date.UTC handles month/day overflow
  const isoToStart = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? istStart(+m[1], +m[2] - 1, +m[3]) : null;
  };

  /** key: thisMonth | lastWeek | lastMonth | last3 | custom → {start, end} (end exclusive). */
  function periodRange(key, now, custom = {}) {
    const { y, m, d, dow } = istYMD(now);
    const monday = d - ((dow + 6) % 7);
    switch (key) {
      case 'lastWeek': return { start: istStart(y, m, monday - 7), end: istStart(y, m, monday) };
      case 'lastMonth': return { start: istStart(y, m - 1, 1), end: istStart(y, m, 1) };
      case 'last3': return { start: istStart(y, m - 3, 1), end: istStart(y, m, 1) };
      case 'custom': {
        const s = isoToStart(custom.from);
        const e = isoToStart(custom.to);
        if (s != null && e != null && e >= s) return { start: s, end: Math.min(e + DAY, now) };
        return periodRange('thisMonth', now);
      }
      default: return { start: istStart(y, m, 1), end: now };
    }
  }

  /** The equal-length window just before [start, end), k steps back. */
  const shift = ({ start, end }, k) => ({ start: start - k * (end - start), end: end - k * (end - start) });

  // ---------- helpers ----------
  const pct = (a, b) => (b ? (a / b) * 100 : null);
  function quantile(arr, q) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const i = (s.length - 1) * q;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
  }
  const median = (arr) => quantile(arr, 0.5);
  function countBy(list, f) {
    const m = new Map();
    for (const x of list) m.set(f(x), (m.get(f(x)) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  // ---------- core metrics for one window ----------
  function metrics(tasks, { start, end }, targets) {
    const inR = (v) => v != null && v >= start && v < end;
    const req = tasks.filter((t) => inR(t.ts));
    const del = tasks.filter((t) => inR(t.a2));
    const s1 = tasks.filter((t) => inR(t.a1) && t.p1 != null);
    const s1Late = s1.filter((t) => t.a1 > t.p1);
    const s2 = del.filter((t) => t.p2 != null);
    const qcSkipped = del.filter((t) => !t.qc);
    // Tasks closed without times (~93 early rows) have tat=null and drop out of timing metrics here.
    const tats = del.map((t) => t.tat).filter((v) => v != null && v >= 0);
    return {
      req, del, s1Late, qcSkippedList: qcSkipped,
      reqN: req.length,
      delN: del.length,
      s1N: s1.length,
      s1Pct: pct(s1.length - s1Late.length, s1.length),
      s2Pct: pct(s2.filter((t) => t.a2 <= t.p2).length, s2.length),
      qcPct: pct(del.length - qcSkipped.length, del.length),
      tatPct: pct(tats.filter((v) => v <= targets.tatHours).length, tats.length),
      medTat: median(tats),
      p90Tat: quantile(tats, 0.9),
      urgentShare: pct(req.filter((t) => t.priority === 0).length, req.length),
      blankShare: pct(req.filter((t) => t.dept === '(Not specified)' || t.type === '(Not specified)').length, req.length),
    };
  }

  function byPerson(tasks, range, targets) {
    const names = [...new Set(tasks.map((t) => t.person).filter(Boolean))].sort();
    return names.map((name) => {
      const mine = tasks.filter((t) => t.person === name);
      const m = metrics(mine, range, targets);
      return {
        name, delivered: m.delN, open: mine.filter((t) => t.stage !== 'done').length,
        s1Pct: m.s1Pct, s1N: m.s1N, s2Pct: m.s2Pct, medTat: m.medTat, tatPct: m.tatPct,
      };
    });
  }

  const overdueList = (tasks) => tasks.filter((t) => t.stage !== 'done' && t.person && t.odDays >= 2);

  /** Progress toward target as a ratio (1 = on target). Overdue is "lower is better" with target 0. */
  function pace(value, target, lowerBetter) {
    if (target == null || value == null) return null;
    if (lowerBetter) return value <= target ? 1 : Math.max(0, 1 - (value - target) / 10);
    return target ? value / target : 1;
  }

  /** 60 × avg(min(pace,1)) + 25 × (1 − critical/4, floor 0) + 15 × (data not stale). */
  function healthScore(paces, criticalCount, stale) {
    const p = paces.filter((x) => x != null);
    const avg = p.length ? p.reduce((s, x) => s + Math.min(x, 1), 0) / p.length : 1;
    return Math.round(60 * avg + 25 * Math.max(0, 1 - criticalCount / 4) + 15 * (stale ? 0 : 1));
  }

  // ---------- flags ----------
  const SEVERITY = ['MOST CRITICAL', 'CRITICAL', 'RED FLAG', 'WATCH', 'POSITIVE'];
  const r0 = (v) => Math.round(v ?? 0);

  /**
   * ctx = {tasks, m, prev, people, now, lastRequestAt, admin, me, targets, owners, L}
   * L(en, hi) picks the language. Doers only get their own overdue / on-time / star flags.
   */
  function buildFlags(ctx) {
    const { tasks, m, prev, people, now, admin, targets: T, owners: O, L } = ctx;
    const out = [];
    const add = (id, sev, text, owner, q, tab) => out.push({ id, sev, text, owner, q, tab });

    const od = overdueList(tasks);
    if (od.length) {
      const oldest = Math.floor(Math.max(...od.map((t) => t.odDays)));
      add('overdue', od.length >= 5 ? 'MOST CRITICAL' : 'CRITICAL',
        L(`${od.length} task(s) are 2+ days overdue — oldest is ${oldest} days.`, `${od.length} task 2+ din se late hain — sabse purana ${oldest} din.`),
        O.coordinator,
        L(`Which of these can ship today, and what is blocking the rest?`, `Inme se kaunse aaj nikal sakte hain, baaki kahan atke hain?`), 'overdue');
    }

    const slow = people.filter((p) => p.s1N >= 10 && p.s1Pct != null && p.s1Pct < 75 && (admin || p.name === ctx.me));
    const crit = slow.filter((p) => p.s1Pct < 60);
    const red = slow.filter((p) => p.s1Pct >= 60);
    const names = (list) => list.map((p) => `${p.name} ${r0(p.s1Pct)}%`).join(', ');
    if (crit.length) add('s1crit', 'CRITICAL', L(`Stage 1 on time below 60%: ${names(crit)}.`, `Stage 1 time par 60% se kam: ${names(crit)}.`),
      O.coordinator, L(`What is slowing the first cut — briefs, footage, or workload?`, `First cut me deri kyun — brief, footage ya load?`), 's1late');
    if (red.length) add('s1red', 'RED FLAG', L(`Stage 1 on time below 75%: ${names(red)}.`, `Stage 1 time par 75% se kam: ${names(red)}.`),
      O.coordinator, L(`Which tasks slipped and why?`, `Kaunse task late hue aur kyun?`), 's1late');

    if (admin) {
      const un = tasks.filter((t) => t.stage === 'un');
      if (un.length) {
        const oldDays = Math.max(...un.map((t) => (now - (t.ts || now)) / DAY));
        add('unassigned', oldDays >= 1 ? 'CRITICAL' : 'RED FLAG',
          L(`${un.length} request(s) are not assigned to anyone.`, `${un.length} request kisi ko assign nahi hui.`),
          O.coordinator, L(`Who takes these, and by when?`, `Ye kaun lega, aur kab tak?`), 'open');
      }
      if (ctx.lastRequestAt && now - ctx.lastRequestAt > T.staleDays * DAY) {
        const d = Math.floor((now - ctx.lastRequestAt) / DAY);
        add('stale', 'RED FLAG', L(`No new request in ${d} days.`, `${d} din se koi nayi request nahi aayi.`),
          O.coordinator, L(`Is the form still being used, or are requests coming on WhatsApp?`, `Form use ho raha hai, ya requests WhatsApp par aa rahi hain?`));
      }
      if (m.reqN >= 5 && m.delN < 0.8 * m.reqN) add('backlog', 'RED FLAG',
        L(`Backlog growing: ${m.delN} delivered vs ${m.reqN} requested.`, `Backlog badh raha: ${m.reqN} maange, ${m.delN} deliver.`),
        O.coordinator, L(`What do we stop or push to clear the gap?`, `Gap bharne ke liye kya rokna ya aage karna hai?`), 'requested');
      if (m.medTat != null && m.medTat > T.tatHours) add('tat', 'RED FLAG',
        L(`Median turnaround is ${r0(m.medTat)}h (target ${T.tatHours}h).`, `Median turnaround ${r0(m.medTat)} ghante (target ${T.tatHours}).`),
        O.coordinator, L(`Where does the waiting happen — queue, edit or QC?`, `Intezaar kahan ho raha — queue, edit ya QC?`), 'delivered');
      if (m.urgentShare != null && m.reqN >= 5 && m.urgentShare > 50) add('urgent', 'WATCH',
        L(`${r0(m.urgentShare)}% of requests are marked Urgent.`, `${r0(m.urgentShare)}% requests Urgent mark hain.`),
        O.coordinator, L(`Are these really same-day? Ask requesters to justify Urgent.`, `Kya ye sach me same-day hain? Requesters se reason maango.`), 'requested');
      if (m.blankShare != null && m.reqN >= 5 && m.blankShare > 10) add('blank', 'WATCH',
        L(`${r0(m.blankShare)}% of requests have no department or type.`, `${r0(m.blankShare)}% requests me department ya type khaali hai.`),
        O.coordinator, L(`Can we make these fields required in the form?`, `Kya form me ye fields required kar sakte hain?`), 'requested');
      const top = countBy(m.del.filter((t) => t.person), (t) => t.person)[0];
      if (top && m.delN >= 10 && top[1] / m.delN > 0.5) add('spof', 'WATCH',
        L(`${top[0]} delivered ${r0((top[1] / m.delN) * 100)}% of all output.`, `${top[0]} ne ${r0((top[1] / m.delN) * 100)}% output diya.`),
        O.coordinator, L(`Who is the backup if ${top[0]} is away?`, `${top[0]} na ho to backup kaun hai?`), 'delivered');
      if (m.s1Pct != null && m.s1N >= 10 && m.s1Pct >= T.s1OnTime) add('teamGood', 'POSITIVE',
        L(`Team Stage 1 on time is ${r0(m.s1Pct)}% — at or above target.`, `Team Stage 1 time par ${r0(m.s1Pct)}% — target par ya upar.`),
        O.coordinator, L(`What is working that we should keep doing?`, `Kya achha chal raha hai jo jaari rakhna hai?`));
      if (prev.reqN >= 5 && m.reqN > prev.reqN * 1.2 && m.s1Pct != null && prev.s1Pct != null && m.s1Pct >= prev.s1Pct - 2) add('growth', 'POSITIVE',
        L(`Requests up ${r0(pct(m.reqN - prev.reqN, prev.reqN))}% with on-time holding steady.`, `Requests ${r0(pct(m.reqN - prev.reqN, prev.reqN))}% badhi, on-time stable.`),
        O.coordinator, L(`Recognise the team this week.`, `Is hafte team ko shabaashi do.`));
    }

    people.filter((p) => p.s1N >= 15 && p.s1Pct >= 97 && (admin || p.name === ctx.me)).forEach((p) =>
      add('star-' + p.name, 'POSITIVE', L(`⭐ ${p.name}: ${r0(p.s1Pct)}% Stage 1 on time over ${p.s1N} tasks.`, `⭐ ${p.name}: ${p.s1N} tasks me ${r0(p.s1Pct)}% time par.`),
        O.coordinator, L(`What does ${p.name} do that others can copy?`, `${p.name} ka kaun sa tareeka baaki copy kar sakte hain?`)));

    return out.sort((a, b) => SEVERITY.indexOf(a.sev) - SEVERITY.indexOf(b.sev));
  }

  // ---------- Expert Desk (admin) ----------
  /** Returns [{kind: 'suggestion'|'bottleneck'|'pitfall', text}] — text marks ONE number as **n**. */
  function buildExpert({ tasks, m, prev, people, targets: T, L }) {
    const out = [];
    const add = (kind, text) => out.push({ kind, text });

    const topType = countBy(m.req, (t) => t.type).filter(([k]) => k !== '(Not specified)')[0];
    if (topType && m.reqN >= 8 && topType[1] / m.reqN > 0.25) {
      const p = r0((topType[1] / m.reqN) * 100);
      add('suggestion', L(`**${p}%** of requests are "${topType[0]}". Build a template kit — intro/outro, caption style, LUT, music bed — so editors start at 60%, not zero.`,
        `**${p}%** requests "${topType[0]}" ki hain. Ek template kit banao — intro/outro, caption style, LUT, music — taaki editor zero se nahi, 60% se shuru kare.`));
    }
    const topReq = countBy(m.req.filter((t) => t.requester), (t) => t.requester)[0];
    if (topReq && m.reqN >= 8 && topReq[1] / m.reqN > 0.15) {
      const p = r0((topReq[1] / m.reqN) * 100);
      add('suggestion', L(`${topReq[0]} sends **${p}%** of all requests. Batch them: one weekly brief, one shoot day, fewer context switches for editors.`,
        `${topReq[0]} **${p}%** requests bhejte hain. Inhe batch karo: hafte me ek brief, ek shoot day, editors ka kam context-switch.`));
    }
    const ranked = people.filter((p) => p.s1N >= 5 && p.s1Pct != null).sort((a, b) => a.s1Pct - b.s1Pct);
    if (ranked.length >= 2 && ranked.at(-1).s1Pct - ranked[0].s1Pct >= 15) {
      const w = ranked[0], s = ranked.at(-1);
      add('suggestion', L(`Pair ${w.name} (**${r0(w.s1Pct)}%** on time) with ${s.name} (${r0(s.s1Pct)}%) for a week — shadowing fixes habits faster than reminders.`,
        `${w.name} (**${r0(w.s1Pct)}%** time par) ko ek hafte ${s.name} (${r0(s.s1Pct)}%) ke saath bithao — reminders se zyada shadowing kaam karti hai.`));
    }
    if (m.s1Pct != null && m.s2Pct != null && m.s1Pct < m.s2Pct - 15) {
      add('bottleneck', L(`Stage 1 on time is **${r0(m.s1Pct)}%** vs ${r0(m.s2Pct)}% at the final stage — the first cut is where time is lost. Fix briefs and footage handover first.`,
        `Stage 1 time par sirf **${r0(m.s1Pct)}%** hai, final stage ${r0(m.s2Pct)}% — time first cut me ja raha hai. Pehle brief aur footage handover theek karo.`));
    }
    const openN = tasks.filter((t) => t.stage !== 'done').length;
    if (openN >= 10) add('bottleneck', L(`**${openN}** tasks are open right now. Pause new low-priority intake until the queue is under 10.`,
      `Abhi **${openN}** tasks open hain. Queue 10 se neeche aane tak low-priority nayi requests roko.`));
    if (m.p90Tat != null && m.p90Tat > 3 * T.tatHours) add('bottleneck', L(`The slowest 10% take **${r0(m.p90Tat)}h** or more — over 3× the ${T.tatHours}h target. Pick the 3 oldest and unblock them personally.`,
      `Sabse slow 10% tasks **${r0(m.p90Tat)} ghante** ya zyada le rahe — target ka 3 guna se upar. Sabse purane 3 khud unblock karo.`));
    if (m.urgentShare != null && m.reqN >= 5 && m.urgentShare > 35) add('pitfall', L(`**${r0(m.urgentShare)}%** of requests are marked Urgent. When everything is urgent, nothing is — real urgent work waits behind fake urgent.`,
      `**${r0(m.urgentShare)}%** requests Urgent hain. Jab sab urgent hai to kuch urgent nahi — asli urgent kaam nakli urgent ke peeche atakta hai.`));
    if (m.qcPct != null && m.delN >= 5 && 100 - m.qcPct > 10) add('pitfall', L(`**${r0(100 - m.qcPct)}%** of delivered videos skipped QC. Every skipped QC is a client-visible risk.`,
      `**${r0(100 - m.qcPct)}%** delivered videos bina QC gaye. Har skip hua QC client ke saamne risk hai.`));
    if (m.blankShare != null && m.reqN >= 5 && m.blankShare > 10) add('pitfall', L(`**${r0(m.blankShare)}%** of requests have no department or type — reports are guessing. Make those fields required.`,
      `**${r0(m.blankShare)}%** requests me department/type khaali — reports andaaza laga rahe hain. Ye fields required karo.`));
    const top = countBy(m.del.filter((t) => t.person), (t) => t.person)[0];
    if (top && m.delN >= 10 && top[1] / m.delN > 0.5) add('pitfall', L(`${top[0]} delivered **${r0((top[1] / m.delN) * 100)}%** of output. If they're away, delivery halves — cross-train a second editor.`,
      `${top[0]} ne **${r0((top[1] / m.delN) * 100)}%** output diya. Wo chhutti par gaye to delivery aadhi — doosra editor tayyar karo.`));
    if (prev.reqN >= 5 && m.reqN >= prev.reqN * 1.15 && m.s1Pct != null && prev.s1Pct != null && m.s1Pct <= prev.s1Pct - 5) {
      add('pitfall', L(`Requests are up **${r0(pct(m.reqN - prev.reqN, prev.reqN))}%** while on-time fell ${r0(prev.s1Pct - m.s1Pct)} pts — a classic burnout pattern. Protect editing hours before quality slips.`,
        `Requests **${r0(pct(m.reqN - prev.reqN, prev.reqN))}%** badhi aur on-time ${r0(prev.s1Pct - m.s1Pct)} point gira — burnout ka pattern. Quality girne se pehle editing hours bachao.`));
    }
    return out;
  }

  const api = { HOUR, DAY, periodRange, shift, pct, median, quantile, countBy, metrics, byPerson, overdueList, pace, healthScore, buildFlags, buildExpert, SEVERITY, istYMD, istStart };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KPI = api;
})(typeof window !== 'undefined' ? window : globalThis);
