// WHOOP days (fork, whoop-vitals): what the server pulled from WHOOP, one entry per local wake date
// (api/integrations/whoop/days.js). The newest 120 dates ride in the profile (S.whoopDays, written
// only by the server), so they show offline; the WHOOP page asks the server for older ones.
//
// Kept apart from the phone's own vitals (lib/vitals.js, Apple Health / Health Connect): WHOOP's HRV
// is RMSSD, the health store's may be SDNN, and the two are never mixed into one number.

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const ISO = /^\d{4}-\d{2}-\d{2}$/

/** The days the profile holds, oldest first, as { d, …day }; cleared ones left out. */
export function whoopDaysOf(S) {
  const map = isMap(S?.whoopDays) ? S.whoopDays : {}
  return Object.keys(map).filter(k => ISO.test(k) && isMap(map[k]) && !map[k].cleared).sort().map(d => {
    const { _ts, ...day } = map[d]
    return { d, ...day }
  })
}

/** Whether the profile has any WHOOP day to show. */
export const hasWhoopDays = S => whoopDaysOf(S).length > 0

/** Today's WHOOP day only, or null. Never an earlier day's numbers in its place: a part WHOOP has
 *  not scored yet reads as pending (`st`), not as yesterday's value. */
export function whoopToday(S, today) {
  const day = isMap(S?.whoopDays) ? S.whoopDays[today] : null
  if (!isMap(day) || day.cleared) return null
  const { _ts, ...rest } = day
  return { d: today, ...rest }
}

/** One part's state on a day: 'scored', 'pending', 'unscorable' or 'missing'. */
export const partState = (day, part) => day?.st?.[part] || 'missing'

/** A value of a day for display: the number, or the state word when it is not scored. */
export function partValue(day, part, key) {
  const st = partState(day, part)
  if (st === 'scored') return Number.isFinite(day?.[key]) ? day[key] : null
  return st === 'pending' ? 'pending' : st === 'unscorable' ? 'not scored' : null
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
