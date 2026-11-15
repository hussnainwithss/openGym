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
