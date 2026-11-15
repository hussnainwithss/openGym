/* The one way the server talks to WHOOP for a connection: every request for that connection runs
 * through a per-connection gate, so a poll, a webhook and "Check the connection" never refresh
 * the token at the same time. WHOOP voids the old refresh token on every refresh; two refreshes
 * in flight would end the connection.
 *
 * Inside the gate the current record is read from the store (never one read before waiting), so
 * a request queued behind a refresh uses the token that refresh stored. A refreshed pair is
 * written to disk before it is used: a crash after WHOOP rotated the token but before the new
 * one was saved would otherwise leave the connection with a void token.
 *
 * Refresh failures, by what they prove:
 *   400 / 401 from the token endpoint   WHOOP refused the sign-in: attention, Reconnect
 *   429 / 5xx                           nothing rotated: keep the tokens, try again later
 *   failed before the request was sent  nothing rotated: keep the tokens, try again later
 *   failed after it was sent            WHOOP may have rotated: attention, never spend it again
 *
 * Every request also counts against WHOOP's per-app limits (100 a minute, 10,000 a day), across
 * every person on the server; a 429 blocks every caller until WHOOP's reset time. */
import { API_BASE, request } from '../providers/whoop.js';

export const REFRESH_EARLY_MS = 120_000;
export const MINUTE_MAX = 90;
export const DAY_MAX = 9500;

export class WhoopError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export function createWhoopClient({ provider, store, now = Date.now, fetchFn = provider.fetchFn }) {
  const gates = new Map();   // uid:connId -> tail promise
  let blockedUntil = 0;
  const minute = { start: 0, n: 0 };
  const day = { start: 0, n: 0 };

  /** Runs `fn` with this connection's gate held. */
  function withGate(uid, connId, fn) {
    const key = uid + ':' + connId;
    const prev = gates.get(key) || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    const tail = run.then(() => {}, () => {});
    gates.set(key, tail);
    tail.then(() => { if (gates.get(key) === tail) gates.delete(key); });
    return run;
  }

  /** One request's place in the app-wide budget, or a WhoopError('rate') with how long to wait. */
  function spend() {
    const t = now();
    if (t < blockedUntil) throw new WhoopError('rate', 'WHOOP asked to slow down.', { retryAt: blockedUntil });
    if (t - minute.start >= 60_000) { minute.start = t; minute.n = 0; }
    if (t - day.start >= 86_400_000) { day.start = t; day.n = 0; }
    if (minute.n >= MINUTE_MAX) throw new WhoopError('rate', 'Pacing requests to WHOOP.', { retryAt: minute.start + 60_000 });
    if (day.n >= DAY_MAX) throw new WhoopError('rate', 'WHOOP’s daily limit is used up.', { retryAt: day.start + 86_400_000 });
    minute.n++; day.n++;
  }
  // WHOOP says when its window resets: Retry-After or X-RateLimit-Reset, in seconds from now.
  function block(headers) {
    const secs = [headers.get('retry-after'), headers.get('x-ratelimit-reset')].map(Number).find(n => Number.isFinite(n) && n > 0);
    blockedUntil = Math.max(blockedUntil, now() + (secs ? secs * 1000 : 60_000));
  }

  function attention(uid, connId, code, msg, { pause = false } = {}) {
    store.update(uid, connId, r => {
      r.status = 'attention';
      r.failures = (r.failures || 0) + 1;
      r.lastError = { at: now(), msg, code };
      if (pause) r.paused = true;
    });
  }

