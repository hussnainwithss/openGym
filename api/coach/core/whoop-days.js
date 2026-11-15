/* WHOOP days in the profile (fork, whoop-vitals): S.whoopDays, one entry per local wake date,
 * written only by the server (api/integrations/whoop/days.js) and kept to the newest WINDOW_DAYS
 * dates, so every device has the last four months offline. Older history is read from the
 * server (GET /api/whoop/days). Shared by the server and the app (frontend lib/whoop-days.js and
 * lib/sync-merge.js), so both trim the same way. Pure. */

export const WINDOW_DAYS = 120;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** `map` with only its WINDOW_DAYS newest dates, counted from the newest one (no clock: the
 *  same answer on every device). A new object; non-date keys are dropped. */
export function windowOf(map) {
  if (!isMap(map)) return {};
  const keep = Object.keys(map).filter(k => ISO.test(k)).sort().slice(-WINDOW_DAYS);
  return Object.fromEntries(keep.map(k => [k, map[k]]));
}
