/* api/integrations/whoop/weigh-ins.js is a hand copy of the day rules here (fork, WHOOP weights):
   the server settles a day it adds a WHOOP reading to. The two must agree, and the typed-wins rule
   for days with a WHOOP reading must hold on both sides. */
import { describe, expect, it } from 'vitest'
import * as srv from '../../../api/integrations/whoop/weigh-ins.js'
import { dailyValue, settleDay, absorbLegacyEdit, readingsOf } from './weigh-ins.js'

const clone = v => JSON.parse(JSON.stringify(v))
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 } }
const SRCS = [undefined, undefined, 'whoop', 'health', 'import']

describe('the server’s copy of the day rules matches this one', () => {
  it('on random days, every daily mode', () => {
    for (let seed = 1; seed < 400; seed++) {
      const R = rng(seed)
      const t0 = Date.UTC(2026, 9, 1 + Math.floor(R() * 20), 6)
      const n = 1 + Math.floor(R() * 4)
      const ins = Array.from({ length: n }, (_, i) => {
        const r = { id: 'r' + i, at: R() < 0.2 ? null : `${String(5 + Math.floor(R() * 15)).padStart(2, '0')}:${R() < 0.5 ? '00' : '30'}`, w: 70 + Math.round(R() * 200) / 10, t: t0 + i * 1000 }
        const src = SRCS[Math.floor(R() * SRCS.length)]
        if (src) r.src = src
        return r
      })
      const day = { d: '2026-10-05', w: ins[0].w, t: t0 + 99, ins, ...(R() < 0.3 ? { gone: { r0: t0 + (R() < 0.5 ? 5000 : -1) } } : {}) }
      // an older app's edit of the day, sometimes
      if (R() < 0.3) { day.w = 90.5; day.t = t0 + 10_000 }
      for (const mode of ['first', 'avg', 'last']) {
        expect(srv.dailyValue(ins, mode)).toEqual(dailyValue(ins, mode))
        // The device's zone, as the server would be told it for this moment.
        const off = -new Date(t0).getTimezoneOffset()
        expect(srv.settleDay(clone(day), mode, { off })).toEqual(settleDay(clone(day), mode))
        expect(srv.readingsOf({ d: '2026-10-05', w: 80, t: t0 }, off)).toEqual(readingsOf({ d: '2026-10-05', w: 80, t: t0 }))
      }
    }
  })
})

describe('a typed weigh-in wins a day that has a WHOOP reading (D11)', () => {
  const typed = (at, w) => ({ id: 'k' + at, at, w, t: 1 })
  const whoop = (at, w) => ({ id: 'wh' + at, at, w, t: 1, src: 'whoop' })
  it('in every daily mode, whenever the WHOOP reading was taken', () => {
    const day = [whoop('03:15', 90), typed('07:00', 80)]
    for (const m of ['first', 'avg', 'last']) expect(dailyValue(day, m)).toBe(80)
    const two = [typed('07:00', 80), whoop('12:00', 90), typed('19:00', 82)]
    expect([dailyValue(two, 'first'), dailyValue(two, 'avg'), dailyValue(two, 'last')]).toEqual([80, 81, 82])
  })
  it('a day without a WHOOP reading is read as before: typed and a scale reading both count', () => {
    const day = [typed('07:00', 80), { id: 'h', at: '12:00', w: 90, t: 1, src: 'health' }]
    expect([dailyValue(day, 'first'), dailyValue(day, 'avg'), dailyValue(day, 'last')]).toEqual([80, 85, 90])
  })
  it('an older app’s correction of such a day goes to the typed reading, not WHOOP’s', () => {
    const e = { d: '2026-10-05', w: 79, t: 50, ins: [whoop('03:15', 90), typed('07:00', 80)] }
    absorbLegacyEdit(e, 'first')
    expect(e.ins.find(r => r.src === 'whoop').w).toBe(90)
    expect(e.ins.find(r => !r.src).w).toBe(79)
  })
  it('a legacy reading keeps the time the person saw when the server, in another zone, adds WHOOP’s', () => {
    // typed at 07:00 in Riyadh (+03:00): 04:00 UTC
    const t = Date.UTC(2026, 9, 5, 4)
    const S = { bodyweight: [{ d: '2026-10-05', w: 80, t }] }
    srv.addWhoopReading(S, { d: '2026-10-05', at: '12:00', w: 81, t: t + 1, id: 'whX' }, 'first', 180)
    expect(S.bodyweight[0].ins.find(r => r.id === '0').at).toBe('07:00')
  })
})
