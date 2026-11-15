/* WHOOP (integrations/providers/whoop.js): off without its app's credentials, the OAuth round
 * trip with WHOOP's 8-character state (server-side, used once, bound to the profile), and the
 * connection it stores. Against a pretend WHOOP (fake-whoop.mjs): nothing leaves the machine. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createIntegrations, OAUTH_STATE_MS } = await import('../integrations/index.js');
const { AUTHORIZE_URL, SCOPES } = await import('../integrations/providers/whoop.js');
const { fakeWhoop, ENV } = await import('./fake-whoop.mjs');

const SECRET = 'b'.repeat(64);
const CB = 'https://gym.example.com/api/integrations/oauth/callback';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gym-whoop-'));

export function hub({ env = ENV, w = fakeWhoop(), now = Date.now, dataDir = tmp() } = {}) {
  const h = createIntegrations({ dataDir, secret: SECRET, env, fetchFn: w.fetchFn, now });
  return { h, w, dataDir };
}
const stateOf = url => new URL(url).searchParams.get('state');

test('off without the app’s credentials', () => {
  assert.equal(createIntegrations({ dataDir: tmp(), secret: SECRET, env: { INTEGRATIONS: 'whoop' } }).active, false);
  assert.deepEqual(hub().h.publicConfig(), { providers: ['whoop'] });
});

test('the sign-in link carries an 8-character state and every scope, offline included', () => {
  const { h } = hub();
  const url = new URL(h.oauthStart('u1', 'whoop', CB));
  assert.equal(url.origin + url.pathname, AUTHORIZE_URL);
  // WHOOP refuses any state that is not exactly 8 characters long.
  assert.equal(url.searchParams.get('state').length, 8);
  assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), [...SCOPES].sort());
  assert.ok(SCOPES.includes('offline'));
  assert.equal(url.searchParams.get('redirect_uri'), CB);
});

test('a callback stores one connection with the WHOOP user id; the state works once and only for its profile', async () => {
  const { h, w } = hub();
  const st = stateOf(h.oauthStart('u1', 'whoop', CB));
  // someone else's browser holding my state
  await assert.rejects(h.oauthFinish({ state: st, code: 'good' }, 'u2'), e => e.status === 403);
  // the refusal used the state up: a replay is refused too
  const st2 = stateOf(h.oauthStart('u1', 'whoop', CB));
  const out = await h.oauthFinish({ state: st2, code: 'good' }, 'u1');
  assert.equal(out.uid, 'u1');
  assert.equal(out.connection.provider, 'whoop');
  assert.equal(out.connection.info.whoopUser, '4242');
  assert.equal(out.connection.label, 'Ana Lift');
  await assert.rejects(h.oauthFinish({ state: st2, code: 'good' }, 'u1'), e => e.status === 400 && e.code === 'state');
  // the token exchange sent the same redirect address
  const ex = w.calls.find(c => c.form?.grant_type === 'authorization_code');
  assert.equal(ex.form.redirect_uri, CB);
  // a second sign-in replaces the first
  const st3 = stateOf(h.oauthStart('u1', 'whoop', CB));
  await h.oauthFinish({ state: st3, code: 'good' }, 'u1');
  assert.equal(h.describe('u1').connections.length, 1);
});

test('an expired state, a refusal on WHOOP’s page and a bad code fail with a reason naming WHOOP', async () => {
  let t = Date.now();
  const { h } = hub({ now: () => t });
  const st = stateOf(h.oauthStart('u1', 'whoop', CB));
  t += OAUTH_STATE_MS + 1;
  await assert.rejects(h.oauthFinish({ state: st, code: 'good' }, 'u1'), e => e.code === 'state');
  const no = stateOf(h.oauthStart('u1', 'whoop', CB));
  await assert.rejects(h.oauthFinish({ state: no, error: 'access_denied' }, 'u1'), e => e.code === 'denied' && e.provider === 'whoop');
  const bad = stateOf(h.oauthStart('u1', 'whoop', CB));
  await assert.rejects(h.oauthFinish({ state: bad, code: 'nope' }, 'u1'), e => e.code === 'exchange' && e.provider === 'whoop');
  assert.equal(h.describe('u1').connections.length, 0);
});

/* ---- C2: the token gate (whoop/client.js) ---- */

