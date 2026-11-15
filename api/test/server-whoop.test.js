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
