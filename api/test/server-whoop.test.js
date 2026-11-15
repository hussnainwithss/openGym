/* WHOOP's routes through the real server.js: the webhook is reachable without a session and checks
 * WHOOP's signature over the raw body; the sign-in start sends a short state. Nothing here leaves
 * the machine (no connection exists, so the server never calls WHOOP). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const USERS = [{ id: 'u_w_1', name: 'One', created: new Date().toISOString() }];
const WHOOP = { INTEGRATIONS: 'whoop', WHOOP_CLIENT_ID: 'wid', WHOOP_CLIENT_SECRET: 'wsecret', ORIGIN: 'https://gym.example.com' };
function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

async function startServer(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-whoop-srv-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: USERS, creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...env },
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  return h;
}
const hook = (h, raw, headers = {}) => fetch(h.api + '/api/integrations/whoop/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw });
const signed = raw => {
  const ts = String(Date.now());
  return { 'X-WHOOP-Signature': crypto.createHmac('sha256', 'wsecret').update(ts + raw).digest('base64'), 'X-WHOOP-Signature-Timestamp': ts };
};

test('the webhook takes a signed delivery without a session, refuses a bad signature and an oversized body', async t => {
  const h = await startServer(t, WHOOP);
  // byte-exact: the signature covers the raw bytes, spacing included
  const raw = '{ "user_id": 4242, "id": "00000000-0000-4000-8000-000000000001", "type": "sleep.updated", "trace_id": "t1" }';
  assert.equal((await hook(h, raw, signed(raw))).status, 204);
  assert.equal((await hook(h, raw, signed(raw.replace('t1', 't2')))).status, 401);
  assert.equal((await hook(h, raw)).status, 401);
  const big = '{"pad":"' + 'x'.repeat(9000) + '"}';
  assert.equal((await hook(h, big, signed(big))).status, 413);
});

test('without WHOOP switched on, the webhook route answers 404', async t => {
  const h = await startServer(t);
  const raw = '{}';
  assert.equal((await hook(h, raw, signed(raw))).status, 404);
});

test('the sign-in start sends a signed-in browser to WHOOP with an 8-character state', async t => {
  const h = await startServer(t, WHOOP);
  const r = await fetch(h.api + '/api/integrations/oauth/start?provider=whoop', { redirect: 'manual', headers: { Cookie: `gymsid=${mintSession('u_w_1')}`, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('location'));
  assert.equal(to.host, 'api.prod.whoop.com');
  assert.equal(to.searchParams.get('state').length, 8);
  assert.equal(to.searchParams.get('redirect_uri'), 'https://gym.example.com/api/integrations/oauth/callback');
});

test('a device cannot write what only the server writes: its whoopActs are replaced by the stored ones', async t => {
  const h = await startServer(t, WHOOP);
  const stored = { _rev: 4, unit: 'kg', workouts: [], routines: [], whoopActs: { wAAA: { gone: 1, _ts: 100 } } };
  fs.writeFileSync(path.join(h.dataDir, 'state-u_w_1.json'), JSON.stringify(stored));
  const headers = { Cookie: `gymsid=${mintSession('u_w_1')}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  const sent = { ...stored, whoopActs: { wAAA: { d: '2026-11-01', sport: 'run', min: 5, _ts: 999 }, wBBB: { gone: 1, _ts: 999 } } };
  const put = await fetch(h.api + '/api/data', { method: 'PUT', headers, body: JSON.stringify({ state: sent, baseRev: 4 }) });
  assert.equal(put.status, 200);
  const doc = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'state-u_w_1.json'), 'utf8'));
  assert.deepEqual(doc.whoopActs, stored.whoopActs);
  // one revision further than the device was told, so it reads the corrected copy
  assert.equal(doc._rev, 6);
  // and a device that sent none does not delete the stored ones
  const put2 = await fetch(h.api + '/api/data', { method: 'PUT', headers, body: JSON.stringify({ state: { ...stored, _rev: 6, whoopActs: undefined }, baseRev: 6 }) });
  assert.equal(put2.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'state-u_w_1.json'), 'utf8')).whoopActs, stored.whoopActs);
});

test('GET /api/whoop/days reads the server’s WHOOP history, older than the profile’s 120 days too, for its own profile only', async t => {
  const h = await startServer(t, WHOOP);
  // a stored WHOOP history with one night two years back (normalized shape, whoop/store.js)
  const start = Date.UTC(2024, 10, 1, 22), end = start + 8 * 3600_000;
  const doc = { v: 1, whoopUser: '4242', records: { cycle: {}, recovery: {}, workout: {},
    sleep: { 'aaaaaaaa-0000-4000-8000-000000000001': { id: 'aaaaaaaa-0000-4000-8000-000000000001', start, end, off: 0, nap: false, st: 'scored', asleepMin: 400 } } },
    sleepCycle: {}, cursors: {}, pending: {}, candidates: {}, due: {}, body: null, obs: [], proj: { dirty: false, version: 0, at: 0 } };
  fs.mkdirSync(path.join(h.dataDir, 'whoop'), { recursive: true });
  fs.writeFileSync(path.join(h.dataDir, 'whoop', 'u-u_w_1.json'), JSON.stringify(doc));
  const get = (q, cookie = true) => fetch(h.api + '/api/whoop/days' + q, { headers: cookie ? { Cookie: `gymsid=${mintSession('u_w_1')}`, 'Sec-Fetch-Site': 'same-origin' } : {} });
  const r = await get('?from=2024-10-15&to=2024-11-30');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).days.map(d => [d.d, d.sleepMin]), [['2024-11-02', 400]]);
  assert.equal((await get('?from=2024-01-01&to=2026-01-01')).status, 400);
  assert.equal((await get('?from=nope&to=2024-11-30')).status, 400);
  assert.equal((await get('?from=2024-10-15&to=2024-11-30', false)).status, 401);
});

test('a WHOOP choice another device added survives a write from an app that sends the map without it', async t => {
  const h = await startServer(t, WHOOP);
  const stored = { _rev: 2, unit: 'kg', workouts: [], routines: [], whoopChoice: { a: { ov: 'skip', _ts: 100 } } };
  fs.writeFileSync(path.join(h.dataDir, 'state-u_w_1.json'), JSON.stringify(stored));
  const headers = { Cookie: `gymsid=${mintSession('u_w_1')}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  const put = await fetch(h.api + '/api/data', { method: 'PUT', headers, body: JSON.stringify({ state: { ...stored, whoopChoice: { b: { ov: 'keep', _ts: 120 } } }, baseRev: 2, stamped: true }) });
  assert.equal(put.status, 200);
  const doc = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'state-u_w_1.json'), 'utf8'));
  assert.deepEqual(doc.whoopChoice, { a: { ov: 'skip', _ts: 100 }, b: { ov: 'keep', _ts: 120 } });
});

test('the sign-in start sets a browser binding cookie, and a callback without it is refused before anything is exchanged', async t => {
  const h = await startServer(t, WHOOP);
  const r = await fetch(h.api + '/api/integrations/oauth/start?provider=whoop', { redirect: 'manual', headers: { Cookie: `gymsid=${mintSession('u_w_1')}`, 'Sec-Fetch-Site': 'same-origin' } });
  const cookie = r.headers.get('set-cookie');
  const parts = cookie.split('; ');
  assert.match(parts[0], /^og_oauth_bind=[A-Za-z0-9_-]+$/);
  assert.deepEqual(parts.slice(1), ['Path=' + '/api/integrations/oauth', 'Max-Age=600', 'HttpOnly', 'SameSite=Lax', 'Secure']);
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  const cb = await fetch(h.api + '/api/integrations/oauth/callback?state=' + state + '&code=x', { redirect: 'manual' });
  assert.equal(cb.headers.get('location'), 'https://gym.example.com/#/settings/integrations?intg=whoop&error=state');
});

test('an API token cannot change WHOOP data only the server writes', async () => {
  const { mergeScoped } = await import('../tokens.js');
  const cur = { activities: {}, whoopActs: { w1: { gone: 1, _ts: 1 } } };
  assert.throws(() => mergeScoped(cur, { whoopActs: {} }, { workouts: 'apply' }), e => e.status === 403);
  assert.doesNotThrow(() => mergeScoped(cur, { whoopActs: cur.whoopActs }, { workouts: 'apply' }));
});
