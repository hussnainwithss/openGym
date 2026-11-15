// @vitest-environment happy-dom
// The calendar's sport dots read WHOOP sessions through who decides they show (fork): a change to
// the person's choice alone, with S.activities untouched, has to show at once.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { todayISO } from './lib/format.js'
import { calendarSheet } from './sheets.jsx'

describe('Calendar and WHOOP sessions', () => {
  let original, root
  beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; original = useStore.getState().S; useUI.setState({ sheets: [] }); document.body.innerHTML = '' })
  afterEach(() => { act(() => root?.unmount()); useStore.setState({ S: original }) })

  it('skipping a WHOOP session, or WHOOP deleting it, takes its dot away at once', () => {
    const day = todayISO()
    const at = new Date(day + 'T07:00:00').getTime()
    const lift = { d: day, sport: 'other', title: 'Weightlifting', min: 45, at, durMs: 45 * 60000, src: 'whoop', wu: '00000000-0000-4000-8000-000000000003', st: 1, _ts: 1 }
    const run = { d: day, sport: 'run', min: 30, at: at + 3 * 3600000, durMs: 30 * 60000, src: 'whoop', wu: '00000000-0000-4000-8000-000000000004', _ts: 1 }
    useStore.setState({ S: { ...original, workouts: [], activities: { wL: lift } } })
    calendarSheet(day)
    const sheet = useUI.getState().sheets.at(-1)
    const host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(sheet.render(() => {})))
    expect(host.querySelectorAll('i.sport').length).toBe(1)
    act(() => useStore.setState(s => ({ S: { ...s.S, whoopChoice: { wL: { ov: 'skip', _ts: 2 } } } })))
    expect(host.querySelectorAll('i.sport').length).toBe(0)
    act(() => useStore.setState(s => ({ S: { ...s.S, activities: { ...s.S.activities, wR: run } } })))
    expect(host.querySelectorAll('i.sport').length).toBe(1)
    act(() => useStore.setState(s => ({ S: { ...s.S, whoopActs: { wR: { gone: 1, _ts: 3 } } } })))
    expect(host.querySelectorAll('i.sport').length).toBe(0)
  })
})
