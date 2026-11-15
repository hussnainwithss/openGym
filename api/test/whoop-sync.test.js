/* The WHOOP pull (integrations/whoop/sync.js) against a pretend WHOOP: the backfill of a whole
 * history, its resume after a restart, and how the profile is written. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createIntegrations } = await import('../integrations/index.js');
const { fakeWhoop, ENV, rec } = await import('./fake-whoop.mjs');

const SECRET = 'c'.repeat(64);
const CB = 'https://gym.example.com/api/integrations/oauth/callback';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 15, 12);

/** A hub with one connected profile, a pretend profile store and a movable clock. */
export async function setup({ w = fakeWhoop(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-whoop-sync-')), clock = { t: T0 }, S = {}, connect = true } = {}) {
  const h = createIntegrations({ dataDir, secret: SECRET, env: ENV, fetchFn: w.fetchFn, now: () => clock.t });
  const profile = { S, writes: 0 };
  h.attach({
    users: () => [{ id: 'u1' }],
    readState: () => profile.S,
    writeState: (uid, fn, { skipIf } = {}) => {
      const next = JSON.parse(JSON.stringify(profile.S));
      const r = fn(next, clock.t);
      if (skipIf && skipIf(r)) return r;
      profile.S = next; profile.writes++;
      return r;
    },
  });
  let id = h.describe('u1').connections.find(c => c.provider === 'whoop')?.id;
  if (connect) {
    const st = new URL(h.oauthStart('u1', 'whoop', CB)).searchParams.get('state');
    id = (await h.oauthFinish({ state: st, code: 'good' }, 'u1')).connection.id;
  }
  return { h, w, dataDir, clock, profile, id, sync: h._whoopSync(), doc: () => h._whoopStore().load('u1') };
}

function history(w, n, { from = T0 - 200 * DAY } = {}) {
  for (let i = 0; i < n; i++) {
    const s = from + i * DAY;
    w.cycle.push(rec.cycle({ id: 1000 + i, start: s, end: s + DAY }));
    const sl = rec.sleep({ cycle: 1000 + i, start: s - 8 * 3600_000, end: s });
    w.sleep.push(sl);
    w.recovery.push(rec.recovery({ cycle: 1000 + i, sleep: sl.id, at: s + 600_000 }));
    w.workout.push(rec.workout({ start: s + 5 * 3600_000, end: s + 6 * 3600_000 }));
  }
}

test('a whole history of three pages per collection lands in the WHOOP store in one tick', async () => {
  const c = await setup();
  history(c.w, 60);
  await c.sync.tick();
  const d = c.doc();
  for (const coll of ['cycle', 'sleep', 'recovery', 'workout']) {
    assert.equal(Object.keys(d.records[coll]).length, 60, coll);
    assert.equal(d.cursors[coll].done, true, coll);
  }
  assert.equal(c.h.describe('u1').connections[0].info.backfill, 'done');
  // pages of at most 25, with one fixed end for the whole backfill
  const sleepCalls = c.w.calls.filter(x => x.url.includes('/v2/activity/sleep'));
  assert.equal(sleepCalls.length, 3);
  assert.equal(new Set(sleepCalls.map(x => new URL(x.url).searchParams.get('end'))).size, 1);
});

test('a backfill cut off by a failure resumes after a restart with the same bounds: nothing lost, nothing twice', async () => {
  const w = fakeWhoop();
  history(w, 60);
  w.failPage = (coll, page) => (coll === 'sleep' && page === 1 ? 503 : null);
  const first = await setup({ w });
  await first.sync.tick();
  assert.equal(Object.keys(first.doc().records.sleep).length, 25);
  const end = first.doc().cursors.sleep.end;
  // restart: a new hub on the same data, later, with newer sleeps WHOOP got meanwhile
  w.failPage = null;
  const clock = { t: T0 + 2 * DAY };
  for (let i = 0; i < 3; i++) w.sleep.push(rec.sleep({ cycle: 5000 + i, start: T0 + DAY + i * 3600_000, end: T0 + DAY + (i + 1) * 3600_000 }));
  const again = await setup({ w, dataDir: first.dataDir, clock, connect: false });
  await again.sync.tick();
  const d = again.doc();
  // the backfill kept its fixed end and finished; the poll that follows brought the 3 newer ones
  assert.equal(d.cursors.sleep.end, end);
  assert.equal(Object.keys(d.records.sleep).length, 63);
  assert.equal(d.cursors.sleep.done, true);
});

test('a listing that repeats its page token stops instead of looping', async () => {
  const w = fakeWhoop();
  history(w, 2);
  const real = w.handler;
  w.handler = async (url, o) => {
    const r = await real(url, o);
    if (url.includes('/v2/activity/workout')) return { ...r, json: async () => ({ records: [], next_token: 'same' }) };
    return r;
  };
  const c = await setup({ w });
  await c.sync.tick();
  const calls = w.calls.filter(x => x.url.includes('/v2/activity/workout')).length;
  assert.ok(calls <= 2, `asked ${calls} times`);
  assert.equal(c.doc().cursors.workout.done, false);
  assert.equal(c.h.describe('u1').connections[0].lastError.code, 'http');
});

test('the profile is written once per tick, not once per record, and not at all when nothing changed', async () => {
  const c = await setup();
  c.h._projectors.push((S, doc) => {
    const n = Object.keys(doc.records.sleep).length;
    if (S.sleeps === n) return false;
    S.sleeps = n; return true;
  });
  history(c.w, 60);
  await c.sync.tick();
  assert.equal(c.profile.writes, 1);
  assert.equal(c.profile.S.sleeps, 60);
  await c.sync.tick();
  assert.equal(c.profile.writes, 1);
});

test('a profile with no server document yet keeps its history pending and gets it once it syncs', async () => {
  const c = await setup();
  let refuse = true;
  const write = c.h._projectors;
  write.push((S, doc) => { if (S.n === Object.keys(doc.records.cycle).length) return false; S.n = Object.keys(doc.records.cycle).length; return true; });
  // writeStateAs answers 409 not-synced for a profile with no document
  const attachRefusing = () => c.h.attach({
    users: () => [{ id: 'u1' }], readState: () => c.profile.S,
    writeState: (uid, fn, o) => {
      if (refuse) throw Object.assign(new Error('not synced'), { status: 409 });
      const next = { ...c.profile.S }; const r = fn(next, c.clock.t); if (o?.skipIf?.(r)) return r; c.profile.S = next; c.profile.writes++; return r;
    },
  });
  attachRefusing();
  history(c.w, 3);
  await c.sync.tick();
  assert.equal(c.doc().proj.dirty, true);
  refuse = false;
  await c.sync.tick();
  assert.equal(c.profile.S.n, 3);
  assert.equal(c.doc().proj.dirty, false);
});

/* ---- C4: the 15-minute poll ---- */

const MIN = 60_000;
async function backfilled(opts = {}) {
  const c = await setup(opts);
  await c.sync.tick();
  assert.equal(c.doc().cursors.workout.done, true);
  return c;
}
const workoutsIn = c => Object.keys(c.doc().records.workout);

test('an edit and a deletion inside the window show on the next poll; a failed page deletes nothing', async () => {
  const w = fakeWhoop();
  const keep = rec.workout({ start: T0 - DAY, end: T0 - DAY + 3600_000 });
  const gone = rec.workout({ start: T0 - 2 * DAY, end: T0 - 2 * DAY + 3600_000 });
  w.workout.push(keep, gone);
  const c = await backfilled({ w });
  keep.score.strain = 15.5;
  w.workout.splice(w.workout.indexOf(gone), 1);
  // first, a poll whose workout listing fails: nothing becomes a delete candidate
  w.failPage = coll => (coll === 'workout' ? 503 : null);
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  assert.deepEqual(c.doc().candidates.workout, []);
  assert.ok(workoutsIn(c).includes(gone.id));
  w.failPage = null;
  c.clock.t += MIN;
  await c.sync.tick();
  assert.equal(c.doc().records.workout[keep.id].strain, 15.5);
  assert.ok(!workoutsIn(c).includes(gone.id));
});

test('a listing that leaves out a record WHOOP still has does not delete it', async () => {
  const w = fakeWhoop();
  const r1 = rec.workout({ start: T0 - DAY, end: T0 - DAY + 3600_000 });
  w.workout.push(r1);
  const c = await backfilled({ w });
  const real = w.handler;
  w.handler = async (url, o) => {
    const r = await real(url, o);
    if (url.includes('/v2/activity/workout?')) { const d = await r.json(); return { ...r, json: async () => ({ ...d, records: d.records.filter(x => x.id !== r1.id) }) }; }
    return r;
  };
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  assert.ok(workoutsIn(c).includes(r1.id));
  assert.deepEqual(c.doc().candidates.workout, []);
});

test('a delete candidate whose check fails is kept, and settled after a restart past the window', async () => {
  const w = fakeWhoop();
  const r1 = rec.workout({ start: T0 - 2.9 * DAY, end: T0 - 2.9 * DAY + 3600_000 });
  w.workout.push(r1);
  const c = await backfilled({ w });
  w.workout.length = 0;
  const real = w.handler;
  let failById = true;
  w.handler = async (url, o) => (failById && url.includes('/v2/activity/workout/') ? { status: 503, json: async () => ({}), headers: { get: () => null } } : real(url, o));
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  assert.deepEqual(c.doc().candidates.workout, [r1.id]);
  failById = false;
  const clock = { t: c.clock.t + 2 * DAY };
  const again = await setup({ w, dataDir: c.dataDir, clock, connect: false });
  await again.sync.tick();
  assert.ok(!Object.keys(again.doc().records.workout).includes(r1.id));
  assert.deepEqual(again.doc().candidates.workout, []);
});

test('after ten days off, the next poll brings in everything that happened meanwhile', async () => {
  const c = await backfilled();
  c.clock.t += 10 * DAY;
  const during = rec.workout({ start: T0 + 2 * DAY, end: T0 + 2 * DAY + 3600_000 });
  c.w.workout.push(during);
  await c.sync.tick();
  assert.ok(workoutsIn(c).includes(during.id));
});

test('a score still pending, older than the window, is asked for by id until it is scored', async () => {
  const w = fakeWhoop();
  const p = rec.workout({ start: T0 - 6 * DAY, end: T0 - 6 * DAY + 3600_000, state: 'PENDING_SCORE' });
  w.workout.push(p);
  const c = await backfilled({ w });
  assert.deepEqual(c.doc().pending.workout, [p.id]);
  Object.assign(p, rec.workout({ id: p.id, start: T0 - 6 * DAY, end: T0 - 6 * DAY + 3600_000 }));
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  assert.equal(c.doc().records.workout[p.id].st, 'scored');
  assert.deepEqual(c.doc().pending.workout, []);
});

test('paused, or the Integrations module off: no request at all', async () => {
  const c = await backfilled();
  const before = c.w.calls.length;
  c.profile.S = { modules: { integrations: false } };
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  c.profile.S = {};
  c.h.update('u1', c.id, { paused: true });
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  assert.equal(c.w.calls.length, before);
});

test('a 429 on page two blocks every request until WHOOP’s reset, then the listing resumes without gaps', async () => {
  const w = fakeWhoop();
  history(w, 60);
  w.pageSize = 25;
  // let the cycle listing's first page through, then refuse
  const real = w.handler;
  let n = 0;
  w.handler = async (url, o) => {
    if (url.includes('/v2/cycle?') && ++n === 2) { w.limited = 1; w.resetSec = 120; }
    return real(url, o);
  };
  const c = await setup({ w });
  await c.sync.tick();
  const asked = w.calls.length;
  c.clock.t += 60_000;
  await c.sync.tick();
  assert.equal(w.calls.length, asked, 'asked WHOOP again before its reset');
  c.clock.t += 61_000;
  await c.sync.tick();
  assert.equal(Object.keys(c.doc().records.cycle).length, 60);
  assert.deepEqual(c.doc().candidates.cycle, []);
});

/* ---- C5: who the history belongs to ---- */

test('Reconnect with the same WHOOP account keeps the history; another account starts over', async () => {
  const w = fakeWhoop();
  history(w, 3);
  const c = await backfilled({ w });
  const reconnect = async () => {
    const st = new URL(c.h.oauthStart('u1', 'whoop', CB)).searchParams.get('state');
    await c.h.oauthFinish({ state: st, code: 'good' }, 'u1');
  };
  await reconnect();
  const asked = w.calls.length;
  await c.sync.tick();
  // same account: no second backfill
  assert.equal(w.calls.length, asked);
  assert.equal(Object.keys(c.doc().records.cycle).length, 3);
  // a different account on the same profile
  w.userId = 777;
  w.cycle.length = 0;
  w.cycle.push(rec.cycle({ id: 9001, start: T0 - DAY }));
  await reconnect();
  await c.sync.tick();
  const d = c.doc();
  assert.equal(d.whoopUser, '777');
  assert.deepEqual(Object.keys(d.records.cycle), ['9001']);
});

/* ---- C6: WHOOP's webhook ---- */

import crypto from 'node:crypto';
const sign = (raw, ts, secret = 'wsecret') => crypto.createHmac('sha256', secret).update(ts + raw).digest('base64');
function deliver(c, ev, { ts = String(c.clock.t), secret } = {}) {
  const raw = JSON.stringify(ev);
  return c.h.whoopWebhook(Buffer.from(raw), { 'x-whoop-signature': sign(raw, ts, secret), 'x-whoop-signature-timestamp': ts });
}
const settle = () => new Promise(r => setTimeout(r, 30));

test('a signed webhook fetches the named record at once; a bad signature, a stale one or a replay does nothing', async () => {
  const w = fakeWhoop();
  const old = rec.workout({ start: T0 - 40 * DAY, end: T0 - 40 * DAY + 3600_000 });
  w.workout.push(old);
  const c = await backfilled({ w });
  old.score.strain = 19.9;
  const ev = { user_id: 4242, id: old.id, type: 'workout.updated', trace_id: 'tr-1' };
  const asked = w.calls.length;
  assert.deepEqual(deliver(c, ev, { secret: 'nope' }), { ok: false, status: 401 });
  assert.deepEqual(deliver(c, ev, { ts: String(c.clock.t - 6 * MIN) }), { ok: false, status: 401 });
  await settle();
  assert.equal(w.calls.length, asked);
  assert.deepEqual(deliver(c, ev), { ok: true });
  await settle();
  assert.equal(c.doc().records.workout[old.id].strain, 19.9);
  const after = w.calls.length;
  assert.deepEqual(deliver(c, ev), { ok: true });   // the same trace again
  await settle();
  assert.equal(w.calls.length, after);
  // another WHOOP account's event touches nobody
  assert.deepEqual(deliver(c, { ...ev, user_id: 1, trace_id: 'tr-2' }), { ok: true });
  await settle();
  assert.equal(w.calls.length, after);
});

for (const order of [['recovery.deleted', 'sleep.deleted'], ['sleep.deleted', 'recovery.deleted']]) {
  test(`a deleted sleep and its recovery leave the store, events in the order ${order.join(' then ')}`, async () => {
    const w = fakeWhoop();
    history(w, 1, { from: T0 - 30 * DAY });
    const c = await backfilled({ w });
    const sl = w.sleep[0], cyc = String(w.cycle[0].id);
    assert.ok(c.doc().records.recovery[cyc]);
    w.sleep.length = 0; w.recovery.length = 0;
    for (const [i, type] of order.entries()) { deliver(c, { user_id: 4242, id: sl.id, type, trace_id: 'd' + i }); await settle(); }
    const d = c.doc();
    assert.equal(d.records.sleep[sl.id], undefined);
    assert.equal(d.records.recovery[cyc], undefined);
  });
}
