// @vitest-environment happy-dom
// The Stats heatmap counts activities for time (fork): a profile that trains outside openGym's
// logger, a WHOOP history say, is not blank there. Volume stays gym-only: activities have no sets.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { DEF } from '../store/useStore.js'
import Heatmap from './Heatmap.jsx'
import { todayISO } from '../lib/format.js'

let host, root
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const day = todayISO()
const S = { ...JSON.parse(JSON.stringify(DEF)), workouts: [], activities: { w1: { d: day, sport: 'run', min: 42, src: 'whoop', _ts: 1 } } }
const cell = () => [...host.querySelectorAll('.hm-c')].find(c => (c.getAttribute('title') || '').startsWith(day))

describe('Heatmap and activities', () => {
  it('shades a day with only an activity on the time view, and says what it was', () => {
    act(() => root.render(<Heatmap S={S} metric="time" />))
    expect(cell().className).not.toMatch(/\bl0\b/)
    expect(cell().getAttribute('title')).toBe(`${day} · 1 activity · 42 min`)
  })
  it('the volume view counts gym volume only: the day is marked but not shaded by volume', () => {
    act(() => root.render(<Heatmap S={S} metric="vol" />))
    expect(cell().className).toMatch(/\bl1\b/)
  })
  it('a skipped WHOOP strength session is not counted', () => {
    const at = new Date(day + 'T07:00:00').getTime()
    const lift = { d: day, sport: 'other', min: 45, at, durMs: 45 * 60000, src: 'whoop', st: 1, _ts: 1 }
    act(() => root.render(<Heatmap S={{ ...S, activities: { wL: lift }, whoopChoice: { wL: { ov: 'skip', _ts: 2 } } }} metric="time" />))
    expect(cell().className).toMatch(/\bl0\b/)
  })
})
