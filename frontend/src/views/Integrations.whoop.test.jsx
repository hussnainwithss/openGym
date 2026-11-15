// @vitest-environment happy-dom
// WHOOP's messages on the Integrations page (fork): a code from the URL (?error=) or from the
// server (lastError.code, a check's code) only ever picks one of our fixed texts.
import { describe, expect, it } from 'vitest'
import { whoopMessage, WHOOP_ERRORS, WHOOP_SYNC } from './Integrations.jsx'

describe('WHOOP messages by code', () => {
  it('a known code gives its text; anything else, Object.prototype names included, the fallback', () => {
    const cases = [
      [WHOOP_ERRORS, 'denied', 'WHOOP was not given access. Nothing was connected.'],
      [WHOOP_SYNC, 'reconnect', 'WHOOP no longer accepts this sign-in. Reconnect it.'],
      [WHOOP_ERRORS, 'toString', 'FALLBACK'],
      [WHOOP_ERRORS, '__proto__', 'FALLBACK'],
      [WHOOP_SYNC, 'constructor', 'FALLBACK'],
      [WHOOP_SYNC, 'sealed', 'FALLBACK'],
      [WHOOP_SYNC, null, 'FALLBACK'],
      [WHOOP_SYNC, 42, 'FALLBACK'],
      [WHOOP_SYNC, undefined, 'FALLBACK'],
    ]
    for (const [map, code, want] of cases) expect(whoopMessage(map, code, 'FALLBACK')).toBe(want)
  })
})
