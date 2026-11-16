// Login + session cookie. The cookie is base64url(JSON {role, name, exp}) + "." + HMAC-SHA256 signature,
// so the server can trust it without a database. Doers pick their own name (trust-based for now, no PINs).

const COOKIE = 'sw_session';
const TTL_MS = 12 * 3600 * 1000;
const enc = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

async function hmac(secret, msg) {
  if (!secret) throw new Error('SESSION_SECRET is not set (check .dev.vars).');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

/** Compare two strings without leaking where they differ (compare their HMACs). */
async function safeEqual(a, b, secret) {
  const [x, y] = await Promise.all([hmac(secret, 'cmp:' + a), hmac(secret, 'cmp:' + b)]);
  return x === y;
}

function cookieAttrs(request) {
  // Browsers drop "Secure" cookies on plain-http dev hosts in some setups; only add it over https.
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `HttpOnly; SameSite=Lax; Path=/${secure}`;
}

export async function makeSessionCookie(request, env, { role, name }) {
  const body = b64url(enc.encode(JSON.stringify({ role, name, exp: Date.now() + TTL_MS })));
  const sig = await hmac(env.SESSION_SECRET, body);
  return `${COOKIE}=${body}.${sig}; Max-Age=${TTL_MS / 1000}; ${cookieAttrs(request)}`;
}

export const clearSessionCookie = (request) => `${COOKIE}=; Max-Age=0; ${cookieAttrs(request)}`;

/** Returns {role, name} or null. */
export async function readSession(request, env) {
  const raw = (request.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [body, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !sig) return null;
  if (sig !== (await hmac(env.SESSION_SECRET, body))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(Uint8Array.from(fromB64url(body), (c) => c.charCodeAt(0))));
    if (!s.exp || s.exp < Date.now()) return null;
    if (s.role !== 'admin' && s.role !== 'doer') return null;
    return { role: s.role, name: s.name };
  } catch {
    return null;
  }
}

/**
 * Checks a login attempt. body = {name} for a doer, or {name: "__admin", password}.
 * Returns {ok, session} or {ok:false, msg}. Wrong admin passwords are slowed down to blunt guessing.
 */
export async function checkLogin(env, body, editors) {
  const name = String(body?.name ?? '').trim();
  if (name === '__admin') {
    if (!env.ADMIN_PASSWORD) return { ok: false, msg: 'ADMIN_PASSWORD is not set on the server.' };
    if (await safeEqual(String(body.password ?? ''), env.ADMIN_PASSWORD, env.SESSION_SECRET)) {
      return { ok: true, session: { role: 'admin', name: 'Admin' } };
    }
    await new Promise((r) => setTimeout(r, 800));
    return { ok: false, msg: 'Wrong password.' };
  }
  if (!editors.includes(name)) return { ok: false, msg: 'Please pick your name from the list.' };
  return { ok: true, session: { role: 'doer', name } };
}
