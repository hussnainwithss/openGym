/* Fork: what was trained outside openGym's logger (activities: WHOOP sessions, runs from the
   health store) and recovery (sessions such as a sauna, and WHOOP's daily recovery, sleep and
   strain). Read-only. Activities come as the app shows them: a WHOOP session as WHOOP last left it
   unless the person edited it, and a strength session merged into a logged workout or skipped
   left out (frontend/src/lib/activities.js). WHOOP days are the newest 120 the profile holds. */
import { z } from 'zod'
import { getState } from './state.js'
import { isoDate } from './tools.js'
import { activitiesOf, activityName } from '../../frontend/src/lib/activities.js'
import { recoverySessionsOf, RECOVERY_LABEL } from '../../frontend/src/lib/recovery-sessions.js'
import { whoopDaysOf } from '../../frontend/src/lib/whoop-days.js'

const SOURCE = { whoop: 'WHOOP', hc: 'Health Connect', ah: 'Apple Health', import: 'import', manual: 'logged by hand', or: 'other app' }
const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to)
const noState = () => ({ error: 'no synced state yet: sign in at least once from a device so the server holds this profile' })

export const listActivities = {
  name: 'list_activities',
  description: 'List training done outside openGym\'s workout logger, newest first: WHOOP sessions (with strain, average and max heart rate, kJ), runs and rides from Apple Health or Health Connect, imported or hand-logged sports. Also lists recovery sessions (sauna, ice bath, massage) in `recovery`. Logged gym workouts are in list_workouts instead; a WHOOP strength session the person merged into a logged workout, or skipped, is not listed here.',
  schema: {
    from: isoDate().optional().describe('Inclusive start date YYYY-MM-DD.'),
    to: isoDate().optional().describe('Inclusive end date YYYY-MM-DD.'),
    limit: z.number().int().min(1).max(200).optional().describe('Most activities to return (default 50).'),
  },
  handler: ({ from, to, limit = 50 } = {}) => {
    const S = getState()
    if (!S) return noState()
    const acts = activitiesOf(S).filter(a => inRange(a.d, from, to))
    const recs = recoverySessionsOf(S).filter(r => inRange(r.d, from, to))
    return {
      count: acts.length,
      activities: acts.slice(0, limit).map(a => ({
        date: a.d,
        name: activityName(a),
        sport: a.sport,
        minutes: a.min,
        ...(a.at ? { start: new Date(a.at).toISOString() } : {}),
        ...(a.km ? { km: a.km } : {}),
        ...(a.strain != null ? { strain: a.strain } : {}),
        ...(a.hr != null ? { avg_hr: a.hr } : {}),
        ...(a.hrMax != null ? { max_hr: a.hrMax } : {}),
        ...(a.kj != null ? { kj: a.kj } : {}),
        ...(a.st === 1 ? { strength: true } : {}),
        source: SOURCE[a.src] || 'logged by hand',
        ...(a.note ? { note: a.note } : {}),
      })),
      recovery_count: recs.length,
      recovery: recs.slice(0, limit).map(r => ({ date: r.d, kind: RECOVERY_LABEL[r.kind] || r.kind, minutes: r.min, ...(r.note ? { note: r.note } : {}) })),
    }
  },
}

const round = (v, n = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null)
// A part WHOOP has not scored says so, never an earlier day's value in its place.
const scored = (day, part, v) => (day.st?.[part] === 'scored' ? v : null)

export const getRecovery = {
  name: 'get_recovery',
  description: 'Get WHOOP\'s daily numbers, one entry per wake-up date, oldest first: recovery %, HRV (RMSSD, ms), resting heart rate, SpO2 %, skin temperature (°C), sleep (minutes asleep, performance %, efficiency %), day strain and steps. Each part says its state (scored, pending, unscorable); a value is null unless scored. Holds the newest 120 days. Use it for readiness, sleep and load questions.',
  schema: {
    from: isoDate().optional().describe('Inclusive start date YYYY-MM-DD.'),
    to: isoDate().optional().describe('Inclusive end date YYYY-MM-DD.'),
  },
  handler: ({ from, to } = {}) => {
    const S = getState()
    if (!S) return noState()
    const days = whoopDaysOf(S).filter(d => inRange(d.d, from, to))
    if (!days.length && !whoopDaysOf(S).length) return { count: 0, days: [], note: 'no WHOOP data: WHOOP is not connected on this server, or nothing has synced yet' }
    return {
      count: days.length,
      days: days.map(d => ({
        date: d.d,
        state: { recovery: d.st?.rec || 'missing', sleep: d.st?.sleep || 'missing', strain: d.st?.cycle || 'missing' },
        recovery_pct: scored(d, 'rec', round(d.rec)),
        hrv_ms: scored(d, 'rec', round(d.hrv, 1)),
        resting_hr: scored(d, 'rec', round(d.rhr)),
        spo2_pct: scored(d, 'rec', round(d.spo2, 1)),
        skin_temp_c: scored(d, 'rec', round(d.skin, 1)),
        sleep_minutes: scored(d, 'sleep', round(d.sleepMin)),
        sleep_performance_pct: scored(d, 'sleep', round(d.perf)),
        sleep_efficiency_pct: scored(d, 'sleep', round(d.eff)),
        strain: scored(d, 'cycle', round(d.strain, 1)),
        ...(Number.isFinite(d.steps) ? { steps: d.steps } : {}),
      })),
    }
  },
}

export const ACTIVITY_TOOLS = [listActivities, getRecovery]
