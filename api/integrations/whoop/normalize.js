/* WHOOP replies, checked once on the way in. Everything past this file trusts the shapes below.
 * A record without a usable id or time is dropped; a field that is missing, not a finite number
 * or negative is left out while the record is kept; an unknown score_state counts as pending, so
 * it is asked for again and never taken as scored. Unknown extra fields are ignored. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = { SCORED: 'scored', PENDING_SCORE: 'pending', UNSCORABLE: 'unscorable' };
const MIN_T = Date.UTC(2010, 0, 1);

export const uuidOf = v => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null);
/** WHOOP's int64 ids, kept as decimal strings so a large one is never rounded. */
export function intId(v) {
  if (Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v)) return v;
  return null;
}
const timeOf = (v, now) => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t >= MIN_T && t <= now + 86_400_000 ? t : null;
};
/** "+05:30" / "-04:00" / "Z" → minutes east of UTC, or null. */
export function offsetOf(v) {
  if (v === 'Z' || v === '+00:00' || v === '-00:00') return 0;
  const m = typeof v === 'string' && /^([+-])(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const min = Number(m[2]) * 60 + Number(m[3]);
  return min > 14 * 60 ? null : (m[1] === '-' ? -min : min);
}
const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const stateOf = v => (typeof v === 'string' && Object.hasOwn(STATES, v) ? STATES[v] : 'pending');
// Drops undefined fields so stored records stay small and compare cleanly.
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function workout(r, now = Date.now()) {
  const id = uuidOf(r?.id), start = timeOf(r?.start, now), end = timeOf(r?.end, now);
  if (!id || start == null || end == null || end <= start) return null;
  const st = stateOf(r.score_state);
  const s = st === 'scored' && r.score && typeof r.score === 'object' ? r.score : {};
  return clean({
    id, start, end, off: offsetOf(r.timezone_offset) ?? 0,
    sport: typeof r.sport_name === 'string' ? r.sport_name.toLowerCase().slice(0, 60) : 'activity',
    st, strain: num(s.strain), hr: num(s.average_heart_rate), hrMax: num(s.max_heart_rate), kj: num(s.kilojoule),
    km: num(s.distance_meter) != null ? s.distance_meter / 1000 : undefined,
  });
}

export function sleep(r, now = Date.now()) {
  const id = uuidOf(r?.id), start = timeOf(r?.start, now), end = timeOf(r?.end, now);
  if (!id || start == null || end == null || end <= start) return null;
  const st = stateOf(r.score_state);
  const s = st === 'scored' && r.score && typeof r.score === 'object' ? r.score : {};
  const g = s.stage_summary && typeof s.stage_summary === 'object' ? s.stage_summary : {};
  const stages = [g.total_light_sleep_time_milli, g.total_slow_wave_sleep_time_milli, g.total_rem_sleep_time_milli].map(num);
  return clean({
    id, cycle: intId(r.cycle_id) ?? undefined, start, end, off: offsetOf(r.timezone_offset) ?? 0, nap: r.nap === true, st,
    // Asleep is light + deep + REM, not time in bed.
    asleepMin: stages.every(x => x != null) ? Math.round(stages.reduce((a, b) => a + b, 0) / 60000) : undefined,
    perf: num(s.sleep_performance_percentage), eff: num(s.sleep_efficiency_percentage), resp: num(s.respiratory_rate),
  });
}

export function recovery(r, now = Date.now()) {
  const cycle = intId(r?.cycle_id), sleepId = uuidOf(r?.sleep_id);
  if (!cycle) return null;
  const st = stateOf(r.score_state);
  const s = st === 'scored' && r.score && typeof r.score === 'object' ? r.score : {};
  return clean({
    cycle, sleep: sleepId ?? undefined, st, at: timeOf(r.updated_at, now) ?? undefined,
    rec: num(s.recovery_score), rhr: num(s.resting_heart_rate), hrv: num(s.hrv_rmssd_milli),
    spo2: num(s.spo2_percentage), skin: num(s.skin_temp_celsius),
  });
}

export function cycle(r, now = Date.now()) {
  const id = intId(r?.id), start = timeOf(r?.start, now);
  if (!id || start == null) return null;
  const end = timeOf(r.end, now);
  const st = stateOf(r.score_state);
  const s = st === 'scored' && r.score && typeof r.score === 'object' ? r.score : {};
  return clean({
    id, start, end: end != null && end > start ? end : undefined, off: offsetOf(r.timezone_offset) ?? 0, st,
    strain: num(s.strain), kj: num(s.kilojoule), hr: num(s.average_heart_rate), hrMax: num(s.max_heart_rate),
  });
}

/** Body measurement: one undated value. → { kg, heightM, maxHr } or null without a usable weight. */
export function body(r) {
  const kg = num(r?.weight_kilogram);
  if (kg == null || kg <= 0) return null;
  return clean({ kg, heightM: num(r.height_meter), maxHr: num(r.max_heart_rate) });
}

export const NORMALIZE = { workout, sleep, recovery, cycle };
/** The key a normalized record is stored under in its collection. */
export const keyOf = (coll, r) => (coll === 'recovery' ? r.cycle : r.id);
