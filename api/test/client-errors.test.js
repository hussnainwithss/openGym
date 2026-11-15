/* Fork: start-up failure reports from the web app (client-errors.js, POST /api/client-error). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { cleanReport, createClientErrorLog } from '../client-errors.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a report keeps only known fields, clipped, and is refused without a known kind', () => {
  // bug caught: an unknown field (or a huge one) reaching the log file
  const r = cleanReport({ kind: 'error', msg: 'x'.repeat(900), evil: 'y', stage: 'config\nfake', ms: 1234.6, online: false,
    stages: [{ s: 'script', t: 10 }, 'junk', { s: '', t: 1 }, { s: 'boot', t: -5 }] });
  assert.deepEqual(r, { kind: 'error', msg: 'x'.repeat(500), stage: 'config\nfake', ms: 1235, online: false,
    stages: [{ s: 'script', t: 10 }, { s: 'boot', t: 0 }] });
  for (const bad of [null, [], 'error', {}, { kind: 'other' }]) assert.equal(cleanReport(bad), null);
});

test('reports are written one per line and limited per address', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-cerr-'));
  const file = path.join(dir, 'client-errors.log');
  const lines = [];
  const L = createClientErrorLog({ file, log: s => lines.push(s), perAddress: 2, now: () => Date.UTC(2026, 10, 15) });
  assert.equal(L.record('1.2.3.4', null, { kind: 'stuck', stage: 'config' }), 'logged');
  assert.equal(L.record('1.2.3.4', null, { kind: 'error', msg: 'a\nb' }), 'logged');
  assert.equal(L.record('1.2.3.4', null, { kind: 'error' }), 'limited');
  assert.equal(L.record('5.6.7.8', '5.6.7.0/24', { kind: 'nope' }), 'invalid');
  assert.equal(L.record('5.6.7.8', '5.6.7.0/24', { kind: 'rejection' }), 'logged');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows, [
    { ts: '2026-11-15T00:00:00.000Z', kind: 'stuck', stage: 'config' },
    { ts: '2026-11-15T00:00:00.000Z', kind: 'error', msg: 'a\nb' },
    { ts: '2026-11-15T00:00:00.000Z', ip: '5.6.7.0/24', kind: 'rejection' },
  ]);
  assert.equal(lines.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST /api/client-error needs no session, logs the report, and refuses junk', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-cerr-srv-'));
  fs.writeFileSync(path.join(dir, 'secret'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));
  fs.writeFileSync(path.join(dir, 'vapid.json'), JSON.stringify(webpush.generateVAPIDKeys()));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  let log = '';
  const port = await new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error(`no port:\n${log}`)), 20000);
    child.stdout.on('data', d => { log += d; const m = /gym-api on :(\d+)/.exec(log); if (m) { clearTimeout(give); resolve(+m[1]); } });
    child.stderr.on('data', d => { log += d; });
  });
  const post = body => fetch(`http://127.0.0.1:${port}/api/client-error`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body
  });
  assert.equal((await post(JSON.stringify({ kind: 'error', msg: 'boom', stage: 'config' }))).status, 204);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post(JSON.stringify({ kind: 'error', stack: 'x'.repeat(20000) }))).status, 413);
  const rows = fs.readFileSync(path.join(dir, 'client-errors.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].msg, 'boom');
  assert.equal(rows[0].stage, 'config');
});
