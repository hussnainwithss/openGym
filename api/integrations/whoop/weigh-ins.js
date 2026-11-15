/* WHOOP's weight into the profile's weigh-ins (fork, whoop-bodyweight).
 *
 * WHOOP's body measurement is one undated value. When it changes, whoop/sync.js stores an
 * observation in the WHOOP store first: { id, kg, observedAt, day, hhmm }, its day and time fixed
 * then, in the person's zone. This projection adds it to S.bodyweight as a reading with
 * src 'whoop', and records its id in S.whoopSeen (written only by the server) in the same profile
 * write. An id already seen is never added again, so a reading the person deleted (or its whole
 * day, or everything with Reset) does not come back when an observation is replayed after a crash.
 *
 * The day rules are a hand copy of frontend/src/lib/weigh-ins.js (readingsOf, dailyValue,
 * stampOf, absorbLegacyEdit, settleDay, the readings form), as the "code that exists twice" table
 * in docs/ARCHITECTURE.md asks; frontend/src/lib/weigh-ins-parity.test.js holds them together.
 * One difference on purpose: the server's clock is not the person's, so a time of day is read in
 * the person's zone (`off`, minutes east of UTC) instead of the machine's. */
import crypto from 'node:crypto';

const DAILY_MODES = ['first', 'avg', 'last'];
const LEGACY_ID = '0';
const KG_LB = 2.20462262;
// WHOOP ids already in the profile, kept to the newest of these.
export const SEEN_MAX = 400;

const list = v => (Array.isArray(v) ? v : []);
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = v => Number(v) || 0;
const round1 = n => Math.round(Number(n) * 10) / 10;
const round2 = n => Math.round(Number(n) * 100) / 100;
const p2 = n => String(n).padStart(2, '0');

