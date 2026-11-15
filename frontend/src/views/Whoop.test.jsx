// @vitest-environment happy-dom
// The WHOOP page's data (fork, whoop-vitals): longer ranges come from the server in chunks of at
// most 400 days, older than what the profile holds; without the server, the profile's 120 days.
import { describe, expect, it } from 'vitest'
import { loadDays } from './Whoop.jsx'
import { trendOf } from '../lib/whoop-days.js'

describe('WHOOP page: where the days come from', () => {
  it('two years from the server, asked in chunks of at most 400 days; a day older than 120 days is in the chart', async () => {
    const asked = []
    const get = async p => { asked.push(p); return { days: p.includes('from=2025-01') || p.includes('from=2024') ? [{ d: '2025-01-10', rec: 40, st: { rec: 'scored' } }] : [] } }
    const r = await loadDays({}, '2026-11-15', 730, get)
    expect(r.offline).toBe(false)
    for (const p of asked) {
      const q = new URLSearchParams(p.split('?')[1])
      expect((Date.parse(q.get('to')) - Date.parse(q.get('from'))) / 86400000).toBeLessThan(400)
    }
    expect(r.days.map(d => d.d)).toContain('2025-01-10')
    expect(trendOf(r.days, 'rec').length).toBe(1)
  })
  it('the server cannot answer: the profile’s days, said so', async () => {
    const S = { whoopDays: { '2026-11-14': { rec: 70, st: { rec: 'scored' }, _ts: 1 }, '2026-11-13': { cleared: 1, _ts: 2 } } }
    const r = await loadDays(S, '2026-11-15', 30, async () => { throw new Error('offline') })
    expect(r.offline).toBe(true)
    expect(r.days.map(d => d.d)).toEqual(['2026-11-14'])
  })
})
