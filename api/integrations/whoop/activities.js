/* WHOOP workouts into the profile's activities (frontend/src/lib/activities.js shape), the
 * whoop-activities projection of whoop/sync.js.
 *
 * The server writes each activity once, when it first sees the workout, and never again (D23):
 * a later WHOOP change or deletion goes into S.whoopActs, a map the server alone writes, and the
 * app shows it over the activity unless the person edited that activity. So a delete or an edit
 * made on a phone offline always wins over a WHOOP update that arrives meanwhile. An id that is
 * already in S.activities, a removal's stamped `{ _ts }` included, is never touched.
 *
 * Every WHOOP workout comes in, strength sessions too (D5); those carry `st: 1`, and what happens
 * when one overlaps a workout logged in openGym is decided when the app reads it
 * (api/coach/core/whoop-activities.js). */
import crypto from 'node:crypto';
import { effectiveActivity } from '../../coach/core/whoop-activities.js';

// WHOOP sport names → openGym's SPORTS. Anything else is 'other', named after WHOOP's sport.
const SPORT = {
  running: 'run', 'track & field': 'run', 'cross country skiing': 'ski', skiing: 'ski', snowboarding: 'ski',
  cycling: 'ride', 'mountain biking': 'ride', spin: 'ride', 'assault bike': 'ride',
  swimming: 'swim', hiking: 'hike', rucking: 'hike', 'hiking rucking': 'hike', walking: 'hike', rowing: 'row', kayaking: 'row', paddleboarding: 'row',
  soccer: 'football', football: 'football', 'australian football': 'football', 'american football': 'football', rugby: 'football',
  tennis: 'racket', squash: 'racket', badminton: 'racket', 'table tennis': 'racket', pickleball: 'racket', padel: 'racket',
  basketball: 'ball', volleyball: 'ball', baseball: 'ball', softball: 'ball', hockey: 'ball', 'ice hockey': 'ball', 'field hockey': 'ball', handball: 'ball', lacrosse: 'ball', netball: 'ball', cricket: 'ball',
  climbing: 'climb', 'rock climbing': 'climb', bouldering: 'climb',
  boxing: 'fight', kickboxing: 'fight', 'martial arts': 'fight', 'jiu jitsu': 'fight', wrestling: 'fight', mma: 'fight',
  yoga: 'yoga', 'hot yoga': 'yoga', pilates: 'yoga',
  dance: 'dance', barre: 'dance',
};
// Sessions that are strength work: they may duplicate a workout logged in openGym.
// `weightlifting msk` is what WHOOP's Strength Trainer records.
export const STRENGTH = new Set(['weightlifting', 'weightlifting msk', 'powerlifting', 'functional fitness', 'strength trainer', 'crossfit']);
// WHOOP "sports" that are recovery, not training: they become recovery sessions
// (frontend/src/lib/recovery-sessions.js, kinds sauna / cold / massage / other), not activities.
export const RECOVERY = {
  sauna: { kind: 'sauna' }, 'steam room': { kind: 'sauna', note: 'Steam room' },
  'ice bath': { kind: 'cold' }, 'cold plunge': { kind: 'cold' },
  'warm bath': { kind: 'other', note: 'Warm bath' }, 'hot tub': { kind: 'other', note: 'Hot tub' },
  massage: { kind: 'massage' }, 'massage therapy': { kind: 'massage' },
  // The person's call (fork): stretching is recovery work, not a training day.
  stretching: { kind: 'stretch', note: 'Stretching' },
};
// Names WHOOP gives that read better as something else.
// Sessions that keep WHOOP's name although they map to a sport (a walk is not a hike).
const NAMED = new Set(['walking']);
const TITLE = { 'weightlifting msk': 'Strength Trainer', hiit: 'HIIT' };
/** WHOOP's sport name as these tables key it: 'weightlifting_msk', 'warm-bath' → 'weightlifting msk', 'warm bath'. */
export const sportKey = name => String(name || '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The activity id of a WHOOP workout: 'w' + 16 characters of the SHA-256 of its UUID. */
export const whoopActivityId = uuid => 'w' + crypto.createHash('sha256').update(String(uuid)).digest('base64url').slice(0, 16);

const pad = n => String(n).padStart(2, '0');
/** The local calendar day of `ms` at `offMin` minutes east of UTC. */
export function localDay(ms, offMin) {
  const d = new Date(ms + offMin * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const title = k => (TITLE[k] || k.replace(/\b\w/g, c => c.toUpperCase())).slice(0, 80);

/** A normalized WHOOP workout (whoop/normalize.js) as activity fields (no _ts). */
export function activityOf(r, whoopUser) {
  const durMs = r.end - r.start;
  const key = sportKey(r.sport);
  const sport = SPORT[key] || 'other';
  const out = {
    d: localDay(r.start, r.off), sport, min: Math.min(1440, Math.max(1, Math.round(durMs / 60_000))),
    at: r.start, durMs, src: 'whoop', wu: r.id, ...(whoopUser ? { wa: whoopUser } : {}),
  };
  if ((sport === 'other' || NAMED.has(key)) && key) out.title = title(key);
  if (STRENGTH.has(key)) out.st = 1;
  if (r.km > 0 && r.km < 1000) out.km = Math.round(r.km * 100) / 100;
  for (const k of ['strain', 'hr', 'hrMax', 'kj']) if (r[k] != null) out[k] = Math.round(r[k] * 10) / 10;
  return out;
}

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const FIELDS = ['d', 'sport', 'min', 'at', 'durMs', 'km', 'title', 'st', 'strain', 'hr', 'hrMax', 'kj'];
const pick = a => Object.fromEntries(FIELDS.filter(k => a[k] !== undefined).map(k => [k, a[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The whoop-activities projector: new WHOOP workouts into S.activities, later changes and
 *  deletions into S.whoopActs. → whether S changed. */
/** A WHOOP recovery "sport" (a sauna, an ice bath) as a recovery session (no _ts), or null. */
export function recoveryOf(r) {
  const rec = RECOVERY[sportKey(r.sport)];
  if (!rec) return null;
  return { d: localDay(r.start, r.off), kind: rec.kind, min: Math.min(600, Math.max(1, Math.round((r.end - r.start) / 60_000))), note: rec.note ? rec.note + ' (WHOOP)' : 'WHOOP' };
}

export function projectActivities(S, doc, t) {
  const map = isMap(S.activities) ? S.activities : {};
  const acts = isMap(S.whoopActs) ? S.whoopActs : {};
  const recs = isMap(S.recoverySessions) ? S.recoverySessions : {};
  let added = false, updated = false, recAdded = false;
  for (const r of Object.values(doc.records.workout)) {
    const id = whoopActivityId(r.id);
    // A sauna or an ice bath is a recovery session: written once, like an activity. One already
    // imported as an activity (before this mapping) is hidden through whoopActs unless the person
    // edited it, and the recovery session takes its place.
    const rec = recoveryOf(r);
    if (rec) {
      const had = map[id];
      if (isMap(had) && had.edited === 1) continue;   // the person made that activity theirs: no second copy
      if (!Object.hasOwn(recs, id)) { recs[id] = { ...rec, _ts: t }; recAdded = true; }
      if (isMap(had) && had.src === 'whoop' && acts[id]?.gone !== 1) { acts[id] = { gone: 1, _ts: t }; updated = true; }
      continue;
    }
    if (!Object.hasOwn(map, id)) {
      map[id] = { ...activityOf(r, doc.whoopUser), _ts: t };
      added = true;
      continue;
    }
    // There already: removed or edited by the person, it is theirs; otherwise WHOOP's latest
    // goes into whoopActs when it differs from what shows now.
    const entry = map[id];
    if (!isMap(entry) || entry.src !== 'whoop' || entry.edited === 1 || entry.wu !== r.id) continue;
    const latest = pick(activityOf(r, doc.whoopUser));
    const shown = effectiveActivity(S, id, entry);
    if (shown && same(pick(shown), latest)) continue;
    acts[id] = { ...latest, _ts: t };
    updated = true;
  }
  // Deleted in WHOOP: only once the whole history is in (before that, missing means not fetched
  // yet), and only for this WHOOP account's sessions (another account's stay, D12/D20).
  if (doc.cursors.workout?.done) {
    for (const [id, entry] of Object.entries(map)) {
      if (!isMap(entry) || entry.src !== 'whoop' || entry.edited === 1 || !entry.wu || entry.wa !== doc.whoopUser) continue;
      if (doc.records.workout[entry.wu] || acts[id]?.gone === 1) continue;
      acts[id] = { gone: 1, _ts: t };
      updated = true;
    }
  }
  if (added) S.activities = map;
  if (updated) S.whoopActs = acts;
  if (recAdded) S.recoverySessions = recs;
  return added || updated || recAdded;
}