export const dailyModeOf = S => (DAILY_MODES.includes(S?.bwDaily) ? S.bwDaily : 'first');
/** Day and time of `ms` at `off` minutes east of UTC. */
export const dayAt = (ms, off) => { const x = new Date(ms + off * 60_000); return `${x.getUTCFullYear()}-${p2(x.getUTCMonth() + 1)}-${p2(x.getUTCDate())}`; };
export const timeAt = (ms, off) => { const x = new Date(ms + off * 60_000); return `${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}`; };
export function cleanTime(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${p2(+m[1])}:${m[2]}`;
}
/** The id of a WHOOP weight observation: the same for the same account and moment, anywhere. */
export const observationId = (whoopUser, observedAt) => 'wh' + crypto.createHash('sha256').update(`${whoopUser}|${observedAt}`).digest('base64url').slice(0, 16);

const byTime = (a, b) => { const x = a.at || '', y = b.at || ''; return x < y ? -1 : x > y ? 1 : num(a.t) - num(b.t); };
function cleanReading(r) {
  if (!isMap(r) || r.id == null || !(Number(r.w) > 0)) return null;
  const out = { ...r, id: String(r.id), at: cleanTime(r.at), w: Number(r.w) };
  if (out.t != null) out.t = num(out.t);
  return out;
}
export function readingsOf(e, off) {
  if (!isMap(e)) return [];
  if (Array.isArray(e.ins)) return e.ins.map(cleanReading).filter(Boolean).sort(byTime);
  if (!(Number(e.w) > 0)) return [];
  const t = num(e.t);
  const r = { id: LEGACY_ID, at: t > 0 && dayAt(t, off) === e.d ? timeAt(t, off) : null, w: Number(e.w), t };
  if (e.src) r.src = e.src;
  return [r];
}
/** The readings the daily value is read from: on a day with a WHOOP reading, a reading typed in
 *  (no `src`) wins over every read-in one (D11); any other day, all of them. */
export function eligible(readings) {
  const rs = list(readings).filter(r => Number(r?.w) > 0);
  if (rs.some(r => r.src === 'whoop') && rs.some(r => !r.src)) return rs.filter(r => !r.src);
  return rs;
}
export function dailyValue(readings, mode = 'first') {
  const rs = eligible(readings);
  if (!rs.length) return null;
  if (mode === 'last') return Number(rs[rs.length - 1].w);
  if (mode === 'avg') return round2(rs.reduce((s, r) => s + Number(r.w), 0) / rs.length);
  return Number(rs[0].w);
}
export function stampOf(e) {
  let m = 0;
  for (const r of list(e?.ins)) m = Math.max(m, num(r?.t));
  if (isMap(e?.gone)) for (const v of Object.values(e.gone)) m = Math.max(m, num(v));
  return m;
}
export function absorbLegacyEdit(e, mode = 'first', off = 0) {
  if (!isMap(e) || !Array.isArray(e.ins) || !e.ins.length) return e;
  const st = stampOf(e), t = num(e.t);
  if (t === st || !(Number(e.w) > 0)) return e;
  const rs = readingsOf(e, off);
  if (!rs.length || Number(e.w) === dailyValue(rs, mode)) return e;
  const from = eligible(rs);
  const pick = mode === 'last' ? from[from.length - 1] : from[0];
  const r = e.ins.find(x => String(x?.id) === pick.id);
  if (!r) return e;
  r.w = round1(e.w);
  r.t = Math.max(t, st + 1);
  if (e.src) r.src = e.src; else delete r.src;
  e.t = r.t;
  return e;
}
export function settleDay(e, mode = 'first', { absorb = true, off = 0 } = {}) {
  if (!isMap(e)) return null;
  if (!Array.isArray(e.ins)) return Number(e.w) > 0 ? e : null;
  if (absorb) absorbLegacyEdit(e, mode, off);
  const gone = isMap(e.gone) ? e.gone : {};
  const rs = e.ins.map(cleanReading).filter(r => r && !(num(gone[r.id]) > 0 && num(gone[r.id]) >= num(r.t))).sort(byTime);
  const seen = new Map();
  for (const r of rs) { const cur = seen.get(r.id); if (!cur || num(r.t) > num(cur.t)) seen.set(r.id, r); }
  e.ins = [...seen.values()].sort(byTime);
  if (!e.ins.length) return null;
  if (isMap(e.gone)) {
    for (const k of Object.keys(e.gone)) if (!(num(e.gone[k]) > 0)) delete e.gone[k];
    if (!Object.keys(e.gone).length) delete e.gone;
  }
  e.w = dailyValue(e.ins, mode);
  e.t = Math.max(stampOf(e), e.ins.some(r => r.t == null) ? num(e.t) : 0);
  if (e.ins.every(r => r.src)) e.src = e.ins[0].src; else delete e.src;
  return e;
}

/** A WHOOP reading into S.bodyweight (mutated). Never replaces a reading already there (its id
 *  in the day, or removed from it). → true when added. */
export function addWhoopReading(S, { d, at, w, t, id }, mode, off) {
  const n = round1(w);
  if (!(n > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return false;
  if (!Array.isArray(S.bodyweight)) S.bodyweight = [];
  const r = { id: String(id), at: cleanTime(at), w: n, t: num(t), src: 'whoop' };
  let day = S.bodyweight.find(b => b && b.d === d);
  if (!day) {
    day = { d, w: n, t: r.t, ins: [r] };
    S.bodyweight.push(day);
  } else {
    absorbLegacyEdit(day, mode, off);
    if (!Array.isArray(day.ins)) { day.ins = readingsOf(day, off); delete day.src; }
    if (day.ins.some(x => x && String(x.id) === r.id) || (isMap(day.gone) && day.gone[r.id] != null)) return false;
    day.ins.push(r);
    day.t = Math.max(num(day.t), r.t);
  }
  settleDay(day, mode, { absorb: false, off });
  S.bodyweight.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return true;
}

/** The whoop-bodyweight projector: pending WHOOP weight observations into S.bodyweight.
 *  `ctx.acked` collects the ids now in the profile, for whoop/sync.js to drop from the store
 *  once this write is saved. → whether S changed. */
export function projectWeight(S, doc, t, ctx = {}) {
  const obs = list(doc.obs);
  if (!obs.length) return false;
  const seen = isMap(S.whoopSeen) ? { ...S.whoopSeen } : {};
  const mode = dailyModeOf(S);
  let changed = false;
  for (const o of obs) {
    (ctx.acked ||= []).push(o.id);
    if (seen[o.id] != null) continue;
    seen[o.id] = t;
    changed = true;
    // A day the person deleted after this weight was observed stays deleted.
    const del = num(S.deleted?.bodyweight?.[o.day]);
    if (del > num(o.observedAt)) continue;
    const w = S.unit === 'lb' ? o.kg * KG_LB : o.kg;
    addWhoopReading(S, { d: o.day, at: o.hhmm, w, t, id: o.id }, mode, num(o.off));
  }
  if (!changed) return false;
  const keep = Object.entries(seen).sort((a, b) => num(b[1]) - num(a[1])).slice(0, SEEN_MAX);
  S.whoopSeen = Object.fromEntries(keep);
  return true;
}
