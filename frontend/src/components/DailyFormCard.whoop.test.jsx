// @vitest-environment happy-dom
// Daily form and WHOOP (fork, whoop-vitals): today's WHOOP numbers in a block of their own, shown
// from the profile (so with no server too), only with the Integrations module on; the phone's
// vitals, the check-ins and the insights stay the Health module's.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { DEF } from '../store/useStore.js'
import DailyFormCard from './DailyFormCard.jsx'
import { todayISO } from '../lib/format.js'

const clone = v => JSON.parse(JSON.stringify(v))
let host, root
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const today = todayISO()
const yesterday = (() => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10) })()
const day = { rec: 66, hrv: 61.5, rhr: 52, spo2: 96.4, skin: 33.7, sleepMin: 425, strain: 12.4, st: { sleep: 'scored', rec: 'scored', cycle: 'scored' }, _ts: 1 }

describe('Daily form card: WHOOP today', () => {
  it('shows today’s WHOOP numbers with Health off, and none of the Health parts', () => {
    const S = { ...clone(DEF), modules: { health: false, integrations: true }, dailyForm: true, dayForm: { [today]: { sleep: 4, energy: 4, sore: 2, stress: 2, _ts: 1 } }, whoopDays: { [today]: day } }
    act(() => root.render(<MemoryRouter><DailyFormCard S={S} /></MemoryRouter>))
    const w = host.querySelector('[data-whoop-today]')
    expect(w).toBeTruthy()
    expect(w.textContent).toContain('66')
    expect(w.textContent).toContain('HRV (RMSSD)')
    expect(w.textContent).toContain('7 h 5 min')
    expect(host.querySelector('[data-daily-form="offer"]')).toBeNull()
    expect(host.textContent).not.toContain('check-in')
  })
  it('with Integrations off: no WHOOP block', () => {
    const S = { ...clone(DEF), modules: { integrations: false }, dailyForm: true, whoopDays: { [today]: day } }
    act(() => root.render(<MemoryRouter><DailyFormCard S={S} /></MemoryRouter>))
    expect(host.querySelector('[data-whoop-today]')).toBeNull()
  })
  it('a recovery WHOOP has not scored yet says pending, never yesterday’s', () => {
    const S = { ...clone(DEF), modules: { health: false }, whoopDays: { [yesterday]: day, [today]: { sleepMin: 400, st: { sleep: 'scored', rec: 'pending' }, _ts: 2 } } }
    act(() => root.render(<MemoryRouter><DailyFormCard S={S} /></MemoryRouter>))
    const w = host.querySelector('[data-whoop-today]')
    expect(w.textContent).toContain('pending')
    expect(w.textContent).not.toContain('66')
    expect(w.textContent).not.toContain('61')
  })
})
