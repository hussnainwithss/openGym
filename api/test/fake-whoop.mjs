/* A pretend WHOOP for the tests: the OAuth token endpoint (with WHOOP's rotating refresh tokens),
 * the profile, the paginated collections, the by-id reads and the body measurement. Nothing
 * leaves the machine. Switches on the returned object script refusals, delays and limits. */
import { TOKEN_URL, API_BASE } from '../integrations/providers/whoop.js';

export const CLIENT = { WHOOP_CLIENT_ID: 'wid', WHOOP_CLIENT_SECRET: 'wsecret' };
export const ENV = { INTEGRATIONS: 'whoop', ...CLIENT };

const headers = (h = {}) => ({ get: k => h[String(k).toLowerCase()] ?? null });

export function fakeWhoop({ userId = 4242 } = {}) {
  const w = {
    userId,
    calls: [],
    codes: new Map([['good', true]]),
    refresh: new Map(),       // refresh token -> live?
    access: new Set(),
    n: 0,
    // Collections: arrays of records as WHOOP returns them.
    cycle: [], recovery: [], sleep: [], workout: [],
    body: { height_meter: 1.8, weight_kilogram: 80, max_heart_rate: 195 },
    // Scripting: hold the token endpoint, fail a page, answer 429, throw after consuming a refresh.
    holdToken: null,          // a promise the token endpoint waits on
    failPage: null,           // (collection, pageIndex) -> status | null
    limited: 0,               // answer this many requests with 429 first
    resetSec: 60,
    throwAfterRefresh: false, // consume the refresh token, then fail as if the reply was lost
    notSentOnce: false,       // fail one request as if it never left (DNS)
    pageSize: null,           // force a smaller page than asked
  };
  const reply = (status, data, h) => ({ status, json: async () => data, headers: headers(h) });
  const tokenPair = () => {
    const a = 'a' + (++w.n), r = 'r' + w.n;
    w.access.add(a); w.refresh.set(r, true);
    return { access_token: a, refresh_token: r, expires_in: 3600, token_type: 'bearer', scope: 'offline read:recovery' };
  };
  const byStart = (a, b) => String(b.start || b.created_at).localeCompare(String(a.start || a.created_at));
  const when = r => r.start || r.created_at;

  w.fetchFn = async (url, { method = 'GET', headers: h = {}, body } = {}) => {
    if (w.notSentOnce) { w.notSentOnce = false; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }
    const u = new URL(url);
    const auth = (h.Authorization || '').replace('Bearer ', '');
    w.calls.push({ url, method, auth, form: body ? Object.fromEntries(new URLSearchParams(body)) : null });
    if (w.limited > 0) { w.limited--; return reply(429, { message: 'Too Many Requests' }, { 'x-ratelimit-reset': String(w.resetSec), 'retry-after': String(w.resetSec) }); }
    if (url === TOKEN_URL) {
      const f = Object.fromEntries(new URLSearchParams(body));
      if (f.client_id !== 'wid' || f.client_secret !== 'wsecret') return reply(401, { error: 'invalid_client' });
      if (w.holdToken) await w.holdToken;
      if (f.grant_type === 'authorization_code') {
        if (!w.codes.has(f.code)) return reply(400, { error: 'invalid_grant' });
        return reply(200, tokenPair());
      }
      if (f.grant_type === 'refresh_token') {
        if (!w.refresh.get(f.refresh_token)) return reply(400, { error: 'invalid_grant' });
        w.refresh.set(f.refresh_token, false);   // rotated: the old one is void now
        const pair = tokenPair();
        if (w.throwAfterRefresh) { w.throwAfterRefresh = false; throw Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } }); }
        return reply(200, pair);
      }
      return reply(400, { error: 'unsupported_grant_type' });
    }
    if (!url.startsWith(API_BASE)) return reply(404, {});
    if (!w.access.has(auth)) return reply(401, { message: 'Unauthorized' });
    const p = u.pathname.replace(new URL(API_BASE).pathname, '');
    if (p === '/v2/user/profile/basic') return reply(200, { user_id: w.userId, email: 'x@example.com', first_name: 'Ana', last_name: 'Lift' });
    if (p === '/v2/user/measurement/body') return reply(200, w.body);
    const coll = { '/v2/cycle': 'cycle', '/v2/recovery': 'recovery', '/v2/activity/sleep': 'sleep', '/v2/activity/workout': 'workout' }[p];
    if (coll) {
      const limit = Math.min(Number(u.searchParams.get('limit')) || 10, 25, w.pageSize || 25);
      const start = u.searchParams.get('start'), end = u.searchParams.get('end');
      const rows = w[coll].filter(r => (!start || when(r) >= start) && (!end || when(r) < end)).sort(byStart);
      const from = Number(u.searchParams.get('nextToken') || 0);
      const page = Math.floor(from / limit);
      const fail = w.failPage?.(coll, page);
      if (fail) return reply(fail, {});
      const records = rows.slice(from, from + limit);
      return reply(200, { records, ...(from + limit < rows.length ? { next_token: String(from + limit) } : {}) });
    }
    let m;
    if ((m = /^\/v2\/activity\/(sleep|workout)\/([0-9a-f-]{36})$/.exec(p))) {
      const r = w[m[1]].find(x => x.id === m[2]);
      return r ? reply(200, r) : reply(404, {});
    }
    if ((m = /^\/v2\/cycle\/(\d+)\/recovery$/.exec(p))) {
      const r = w.recovery.find(x => String(x.cycle_id) === m[1]);
      return r ? reply(200, r) : reply(404, {});
    }
    if ((m = /^\/v2\/cycle\/(\d+)$/.exec(p))) {
      const r = w.cycle.find(x => String(x.id) === m[1]);
      return r ? reply(200, r) : reply(404, {});
    }
    return reply(404, {});
  };
  return w;
}

