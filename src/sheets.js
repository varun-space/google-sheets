// Google Sheets access with no libraries: sign a service-account JWT (RS256) with WebCrypto,
// swap it for an access token, then call the Sheets REST API with fetch. See CLAUDE.md §3.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Token cache lives as long as the Worker isolate; refreshed ~5 min before Google's 1 h expiry.
let cached = { token: null, exp: 0 };

function parseKey(env) {
  if (!env.GOOGLE_SA_KEY) throw new Error('GOOGLE_SA_KEY is not set (check .dev.vars).');
  let key;
  try { key = JSON.parse(env.GOOGLE_SA_KEY); }
  catch { throw new Error('GOOGLE_SA_KEY is not valid JSON — it must be the whole service-account file on ONE line.'); }
  if (!key.client_email || !key.private_key) throw new Error('GOOGLE_SA_KEY is missing client_email or private_key.');
  return key;
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function importPrivateKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

export async function getToken(env) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cached.token && nowSec < cached.exp - 300) return cached.token;

  const key = parseKey(env);
  const unsigned = b64urlJson({ alg: 'RS256', typ: 'JWT' }) + '.' + b64urlJson({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  });

  let signKey;
  try { signKey = await importPrivateKey(key.private_key); }
  catch { throw new Error('Could not read private_key from GOOGLE_SA_KEY — is the key copied completely?'); }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signKey, new TextEncoder().encode(unsigned));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + b64url(sig),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google sign-in failed (${res.status}): ${data.error_description || data.error || 'unknown error'}. ` +
      'Check that the service-account key is current and not deleted.');
  }
  cached = { token: data.access_token, exp: nowSec + (data.expires_in || 3600) };
  return cached.token;
}

// One wrapper for every Sheets call so errors always carry Google's own message.
async function call(env, path, init = {}) {
  const token = await getToken(env);
  const res = await fetch(`${API}/${env.SHEET_ID}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || res.statusText;
    if (/protected cell/i.test(msg)) {
      // Sheet protections block the service account even though it is an Editor on the file.
      const where = rangeOf(path, init.body);
      throw new Error(`The sheet is protected${where ? ` at ${where}` : ''}. In Google Sheets → Data → Protect sheets and ranges, ` +
        `add ${safeEmail(env)} as an editor of that protection.`);
    }
    const hint = res.status === 403 || res.status === 404
      ? ` — is the sheet shared (Editor) with ${safeEmail(env)}?` : '';
    throw new Error(`Google Sheets error (${res.status}): ${msg}${hint}`);
  }
  return data;
}

/** Best-effort A1 range of a failed write, for error messages. */
function rangeOf(path, body) {
  const m = /\/values\/([^?:]+)/.exec(path);
  if (m) return decodeURIComponent(m[1]);
  try { return JSON.parse(body).data.map((d) => d.range).join(', '); } catch { return ''; }
}

function safeEmail(env) {
  try { return parseKey(env).client_email; } catch { return 'the service account'; }
}

const READ_OPTS = 'valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';

/** Read one A1 range, e.g. "'Video Tracker-FMS'!A9:A". Returns rows (array of arrays). */
export async function readRange(env, range) {
  const data = await call(env, `/values/${encodeURIComponent(range)}?${READ_OPTS}`);
  return data.values || [];
}

/** Read several ranges in one request. Returns an array of row-arrays in the same order. */
export async function readRanges(env, ranges) {
  const qs = ranges.map((r) => 'ranges=' + encodeURIComponent(r)).join('&');
  const data = await call(env, `/values:batchGet?${qs}&${READ_OPTS}`);
  return (data.valueRanges || []).map((v) => v.values || []);
}

/** Overwrite a range with RAW values (no formula parsing). */
export async function writeRange(env, range, values) {
  return call(env, `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
}

/** Several RAW writes in one request — all land together or none do. data = [{range, values}]. */
export async function writeRanges(env, data) {
  return call(env, '/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
}

/** Append rows after the last row of a table range. */
export async function appendRows(env, range, values) {
  return call(env, `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values }),
  });
}

/** Spreadsheet metadata (tab names etc.) and structural edits like addSheet. */
export const getMeta = (env) => call(env, '?fields=sheets.properties');
export const batchUpdate = (env, requests) =>
  call(env, ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