async function connected({ w = fakeWhoop(), start = Date.now() } = {}) {
  let t = start;
  const env = hub({ w, now: () => t });
  const st = stateOf(env.h.oauthStart('u1', 'whoop', CB));
  const { connection } = await env.h.oauthFinish({ state: st, code: 'good' }, 'u1');
  return { ...env, id: connection.id, at: () => t, advance: ms => { t += ms; } };
}
const refreshes = w => w.calls.filter(c => c.form?.grant_type === 'refresh_token');

test('two checks on an expired token refresh once, and the second uses the token the first stored', async () => {
  const c = await connected();
  c.advance(2 * 3600_000);
  let release;
  c.w.holdToken = new Promise(r => { release = r; });
  const a = c.h.test('u1', c.id), b = c.h.test('u1', c.id);
  await new Promise(r => setTimeout(r, 20));
  c.w.holdToken = null; release();
  const [ra, rb] = await Promise.all([a, b]);
  // A second refresh would spend r1 again, which WHOOP voided on the first.
  assert.equal(refreshes(c.w).length, 1);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(rb.connection.status, 'connected');
});

test('a refreshed pair that cannot be saved is never used: attention, no API call with it', async () => {
  const c = await connected();
  c.advance(2 * 3600_000);
  const store = c.h._store();
  const real = store.update;
  let failNext = true;
  store.update = (uid, id, fn) => {
    if (failNext) { failNext = false; throw new Error('disk full'); }
    return real(uid, id, fn);
  };
  const r = await c.h.test('u1', c.id);
  store.update = real;
  assert.equal(r.ok, false);
  const refreshed = refreshes(c.w).length;
  assert.equal(refreshed, 1);
  // after the refresh, nothing went to the profile endpoint with the unsaved token
  const after = c.w.calls.slice(c.w.calls.findIndex(x => x.form?.grant_type === 'refresh_token') + 1);
  assert.equal(after.filter(x => x.url.includes('/v2/')).length, 0);
  assert.equal(c.h.describe('u1').connections[0].status, 'attention');
});

test('refresh failures by what they prove: refused, busy, never sent, answer lost', async () => {
  // refused (WHOOP voided the token): attention and paused
  const refused = await connected();
  refused.advance(2 * 3600_000);
  for (const k of refused.w.refresh.keys()) refused.w.refresh.set(k, false);
  assert.equal((await refused.h.test('u1', refused.id)).ok, false);
  let conn = refused.h.describe('u1').connections[0];
  assert.equal(conn.status, 'attention');
  assert.equal(conn.paused, true);

  // never sent (DNS): the tokens are kept and the next try works
  const dns = await connected();
  dns.advance(2 * 3600_000);
  dns.w.notSentOnce = true;
  assert.equal((await dns.h.test('u1', dns.id)).ok, false);
  assert.notEqual(dns.h.describe('u1').connections[0].status, 'attention');
  assert.equal((await dns.h.test('u1', dns.id)).ok, true);

  // WHOOP took the refresh token, then the answer was lost: attention, and r1 is never sent again
  const lost = await connected();
  lost.advance(2 * 3600_000);
  lost.w.throwAfterRefresh = true;
  assert.equal((await lost.h.test('u1', lost.id)).ok, false);
  conn = lost.h.describe('u1').connections[0];
  assert.equal(conn.status, 'attention');
  assert.equal(conn.lastError.code, 'lost');
  await lost.h.test('u1', lost.id);
  assert.equal(refreshes(lost.w).length, 1);
});