  /** A fresh access token for the connection, refreshing first when it is about to expire.
   *  Called with the gate held. */
  async function token(uid, connId, { force = false } = {}) {
    const rec = store.get(uid, connId);
    if (!rec) throw new WhoopError('gone', 'Disconnected.');
    const access = store.reveal(uid, rec, 'access');
    const exp = Number(store.reveal(uid, rec, 'expires')) || 0;
    if (access && !force && exp - now() > REFRESH_EARLY_MS) return access;
    // A sign-in WHOOP refused, or whose refresh answer was lost, is not tried again: only
    // Reconnect (a new connection record) clears it.
    if (rec.status === 'attention' && ['reconnect', 'lost'].includes(rec.lastError?.code)) throw new WhoopError('reconnect', 'Reconnect WHOOP.', { already: true });
    const rt = store.reveal(uid, rec, 'refresh');
    if (!rt) { attention(uid, connId, 'reconnect', 'Reconnect WHOOP: its sign-in is gone.', { pause: true }); throw new WhoopError('reconnect', 'Reconnect WHOOP.'); }
    spend();
    let r;
    try {
      r = await request(fetchFn, provider.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: provider.tokenBody(rt) });
    } catch (e) {
      if (e.sent) {
        attention(uid, connId, 'lost', 'The answer to a sign-in refresh was lost on the way. Reconnect WHOOP.', { pause: true });
        throw new WhoopError('reconnect', 'Reconnect WHOOP.');
      }
      throw new WhoopError('network', 'Could not reach WHOOP.', { retry: true });
    }
    if (r.status === 429) { block(r.headers); throw new WhoopError('rate', 'WHOOP asked to slow down.', { retryAt: blockedUntil }); }
    if (r.status >= 500) throw new WhoopError('http', `WHOOP answered ${r.status} to the sign-in refresh.`, { retry: true });
    const tok = provider.tokensFrom(r);
    if (!tok) {
      attention(uid, connId, 'reconnect', 'Reconnect WHOOP: it no longer accepts this sign-in.', { pause: true });
      throw new WhoopError('reconnect', 'Reconnect WHOOP.');
    }
    // Stored (on disk) before the new token is used. If that fails, the rotated pair is lost:
    // say so instead of using a token nothing remembers.
    try {
      const saved = store.update(uid, connId, x => {
        x.secrets.access = store.seal(uid, connId, 'access', tok.access);
        x.secrets.refresh = store.seal(uid, connId, 'refresh', tok.refresh);
        x.secrets.expires = store.seal(uid, connId, 'expires', String(tok.expiresAt));
      });
      if (!saved) throw new WhoopError('gone', 'Disconnected.');
    } catch (e) {
      if (e instanceof WhoopError) throw e;
      console.error('whoop: could not store a refreshed sign-in', e.message);
      try { attention(uid, connId, 'reconnect', 'The refreshed sign-in could not be saved. Reconnect WHOOP.', { pause: true }); } catch { /* the store is failing */ }
      throw new WhoopError('reconnect', 'Reconnect WHOOP.');
    }
    return tok.access;
  }

  /** GET a WHOOP API path with the gate held: refreshes when needed, and once more on a 401. */
  async function get(uid, connId, pathname, params = {}) {
    const url = new URL(API_BASE + pathname);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    let tok = await token(uid, connId);
    for (let attempt = 0; ; attempt++) {
      spend();
      let r;
      try { r = await request(fetchFn, url.toString(), { headers: { Authorization: 'Bearer ' + tok } }); }
      catch { throw new WhoopError('network', 'Could not reach WHOOP.', { retry: true }); }
      if (r.status === 401 && attempt === 0) { tok = await token(uid, connId, { force: true }); continue; }
      if (r.status === 429) { block(r.headers); throw new WhoopError('rate', 'WHOOP asked to slow down.', { retryAt: blockedUntil }); }
      if (r.status === 401 || r.status === 403) {
        attention(uid, connId, 'reconnect', 'Reconnect WHOOP: it no longer lets openGym read your data.', { pause: true });
        throw new WhoopError('reconnect', 'Reconnect WHOOP.');
      }
      if (r.status >= 500) throw new WhoopError('http', `WHOOP answered ${r.status}.`, { retry: true, status: r.status });
      return { status: r.status, data: r.data };
    }
  }

  return {
    withGate,
    get,
    /** "Check the connection": reads the profile, refreshing the sign-in if it needs to. */
    check(uid, connId) {
      return withGate(uid, connId, async () => {
        try {
          const r = await get(uid, connId, '/v2/user/profile/basic');
          if (r.status !== 200) return { ok: false, retry: false, status: r.status, code: 'http', msg: `WHOOP answered ${r.status}.` };
          return { ok: true, status: 200 };
        } catch (e) {
          if (!(e instanceof WhoopError)) throw e;
          return { ok: false, retry: !!e.retry || e.code === 'rate', code: e.code, msg: e.message, already: e.code === 'reconnect' };
        }
      });
    },
    blockedUntil: () => blockedUntil,
  };
}
