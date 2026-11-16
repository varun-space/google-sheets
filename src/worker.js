// Entry point. Static files in ./public are served by Cloudflare *before* this code runs,
// so the Worker only sees requests that have no matching file — in practice /api/* and unknown paths.

import { readRange } from './sheets.js';
import { clearCache, getAll, OWNERS, TARGETS, tasksFor } from './data.js';
import { checkLogin, clearSessionCookie, makeSessionCookie, readSession } from './auth.js';
import { OPTIONS, runAction } from './actions.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });

    try {
      // Reject cross-site POSTs (cookie is SameSite=Lax already; this is a second lock).
      if (request.method === 'POST') {
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) return json({ ok: false, msg: 'Bad origin.' }, 403);
      }
      return await route(request, env, url);
    } catch (err) {
      return json({ ok: false, msg: err.message }, 500);
    }
  },
};

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // --- public ---
  if (path === '/api/health') return json(await health(env));

  if (path === '/api/editors' && method === 'GET') {
    const { editors } = await getAll(env);
    return json({ ok: true, editors });
  }

  if (path === '/api/login' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { editors } = await getAll(env);
    const res = await checkLogin(env, body, editors);
    if (!res.ok) return json(res, 401);
    return json({ ok: true, me: res.session }, 200, { 'set-cookie': await makeSessionCookie(request, env, res.session) });
  }

  if (path === '/api/logout') {
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(request) });
  }

  // --- everything below needs a session ---
  const session = await readSession(request, env);
  if (!session) return json({ ok: false, msg: 'Please log in.' }, 401);

  if (path === '/api/me') return json({ ok: true, me: session });

  if (path === '/api/data' && method === 'GET') {
    const all = await getAll(env, { refresh: url.searchParams.get('refresh') === '1' });
    // Doers always get only their own rows. Admin may "view as" a doer to see exactly what they see.
    const viewAs = session.role === 'admin' ? url.searchParams.get('as') || '' : session.name;
    const tasks = viewAs ? tasksFor(all.tasks, viewAs) : all.tasks;
    return json({
      ok: true,
      me: session,
      viewAs: session.role === 'admin' ? viewAs : '',
      tasks,
      editors: session.role === 'admin' ? all.editors : [session.name],
      targets: TARGETS,
      owners: OWNERS,
      lastRequestAt: all.lastRequestAt,
      readAt: all.readAt,
      now: Date.now(),
      options: session.role === 'admin' ? OPTIONS : undefined,
    });
  }

  if (path === '/api/action' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const res = await runAction(env, session, body);
    if (res.ok) clearCache();
    return json(res, res.ok ? 200 : 400);
  }

  return json({ ok: false, msg: `Unknown API route: ${path}` }, 404);
}

// Proves the Google connection works: counts task rows in the FMS tab and reports the last Task-ID.
async function health(env) {
  const rows = await readRange(env, "'Video Tracker-FMS'!A9:A");
  const ids = rows.map((r) => String(r[0] ?? '').trim()).filter((v) => /^TSK-\d+$/i.test(v));
  return { ok: true, rows: ids.length, lastTaskId: ids.at(-1) || null };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
