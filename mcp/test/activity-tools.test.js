// Fork: list_activities and get_recovery (src/activity-tools.js).
import { describe, test, expect } from 'vitest'
import { _seedStateForTests } from '../src/state.js'
import { listActivities, getRecovery } from '../src/activity-tools.js'
import { toolAllowed } from '../src/server.js'

const at = (iso, h) => new Date(`${iso}T${String(h).padStart(2, '0')}:00:00Z`).getTime()

describe('list_activities', () => {
  test('shows WHOOP as WHOOP last left it, leaves out a merged strength session, and lists recovery', () => {
    _seedStateForTests({
      workouts: [{ id: 'g1', d: '2026-11-14', start: at('2026-11-14', 7), end: at('2026-11-14', 8), entries: [] }],
      activities: {
        wRun: { d: '2026-11-13', sport: 'run', min: 40, at: at('2026-11-13', 6), durMs: 2400000, km: 8, src: 'whoop', wu: 'u1', strain: 12.1, hr: 150, hrMax: 180, _ts: 1 },
        wLift: { d: '2026-11-14', sport: 'other', min: 50, at: at('2026-11-14', 7), durMs: 3000000, src: 'whoop', wu: 'u2', st: 1, title: 'Strength Trainer', _ts: 1 },
      },
      // WHOOP corrected the run's strain after import (bug caught: reading S.activities raw)
      whoopActs: { wRun: { d: '2026-11-13', sport: 'run', min: 40, at: at('2026-11-13', 6), durMs: 2400000, km: 8, strain: 13.4, hr: 150, hrMax: 180, _ts: 2 } },
      whoopChoice: { wLift: { ov: 'merge', _ts: 3 } },
      recoverySessions: { r1: { d: '2026-11-12', kind: 'sauna', min: 15, note: 'Steam room (WHOOP)', _ts: 1 } },
    })
    const r = listActivities.handler({})
    expect(r.activities).toEqual([
      { date: '2026-11-13', name: 'Run', sport: 'run', minutes: 40, start: '2026-11-13T06:00:00.000Z', km: 8, strain: 13.4, avg_hr: 150, max_hr: 180, source: 'WHOOP' },
    ])
    expect(r.recovery).toEqual([{ date: '2026-11-12', kind: 'Sauna', minutes: 15, note: 'Steam room (WHOOP)' }])
    expect(listActivities.handler({ from: '2026-11-14' }).count).toBe(0)
  })
})

describe('get_recovery', () => {
  test('a part WHOOP has not scored is null with its state, never another day\'s value', () => {
    _seedStateForTests({
      whoopDays: {
        '2026-11-14': { rec: 71, hrv: 64.27, rhr: 52, sleepMin: 431, perf: 88, strain: 14.26, st: { rec: 'scored', sleep: 'scored', cycle: 'scored' }, _ts: 1 },
        '2026-11-15': { sleepMin: 402, st: { rec: 'pending', sleep: 'scored', cycle: 'pending' }, _ts: 2 },
        '2026-11-10': { cleared: 1, _ts: 3 },
      },
    })
    const r = getRecovery.handler({})
    expect(r.days.map(d => d.date)).toEqual(['2026-11-14', '2026-11-15'])
    expect(r.days[0]).toMatchObject({ recovery_pct: 71, hrv_ms: 64.3, resting_hr: 52, sleep_minutes: 431, strain: 14.3 })
    expect(r.days[1]).toMatchObject({ state: { recovery: 'pending', sleep: 'scored', strain: 'pending' }, recovery_pct: null, hrv_ms: null, sleep_minutes: 402, strain: null })
  })

  test('needs the whoop category; activities ride with workouts', () => {
    expect(toolAllowed('get_recovery', { workouts: 'view' })).toBe(false)
    expect(toolAllowed('get_recovery', { whoop: 'view' })).toBe(true)
    expect(toolAllowed('list_activities', { workouts: 'view' })).toBe(true)
  })
})