let seq = 0;
const uuid = () => {
  const h = (++seq).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
};
const iso = ms => new Date(ms).toISOString();

/** Record builders in WHOOP v2's shape. */
export const rec = {
  workout: ({ id = uuid(), start, end, sport = 'running', offset = '+00:00', state = 'SCORED', strain = 8.2, km = 5 } = {}) => ({
    id, v1_id: 1, user_id: 4242, created_at: iso(end), updated_at: iso(end), start: iso(start), end: iso(end), timezone_offset: offset,
    sport_name: sport, sport_id: 0, score_state: state,
    ...(state === 'SCORED' ? { score: { strain, average_heart_rate: 140, max_heart_rate: 172, kilojoule: 1500, percent_recorded: 100, distance_meter: km * 1000, altitude_gain_meter: 10, altitude_change_meter: 0, zone_durations: {} } } : {}),
  }),
  sleep: ({ id = uuid(), cycle, start, end, nap = false, offset = '+00:00', state = 'SCORED', asleepMin = 420 } = {}) => ({
    id, cycle_id: cycle, v1_id: 1, user_id: 4242, created_at: iso(end), updated_at: iso(end), start: iso(start), end: iso(end), timezone_offset: offset, nap, score_state: state,
    ...(state === 'SCORED' ? { score: { stage_summary: { total_in_bed_time_milli: (asleepMin + 30) * 60000, total_awake_time_milli: 30 * 60000, total_no_data_time_milli: 0, total_light_sleep_time_milli: asleepMin * 30000, total_slow_wave_sleep_time_milli: asleepMin * 15000, total_rem_sleep_time_milli: asleepMin * 15000, sleep_cycle_count: 4, disturbance_count: 3 }, sleep_needed: {}, respiratory_rate: 15, sleep_performance_percentage: 90, sleep_consistency_percentage: 80, sleep_efficiency_percentage: 92 } } : {}),
  }),
  recovery: ({ cycle, sleep, at, state = 'SCORED', score = 66 } = {}) => ({
    cycle_id: cycle, sleep_id: sleep, user_id: 4242, created_at: iso(at), updated_at: iso(at), score_state: state,
    ...(state === 'SCORED' ? { score: { user_calibrating: false, recovery_score: score, resting_heart_rate: 52, hrv_rmssd_milli: 61.5, spo2_percentage: 96.4, skin_temp_celsius: 33.7 } } : {}),
  }),
  cycle: ({ id, start, end = null, offset = '+00:00', state = 'SCORED', strain = 12.4 } = {}) => ({
    id, user_id: 4242, created_at: iso(start), updated_at: iso(start), start: iso(start), ...(end ? { end: iso(end) } : {}), timezone_offset: offset, score_state: state,
    ...(state === 'SCORED' ? { score: { strain, kilojoule: 9000, average_heart_rate: 70, max_heart_rate: 170 } } : {}),
  }),
};
