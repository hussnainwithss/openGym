// WHOOP days (fork, whoop-vitals): what the server pulled from WHOOP, one entry per local wake date
// (api/integrations/whoop/days.js). The newest 120 dates ride in the profile (S.whoopDays, written
// only by the server), so they show offline; the WHOOP page asks the server for older ones.
//
// Kept apart from the phone's own vitals (lib/vitals.js, Apple Health / Health Connect): WHOOP's HRV
// is RMSSD, the health store's may be SDNN, and the two are never mixed into one number.

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const ISO = /^\d{4}-\d{2}-\d{2}$/
const NUMS = ['sleepMin', 'perf', 'eff', 'rec', 'hrv', 'rhr', 'spo2', 'skin', 'strain', 'kj']
const PARTS = ['sleep', 'rec', 'cycle']
const STATES = ['scored', 'pending', 'unscorable']

/** One WHOOP day as the app uses it, from the profile or from GET /api/whoop/days: a real date,
 *  finite numbers only, and each part's state one of the known ones or 'unknown' (a state a newer
 *  server knows and this app does not). Null for anything that is not a day. */
export function mapDay(d, raw) {
  if (!ISO.test(String(d || '')) || !isMap(raw) || raw.cleared) return null
  const out = { d, st: {} }
  for (const k of NUMS) if (Number.isFinite(raw[k])) out[k] = raw[k]
  const st = isMap(raw.st) ? raw.st : {}
  for (const p of PARTS) if (st[p] !== undefined) out.st[p] = STATES.includes(st[p]) ? st[p] : 'unknown'
  return out
}

/** The days the profile holds, oldest first, as { d, …day }; cleared ones left out. */
export function whoopDaysOf(S) {
  const map = isMap(S?.whoopDays) ? S.whoopDays : {}
  return Object.keys(map).sort().map(d => mapDay(d, map[d])).filter(Boolean)
}

/** Whether the profile has any WHOOP day to show. */
export const hasWhoopDays = S => whoopDaysOf(S).length > 0

/** Today's WHOOP day only, or null. Never an earlier day's numbers in its place: a part WHOOP has
 *  not scored yet reads as pending (`st`), not as yesterday's value. */
export function whoopToday(S, today) {
  return mapDay(today, isMap(S?.whoopDays) ? S.whoopDays[today] : null)
}

/** One part's state on a day: 'scored', 'pending', 'unscorable' or 'missing'. */
export const partState = (day, part) => day?.st?.[part] || 'missing'

/** A value of a day for display: the number, or the state word when it is not scored. */
export function partValue(day, part, key) {
  const st = partState(day, part)
  if (st === 'scored') return Number.isFinite(day?.[key]) ? day[key] : null
  return st === 'pending' ? 'pending' : st === 'unscorable' ? 'not scored' : st === 'unknown' ? 'unknown' : null
}

/** A line of one value over days, for LineChart: [{ t, y, d }] with only scored values. */
export function trendOf(days, key) {
  return days.filter(x => Number.isFinite(x[key])).map(x => ({ t: new Date(x.d + 'T12:00:00').getTime(), y: x[key], d: x.d }))
}

/** `from` and `to` dates covering `n` days up to `today`. */
export function rangeOf(today, n) {
  const d = new Date(today + 'T12:00:00')
  d.setDate(d.getDate() - (n - 1))
  const p = x => String(x).padStart(2, '0')
  return { from: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, to: today }
}
