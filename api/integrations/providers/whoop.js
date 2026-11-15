/* WHOOP (fork): the server pulls a person's WHOOP data (workouts, sleep, recovery, cycles, body
 * weight) with the WHOOP app its admin registered on https://developer.whoop.com. Read only:
 * nothing is sent to WHOOP.
 *
 * Off unless the admin sets INTEGRATIONS=whoop (beside any others) and WHOOP_CLIENT_ID /
 * WHOOP_CLIENT_SECRET, with the app's redirect URL set to ORIGIN + /api/integrations/oauth/callback.
 *
 * WHOOP's OAuth differs from Strava's in two ways the hub has to know about:
 *   - the `state` must be exactly 8 characters (stateLen), so the hub keeps it server-side
 *   - every refresh rotates the refresh token and voids the old one, so refreshes must never
 *     overlap and the new pair is stored before it is used (whoop/client.js)
 *
 * `fetchFn` is the network, injectable for the tests: (url, { method, headers, body, signal }) →
 * { status, json(), headers }. */

export const AUTHORIZE_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
export const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
export const API_BASE = 'https://api.prod.whoop.com/developer';
export const SCOPES = ['read:recovery', 'read:cycles', 'read:workout', 'read:sleep', 'read:profile', 'read:body_measurement', 'offline'];
export const TIMEOUT_MS = 15_000;
// WHOOP's default limits are 100 requests a minute and 10,000 a day per app; whoop/client.js
// counts every request against these, across every person on the server.
export const RATE = { capacity: 60, refillMs: 1000 };

const form = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');

/** One request with a timeout. `sent` tells a failure before the request left (DNS, refused
 *  connection) from one after: only the first is safe to repeat for a token refresh. */
export async function request(fetchFn, url, { method = 'GET', headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  tm.unref?.();
  const t0 = Date.now();
  try {
    const r = await fetchFn(url, { method, headers: { Accept: 'application/json', ...headers }, body, signal: ctrl.signal });
    let data = null;
    try { data = await r.json(); } catch { /* no body */ }
    const h = r.headers && typeof r.headers.get === 'function' ? r.headers : { get: () => null };
    return { status: r.status, data, headers: h, ms: Date.now() - t0 };
  } catch (e) {
    throw Object.assign(new Error('network'), { network: true, sent: !notSent(e) });
  } finally { clearTimeout(tm); }
}
// Errors that mean the request never reached WHOOP.
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);
const notSent = e => NOT_SENT.has(e?.cause?.code) || NOT_SENT.has(e?.code);

export function whoopProvider({ env = process.env, fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const clientId = String(env.WHOOP_CLIENT_ID || '').trim();
  const clientSecret = String(env.WHOOP_CLIENT_SECRET || '').trim();

  /** Tokens from WHOOP's answer, or null. WHOOP always sends a new refresh token with `offline`. */
  const tokensFrom = r => {
    if (r.status !== 200 || typeof r.data?.access_token !== 'string' || typeof r.data?.refresh_token !== 'string') return null;
    const exp = Number(r.data.expires_in);
    return { access: r.data.access_token, refresh: r.data.refresh_token, expiresAt: now() + (Number.isFinite(exp) && exp > 0 ? exp * 1000 : 3600_000) };
  };

  return {
    id: 'whoop',
    kind: 'oauth',
    category: 'health',
    events: [],
    env: ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET'],
    configured: e => !!String(e.WHOOP_CLIENT_ID || '').trim() && !!String(e.WHOOP_CLIENT_SECRET || '').trim(),
    max: 1,
    rate: RATE,
    stateLen: 8,
    clientSecret,
    fetchFn,

    authorizeUrl({ state, redirectUri }) {
      const u = new URL(AUTHORIZE_URL);
      u.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES.join(' '), state }).toString();
      return u.toString();
    },

    /** The callback's code for tokens, and who the WHOOP account is.
     *  → { label, info, secrets, events } or throws { status, code, message }. */
    async callback(query, { redirectUri } = {}) {
      const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
      if (query.error) fail(400, 'denied', 'WHOOP was not given access.');
      if (!query.code) fail(400, 'code', 'WHOOP sent no code back.');
      let r;
      try {
        r = await request(fetchFn, TOKEN_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form({ client_id: clientId, client_secret: clientSecret, code: String(query.code).slice(0, 512), grant_type: 'authorization_code', ...(redirectUri ? { redirect_uri: redirectUri } : {}) }),
        });
      } catch { fail(502, 'network', 'Could not reach WHOOP.'); }
      const tok = tokensFrom(r);
      if (!tok) fail(502, 'exchange', `WHOOP did not hand over the sign-in (${r.status}).`);
      let p;
      try { p = await request(fetchFn, API_BASE + '/v2/user/profile/basic', { headers: { Authorization: 'Bearer ' + tok.access } }); }
      catch { fail(502, 'network', 'Could not reach WHOOP.'); }
      const uid = p.data?.user_id;
      if (p.status !== 200 || !Number.isSafeInteger(uid) || uid <= 0) fail(502, 'profile', `WHOOP did not say whose account this is (${p.status}).`);
      const who = [p.data.first_name, p.data.last_name].filter(v => typeof v === 'string').join(' ').trim() || 'WHOOP ' + uid;
      return {
        label: who.slice(0, 60),
        events: [],
        info: { whoopUser: String(uid) },
        secrets: { access: tok.access, refresh: tok.refresh, expires: String(tok.expiresAt) },
      };
    },

    connect() { throw Object.assign(new Error('connect WHOOP through its sign-in'), { status: 400, code: 'oauth' }); },

    /** Pause, and the default for WHOOP strength sessions that overlap a logged workout lives in
     *  the profile (S.whoopStrength), not here. */
    update(input) {
      const patch = {};
      if (typeof input.paused === 'boolean') patch.paused = input.paused;
      return patch;
    },

    tokensFrom,
    tokenUrl: TOKEN_URL,
    tokenBody: refreshToken => form({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'offline' }),

    /** WHOOP has no outbound events; "Check connection" goes through the hub's token gate. */
    async deliver() { return { ok: false, retry: false, code: 'pull', msg: 'WHOOP only pulls.' }; },
  };
}
