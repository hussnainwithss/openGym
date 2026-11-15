/* WHOOP activities as everyone reads them (fork): the app (frontend/src/lib/activities.js) and the
 * server (streak.js) both go through this file, so a session the server counts is one the phone
 * shows. It lives in coach/core because that is the folder every build already shares with the
 * frontend. Pure, no node or DOM imports.
 *
 * The server writes a WHOOP activity once (api/integrations/whoop/activities.js); what WHOOP
 * changes later sits in S.whoopActs[id], written by the server only. Read here:
 *   - an activity the person edited (`edited: 1`) is theirs: WHOOP's later changes are not shown
 *   - otherwise WHOOP's latest fields are shown over the stored ones, and `gone: 1` hides it */

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
// The fields a WHOOP update may carry over the stored activity.
const UPDATE_FIELDS = ['d', 'sport', 'min', 'at', 'durMs', 'km', 'title', 'st', 'strain', 'hr', 'hrMax', 'kj'];

export const CHOICES = ['keep', 'merge', 'skip'];

/** A workout's identity for a link: its id, or the day/start key records had before ids
 *  (frontend lib/workout-date.js legacySyncKey). */
export const workoutKeyOf = w => (w?.id != null ? String(w.id) : `${w?.d}|${w?.start}`);

/** The logged workout a WHOOP session overlaps most, by real time, or null. `a.at` and `a.durMs`
 *  (or its minutes) are the session; a workout needs a start before its end. Ties go to the
 *  lower key, so every device picks the same one. */
export function overlapOf(workouts, a) {
  const start = Number(a?.at);
  const len = Number(a?.durMs) > 0 ? Number(a.durMs) : Number(a?.min) * 60_000;
  if (!(start > 0) || !(len > 0)) return null;
  const end = start + len;
  let best = null, bestMs = 0;
  for (const w of Array.isArray(workouts) ? workouts : []) {
    const ws = Number(w?.start), we = Number(w?.end);
    if (!(ws > 0) || !(we > ws)) continue;
    const ms = Math.min(end, we) - Math.max(start, ws);
    if (ms <= 0) continue;
    const key = workoutKeyOf(w);
    if (ms > bestMs || (ms === bestMs && best && key < best.key)) { best = { key, w }; bestMs = ms; }
  }
  return best;
}

/** What happens to a WHOOP strength session (D21): the person's own keep / merge / skip
 *  (S.whoopChoice, only devices write it), else the default (S.whoopStrength) when it overlaps a
 *  workout logged in openGym, else keep. Merge with nothing to merge into shows it as an
 *  activity; the choice itself is kept and applies again once a workout overlaps.
 *  → { ov, wid, explicit } (wid: the workout key it merges into, or null). */
export function choiceOf(S, id, a) {
  if (!isMap(a) || a.src !== 'whoop' || a.st !== 1) return { ov: 'keep', wid: null, explicit: false };
  const c = isMap(S?.whoopChoice) ? S.whoopChoice[id] : null;
  const explicit = isMap(c) && CHOICES.includes(c.ov) ? c.ov : null;
  const target = overlapOf(S?.workouts, a);
  const wanted = explicit || (target ? (CHOICES.includes(S?.whoopStrength) ? S.whoopStrength : 'keep') : 'keep');
  const ov = wanted === 'merge' && !target ? 'keep' : wanted;
  return { ov, wid: ov === 'merge' ? target.key : null, explicit: !!explicit };
}

/** Whether a session is out of the activity lists (merged into a workout, or skipped). */
export const hiddenBy = (S, id, a) => choiceOf(S, id, a).ov !== 'keep';

/** The activity as it should show: the stored `entry` with WHOOP's later changes, or null when
 *  WHOOP deleted it. Any other source passes through untouched. */
export function effectiveActivity(S, id, entry) {
  if (!isMap(entry) || entry.src !== 'whoop' || entry.edited === 1) return entry;
  const u = isMap(S?.whoopActs) ? S.whoopActs[id] : null;
  if (!isMap(u)) return entry;
  if (u.gone === 1) return null;
  const out = { ...entry };
  for (const k of UPDATE_FIELDS) {
    if (u[k] !== undefined) out[k] = u[k];
    else if (k === 'km' || k === 'title' || k === 'st' || k === 'strain' || k === 'hr' || k === 'hrMax' || k === 'kj') delete out[k];
  }
  return out;
}
