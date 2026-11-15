// @vitest-environment happy-dom
// Fork: the start-up trace (boot-report.js) sends a report for an error before the first screen,
// with the steps reached, and nothing after it.
import { beforeAll, describe, expect, it, vi } from 'vitest'

let mod, calls
beforeAll(async () => {
  calls = []
  globalThis.fetch = vi.fn((url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Promise.resolve({}) })
  history.replaceState(null, '', '/?code=secret#/home?x=1')
  mod = await import('./boot-report.js')
  mod.startBootReport()
})

describe('boot report', () => {
  it('reports an error before the first screen with the last step reached, and nothing after it', () => {
    mod.bootStage('boot')
    mod.bootStage('config')
    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('x is undefined'), message: 'x is undefined', filename: 'https://h/assets/index.js', lineno: 3, colno: 9 }))
    expect(calls).toHaveLength(1)
    const r = calls[0].body
    expect(calls[0].url).toBe('/api/client-error')
    expect(r).toMatchObject({ kind: 'error', msg: 'x is undefined', stage: 'config', src: 'https://h/assets/index.js:3:9', path: '/#/home' })
    expect(r.stages.map(s => s.s)).toEqual(['script', 'boot', 'config'])
    expect(r.stack).toContain('TypeError')

    mod.bootDone()
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('later'), message: 'later' }))
    expect(calls).toHaveLength(1)
  })
})
