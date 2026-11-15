/* WHOOP days (fork, whoop-vitals): the WHOOP store's sleeps, recoveries and cycles as one entry per
 * local date, for the Daily form and the WHOOP page.
 *
 * A day is the date the person woke up: the end of a main sleep (not a nap), in the zone WHOOP
 * recorded it in. Several main sleeps ending that date: the longest. Its recovery is the one
 * WHOOP made for that sleep; its strain comes from that sleep's cycle, whether or not a recovery
 * exists. A cycle no main sleep points to (a night not worn) makes a day of its own on its local
 * start date, unless a sleep-backed day already has that date. Each part keeps its own score
 * state: a scored sleep can sit next to a pending recovery.
 *
 *   { sleepMin, perf, eff, rec, hrv, rhr, spo2, skin, strain, kj,
 *     st: { sleep, rec, cycle } }      each 'scored' | 'pending' | 'unscorable', absent when missing
 *
 * The profile gets the newest WINDOW_DAYS of them (S.whoopDays, written only here); a date that
 * no longer has a WHOOP record (deleted in WHOOP, or another WHOOP account connected) becomes
 * `{ cleared: 1, _ts }`, so a device holding the old one drops it too. */
import { WINDOW_DAYS, windowOf } from '../../coach/core/whoop-days.js';
import { localDay } from './activities.js';

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keepNum = (o, k, v, digits = 1) => { if (Number.isFinite(v)) o[k] = Math.round(v * 10 ** digits) / 10 ** digits; };

/** Every date the WHOOP store has, as { iso: day }. */
export function daysOf(doc) {
  const rec = doc.records;
  const best = new Map();   // iso -> main sleep
  for (const s of Object.values(rec.sleep)) {
    if (s.nap) continue;
    const iso = localDay(s.end, s.off);
    const cur = best.get(iso);
    const len = s.end - s.start, curLen = cur ? cur.end - cur.start : -1;
    if (!cur || len > curLen || (len === curLen && s.id < cur.id)) best.set(iso, s);
  }
  const out = {};
  const used = new Set();
  for (const [iso, s] of best) {
    const day = { st: {} };
    day.st.sleep = s.st;
    if (s.st === 'scored') { keepNum(day, 'sleepMin', s.asleepMin, 0); keepNum(day, 'perf', s.perf, 0); keepNum(day, 'eff', s.eff, 0); }
    const cyc = s.cycle || doc.sleepCycle[s.id];
    const r = cyc ? rec.recovery[cyc] : null;
    if (r && (!r.sleep || r.sleep === s.id)) {
      day.st.rec = r.st;
      if (r.st === 'scored') { keepNum(day, 'rec', r.rec, 0); keepNum(day, 'hrv', r.hrv); keepNum(day, 'rhr', r.rhr, 0); keepNum(day, 'spo2', r.spo2); keepNum(day, 'skin', r.skin); }
    }
    const c = cyc ? rec.cycle[cyc] : null;
    if (c) { used.add(c.id); cycleInto(day, c); }
    out[iso] = day;
  }
  for (const c of Object.values(rec.cycle)) {
    if (used.has(c.id)) continue;
    const iso = localDay(c.start, c.off);
    if (out[iso]) continue;
    const day = { st: {} };
    cycleInto(day, c);
    out[iso] = day;
  }
  return out;
}
function cycleInto(day, c) {
  day.st.cycle = c.st;
  if (c.st === 'scored') { keepNum(day, 'strain', c.strain); keepNum(day, 'kj', c.kj, 0); }
}

/** The whoop-vitals projector: S.whoopDays from the WHOOP store, restamping only what changed.
 *  → whether S changed. */
export function projectDays(S, doc, t) {
  const want = windowOf(daysOf(doc));
  const cur = isMap(S.whoopDays) ? S.whoopDays : {};
  const next = {};
  let changed = false;
  for (const [iso, day] of Object.entries(want)) {
    const had = cur[iso];
    if (isMap(had) && !had.cleared && same((({ _ts, ...x }) => x)(had), day)) next[iso] = had;
    else { next[iso] = { ...day, _ts: t }; changed = true; }
  }
  // A date the profile has that the WHOOP store no longer does: cleared, so it goes everywhere.
  // One older than the window simply ages out.
  const oldest = Object.keys(want).sort()[0];
  for (const [iso, had] of Object.entries(cur)) {
    if (iso in next) continue;
    if (oldest && iso < oldest) { changed = true; continue; }
    if (isMap(had) && had.cleared === 1) { next[iso] = had; continue; }
    next[iso] = { cleared: 1, _ts: t };
    changed = true;
  }
  if (!changed) return false;
  S.whoopDays = windowOf(next);
  return true;
}

/** Days for GET /api/whoop/days: dates from `from` to `to` (inclusive), oldest first. */
export function daysBetween(doc, from, to) {
  return Object.entries(daysOf(doc)).filter(([iso]) => iso >= from && iso <= to).sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, x]) => ({ d, ...x }));
}

export { WINDOW_DAYS };
