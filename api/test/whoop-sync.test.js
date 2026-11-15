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
  const profile = { S, writes: 0, users: [{ id: 'u1' }] };
  h.attach({
    users: () => profile.users,
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
// Waits for the run a webhook started: it holds the connection's gate, so this queues behind it.
const settle = c => new Promise(r => setImmediate(r)).then(() => c.h._whoop().withGate('u1', c.id, async () => {}));

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
  await settle(c);
  assert.equal(w.calls.length, asked);
  assert.deepEqual(deliver(c, ev), { ok: true });
  await settle(c);
  assert.equal(c.doc().records.workout[old.id].strain, 19.9);
  const after = w.calls.length;
  assert.deepEqual(deliver(c, ev), { ok: true });   // the same trace again
  await settle(c);
  assert.equal(w.calls.length, after);
  // another WHOOP account's event touches nobody
  assert.deepEqual(deliver(c, { ...ev, user_id: 1, trace_id: 'tr-2' }), { ok: true });
  await settle(c);
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
    for (const [i, type] of order.entries()) { deliver(c, { user_id: 4242, id: sl.id, type, trace_id: 'd' + i }); await settle(c); }
    const d = c.doc();
    assert.equal(d.records.sleep[sl.id], undefined);
    assert.equal(d.records.recovery[cyc], undefined);
  });
}

/* ---- C7: nothing written for a connection or an account that is gone ---- */

function holdListings(w) {
  let release;
  const gate = new Promise(r => { release = r; });
  const real = w.handler;
  w.handler = async (url, o) => { if (url.includes('/v2/cycle?')) await gate; return real(url, o); };
  return () => { w.handler = real; release(); };
}

test('a fetch in flight when WHOOP is disconnected, or the account deleted, writes nothing when it lands', async () => {
  for (const end of ['disconnect', 'delete']) {
    const w = fakeWhoop();
    history(w, 3);
    const c = await setup({ w });
    c.h._projectors.push(S => { S.touched = true; return true; });
    const release = holdListings(w);
    const run = c.sync.tick();
    await new Promise(r => setTimeout(r, 20));
    if (end === 'disconnect') c.h.disconnect('u1', c.id);
    else { c.profile.users = []; c.h.removeUser('u1'); }
    release();
    await run;
    assert.equal(c.profile.writes, 0, end);
    assert.equal(fs.existsSync(path.join(c.dataDir, 'whoop', 'u-u1.json')), false, end);
  }
});

test('a WHOOP sign-in that lands after a newer one, a disconnect or the account’s deletion is refused', async () => {
  const w = fakeWhoop();
  const c = await setup({ w, connect: false });
  const start = () => new URL(c.h.oauthStart('u1', 'whoop', CB)).searchParams.get('state');
  let release;
  // two sign-ins in flight; the newer finishes first
  w.holdToken = new Promise(r => { release = r; });
  const older = c.h.oauthFinish({ state: start(), code: 'good' }, 'u1');
  const newer = c.h.oauthFinish({ state: start(), code: 'good' }, 'u1');
  w.holdToken = null; release();
  const [o, n] = await Promise.allSettled([older, newer]);
  assert.equal(o.status, 'rejected');
  assert.equal(o.reason.code, 'stale');
  assert.equal(n.status, 'fulfilled');
  assert.equal(c.h.describe('u1').connections[0].id, n.value.connection.id);
  // disconnect while a sign-in is on its way back
  w.holdToken = new Promise(r => { release = r; });
  const again = c.h.oauthFinish({ state: start(), code: 'good' }, 'u1');
  c.h.disconnect('u1', n.value.connection.id);
  w.holdToken = null; release();
  await assert.rejects(again, e => e.code === 'stale');
  assert.equal(c.h.describe('u1').connections.length, 0);
  // the account deleted while a sign-in is on its way back
  w.holdToken = new Promise(r => { release = r; });
  const late = c.h.oauthFinish({ state: start(), code: 'good' }, 'u1');
  c.profile.users = []; c.h.removeUser('u1');
  w.holdToken = null; release();
  await assert.rejects(late);
  assert.equal(fs.existsSync(path.join(c.dataDir, 'integrations', 'u-u1.json')), false);
});

test('deleting an account removes its WHOOP files even when WHOOP is switched off at this start', async () => {
  const w = fakeWhoop();
  history(w, 1);
  const c = await backfilled({ w });
  assert.ok(fs.existsSync(path.join(c.dataDir, 'whoop', 'u-u1.json')));
  const off = createIntegrations({ dataDir: c.dataDir, secret: SECRET, env: {}, now: () => c.clock.t });
  off.removeUser('u1');
  assert.equal(fs.existsSync(path.join(c.dataDir, 'whoop', 'u-u1.json')), false);
  assert.equal(fs.existsSync(path.join(c.dataDir, 'integrations', 'u-u1.json')), false);
});

/* ---- whoop-activities A1: WHOOP workouts become activities ---- */

const { whoopActivityId, activityOf } = await import('../integrations/whoop/activities.js');

test('a WHOOP run becomes one activity with its WHOOP details, written once and never again', async () => {
  const w = fakeWhoop();
  const run = rec.workout({ start: T0 - DAY, end: T0 - DAY + 42 * MIN, km: 8.1, strain: 11.2 });
  w.workout.push(run);
  const c = await backfilled({ w });
  const id = whoopActivityId(run.id);
  const { _ts, ...a } = c.profile.S.activities[id];
  assert.deepEqual(a, { d: '2026-11-14', sport: 'run', min: 42, at: T0 - DAY, durMs: 42 * MIN, src: 'whoop', wu: run.id, wa: '4242', km: 8.1, strain: 11.2, hr: 140, hrMax: 172, kj: 1500 });
  assert.ok(_ts > 0);
  // the id does not depend on anything but the WHOOP workout
  assert.equal(whoopActivityId(run.id), id);
  const writes = c.profile.writes;
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  assert.equal(c.profile.writes, writes);
});

test('an activity the person removed is never imported again', async () => {
  const w = fakeWhoop();
  const run = rec.workout({ start: T0 - DAY, end: T0 - DAY + 3600_000 });
  w.workout.push(run);
  const id = whoopActivityId(run.id);
  const c = await setup({ w, S: { activities: { [id]: { _ts: 1 } } } });
  await c.sync.tick();
  assert.deepEqual(c.profile.S.activities[id], { _ts: 1 });
});

test('the day is the workout’s own local day; strength work is marked; a 20-second session is a minute', async () => {
  const w = fakeWhoop();
  // 23:30 in Riyadh is 20:30 UTC: the 14th there, whatever zone the server runs in
  const late = rec.workout({ start: Date.UTC(2026, 10, 14, 20, 30), end: Date.UTC(2026, 10, 14, 21, 30), offset: '+03:00' });
  // 00:30 local the next day, still the 14th in UTC
  const night = rec.workout({ start: Date.UTC(2026, 10, 14, 21, 30), end: Date.UTC(2026, 10, 14, 22, 0), offset: '+03:00' });
  const lift = rec.workout({ start: T0 - 2 * DAY, end: T0 - 2 * DAY + 3600_000, sport: 'weightlifting' });
  const blip = rec.workout({ start: T0 - 3 * DAY, end: T0 - 3 * DAY + 20_000 });
  w.workout.push(late, night, lift, blip);
  const c = await backfilled({ w });
  const A = c.profile.S.activities;
  assert.equal(A[whoopActivityId(late.id)].d, '2026-11-14');
  assert.equal(A[whoopActivityId(night.id)].d, '2026-11-15');
  assert.equal(A[whoopActivityId(lift.id)].st, 1);
  assert.equal(A[whoopActivityId(lift.id)].sport, 'other');
  assert.equal(A[whoopActivityId(lift.id)].title, 'Weightlifting');
  assert.equal(A[whoopActivityId(blip.id)].min, 1);
  assert.equal(A[whoopActivityId(blip.id)].durMs, 20_000);
});

/* ---- whoop-activities A3: WHOOP's later changes and deletions ---- */

const { effectiveActivity } = await import('../coach/core/whoop-activities.js');

test('a WHOOP change after import goes to whoopActs and shows; a deletion hides it; a session the person edited stays theirs', async () => {
  const w = fakeWhoop();
  const run = rec.workout({ start: T0 - DAY, end: T0 - DAY + 30 * MIN, strain: 9 });
  const ride = rec.workout({ start: T0 - 2 * DAY, end: T0 - 2 * DAY + 60 * MIN, sport: 'cycling' });
  const mine = rec.workout({ start: T0 - 3 * DAY, end: T0 - 3 * DAY + 45 * MIN });
  w.workout.push(run, ride, mine);
  const c = await backfilled({ w });
  const [rid, did, mid] = [run, ride, mine].map(r => whoopActivityId(r.id));
  // the person edits one on their phone (the app marks it edited)
  c.profile.S.activities[mid] = { ...c.profile.S.activities[mid], note: 'felt great', edited: 1, _ts: c.clock.t + 1 };
  run.score.strain = 14;
  mine.score.strain = 20;
  w.workout.splice(w.workout.indexOf(ride), 1);
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  const S = c.profile.S;
  // the stored activity is never rewritten; what WHOOP changed sits beside it
  assert.equal(S.activities[rid].strain, 9);
  assert.equal(S.whoopActs[rid].strain, 14);
  assert.equal(effectiveActivity(S, rid, S.activities[rid]).strain, 14);
  assert.deepEqual((({ _ts, ...g }) => g)(S.whoopActs[did]), { gone: 1 });
  assert.equal(effectiveActivity(S, did, S.activities[did]), null);
  assert.equal(S.whoopActs[mid], undefined);
  assert.equal(effectiveActivity(S, mid, S.activities[mid]).note, 'felt great');
});

test('another WHOOP account’s sessions are not marked deleted when the history starts over', async () => {
  const w = fakeWhoop();
  const run = rec.workout({ start: T0 - DAY, end: T0 - DAY + 30 * MIN });
  w.workout.push(run);
  const c = await backfilled({ w });
  w.userId = 777; w.workout.length = 0;
  const st = new URL(c.h.oauthStart('u1', 'whoop', CB)).searchParams.get('state');
  await c.h.oauthFinish({ state: st, code: 'good' }, 'u1');
  await c.sync.tick();
  assert.equal(c.profile.S.whoopActs?.[whoopActivityId(run.id)], undefined);
});

test('the server’s week streak leaves out a WHOOP session deleted in WHOOP', async () => {
  const { streakWalk } = await import('../coach/core/streak.js');
  const S = { weekStart: 1, activityStreak: true, workouts: [],
    activities: { wX: { d: '2026-11-10', sport: 'run', min: 30, src: 'whoop', wu: '00000000-0000-4000-8000-000000000009', _ts: 1 } } };
  assert.equal(streakWalk(S, '2026-11-11').thisWeekDone, true);
  assert.equal(streakWalk({ ...S, whoopActs: { wX: { gone: 1, _ts: 2 } } }, '2026-11-11').thisWeekDone, false);
});

test('the server’s week streak leaves out a WHOOP strength session the person skipped', async () => {
  const { streakWalk } = await import('../coach/core/streak.js');
  const S = { weekStart: 1, activityStreak: true, workouts: [], whoopStrength: 'skip',
    activities: { wL: { d: '2026-11-10', sport: 'other', min: 45, at: Date.UTC(2026, 10, 10, 7), durMs: 45 * MIN, src: 'whoop', st: 1, wu: '00000000-0000-4000-8000-000000000010', _ts: 1 } } };
  // no workout beside it: the default does not apply, it counts
  assert.equal(streakWalk(S, '2026-11-11').thisWeekDone, true);
  assert.equal(streakWalk({ ...S, whoopChoice: { wL: { ov: 'skip', _ts: 2 } } }, '2026-11-11').thisWeekDone, false);
});

/* ---- whoop-bodyweight: WHOOP's weight, when it changes ---- */

const whoopReadings = S => (S.bodyweight || []).flatMap(d => (d.ins || []).filter(r => r.src === 'whoop').map(r => ({ d: d.d, ...r })));

test('WHOOP’s weight is logged once when the history is in, again only when it changes, in the profile’s unit', async () => {
  const w = fakeWhoop();
  w.body.weight_kilogram = 80;
  const c = await backfilled({ w, S: { unit: 'lb' } });
  let rs = whoopReadings(c.profile.S);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].w, 176.4);   // 80 kg in lb, to 0.1
  const writes = c.profile.writes;
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  assert.equal(c.profile.writes, writes, 'unchanged weight wrote the profile');
  w.body.weight_kilogram = 79.95;   // any change counts, however small
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  rs = whoopReadings(c.profile.S);
  assert.equal(rs.length, 2);
  assert.notEqual(rs[0].id, rs[1].id);
  assert.deepEqual(c.doc().obs, []);
});

test('a weight observed but not yet in the profile when the server stops goes in once, with the same id', async () => {
  const w = fakeWhoop();
  const c = await setup({ w });
  // the profile write fails once (crash), the observation stays in the WHOOP store
  let fail = true;
  c.h.attach({ users: () => c.profile.users, readState: () => c.profile.S, writeState: (uid, fn, o) => {
    if (fail) { fail = false; throw new Error('crash'); }
    const next = JSON.parse(JSON.stringify(c.profile.S)); const r = fn(next, c.clock.t); if (o?.skipIf?.(r)) return r; c.profile.S = next; c.profile.writes++; return r;
  } });
  await c.sync.tick().catch(() => {});
  assert.equal(c.doc().obs.length, 1);
  const id = c.doc().obs[0].id;
  await c.sync.tick();
  assert.deepEqual(whoopReadings(c.profile.S).map(r => r.id), [id]);
  // written, but the WHOOP store never heard: replayed, nothing twice
  const store = c.h._whoopStore();
  const doc = store.load('u1');
  doc.obs.push({ ...c.profile.S.bodyweight[0], id, kg: 80, observedAt: c.clock.t, day: c.profile.S.bodyweight[0].d, hhmm: '12:00', off: 0 });
  doc.proj.dirty = true;
  store.save('u1', doc);
  c.clock.t += MIN;
  await c.sync.tick();
  assert.equal(whoopReadings(c.profile.S).length, 1);
});

test('a WHOOP weight the person deleted, or wiped with Reset, does not come back on a replay; a later change still does', async () => {
  const w = fakeWhoop();
  const c = await backfilled({ w });
  const id = whoopReadings(c.profile.S)[0].id;
  const day = c.profile.S.bodyweight[0].d;
  // deleted, then the day typed in again; the observation is replayed
  c.profile.S.bodyweight = [{ d: day, w: 81, t: c.clock.t + 1, ins: [{ id: 'typed', at: '07:00', w: 81, t: c.clock.t + 1 }] }];
  const store = c.h._whoopStore();
  const replay = () => { const d = store.load('u1'); d.obs.push({ id, kg: 80, observedAt: T0, day, hhmm: '12:00', off: 0 }); d.proj.dirty = true; store.save('u1', d); };
  replay();
  c.clock.t += MIN;
  await c.sync.tick();
  assert.deepEqual(c.profile.S.bodyweight[0].ins.map(r => r.id), ['typed']);
  // Reset everything: no weigh-ins at all; whoopSeen is the server's and stays
  c.profile.S.bodyweight = [];
  replay();
  c.clock.t += MIN;
  await c.sync.tick();
  assert.deepEqual(c.profile.S.bodyweight, []);
  w.body.weight_kilogram = 78;
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  assert.equal(whoopReadings(c.profile.S).length, 1);
});

test('the day and time are the person’s, fixed when the weight was observed', async () => {
  const w = fakeWhoop();
  // last night's sleep says the person is at +03:00; 20:55 UTC is 23:55 there
  w.sleep.push(rec.sleep({ cycle: 1, start: T0 - 2 * DAY, end: T0 - 2 * DAY + 7 * 3600_000, offset: '+03:00' }));
  const clock = { t: Date.UTC(2026, 10, 14, 20, 55) };
  let fail = true;
  const c = await setup({ w, clock });
  c.h.attach({ users: () => c.profile.users, readState: () => c.profile.S, writeState: (uid, fn, o) => {
    if (fail) { fail = false; throw Object.assign(new Error('not synced'), { status: 409 }); }
    const next = JSON.parse(JSON.stringify(c.profile.S)); const r = fn(next, c.clock.t); if (o?.skipIf?.(r)) return r; c.profile.S = next; return r;
  } });
  await c.sync.tick();
  // written only after midnight there
  c.clock.t += 10 * MIN;
  await c.sync.tick();
  const [r] = whoopReadings(c.profile.S);
  assert.equal(r.d, '2026-11-14');
  assert.equal(r.at, '23:55');
});

/* ---- whoop-vitals: WHOOP days ---- */

const { daysOf } = await import('../integrations/whoop/days.js');
const { scopedState } = await import('../tokens.js');
const H = 3600_000;
const N = (coll, list) => Object.fromEntries(list.map(r => [coll === 'recovery' ? String(r.cycle_id) : String(r.id), (NORM[coll])(r, T0)]));
const { NORMALIZE: NORM } = await import('../integrations/whoop/normalize.js');
const docOf = ({ sleep = [], recovery = [], cycle = [] }) => ({ records: { sleep: N('sleep', sleep), recovery: N('recovery', recovery), cycle: N('cycle', cycle), workout: {} }, sleepCycle: {} });

test('a WHOOP day is the local date the person woke up, with that sleep’s recovery and its cycle’s strain', () => {
  // asleep 22:00-06:30 at +03:00: 19:00-03:30 UTC, waking on the 14th there
  const s = rec.sleep({ cycle: 7, start: Date.UTC(2026, 10, 13, 19), end: Date.UTC(2026, 10, 14, 3, 30), offset: '+03:00' });
  const nap = rec.sleep({ cycle: 7, start: Date.UTC(2026, 10, 14, 11), end: Date.UTC(2026, 10, 14, 12, 30), nap: true, offset: '+03:00' });
  const days = daysOf(docOf({ sleep: [s, nap], recovery: [rec.recovery({ cycle: 7, sleep: s.id, at: T0 })], cycle: [rec.cycle({ id: 7, start: Date.UTC(2026, 10, 13, 19), offset: '+03:00' })] }));
  assert.deepEqual(Object.keys(days), ['2026-11-14']);
  const d = days['2026-11-14'];
  assert.equal(d.sleepMin, 420);   // the main sleep's asleep time, not the nap's, not time in bed
  assert.deepEqual([d.rec, d.hrv, d.rhr, d.spo2, d.skin, d.strain], [66, 61.5, 52, 96.4, 33.7, 12.4]);
  assert.deepEqual(d.st, { sleep: 'scored', rec: 'scored', cycle: 'scored' });
});

test('strain shows without a recovery, a pending recovery says so, and a cycle with no sleep is a day of its own', () => {
  const s = rec.sleep({ cycle: 8, start: T0 - 9 * H, end: T0 - H });
  const days = daysOf(docOf({ sleep: [s], recovery: [rec.recovery({ cycle: 8, sleep: s.id, at: T0, state: 'PENDING_SCORE' })], cycle: [rec.cycle({ id: 8, start: T0 - 9 * H }), rec.cycle({ id: 9, start: T0 - 3 * DAY })] }));
  const today = days['2026-11-15'];
  assert.equal(today.st.rec, 'pending');
  assert.equal(today.rec, undefined);
  assert.equal(today.strain, 12.4);
  assert.equal(days['2026-11-12'].strain, 12.4);
  assert.deepEqual(days['2026-11-12'].st, { cycle: 'scored' });
});

test('a sleep-backed day keeps its date against a cycle-only one, and the longer of two main sleeps decides, in any order', () => {
  const short = rec.sleep({ cycle: 10, start: T0 - 4 * H, end: T0 - 2 * H });
  const long = rec.sleep({ cycle: 11, start: T0 - 12 * H, end: T0 - 3 * H });
  const cycles = [rec.cycle({ id: 10, start: T0 - 4 * H, strain: 3 }), rec.cycle({ id: 11, start: T0 - 12 * H, strain: 15 }), rec.cycle({ id: 12, start: T0 - H, strain: 1 })];
  for (const order of [[short, long], [long, short]]) {
    const d = daysOf(docOf({ sleep: order, cycle: [...cycles].reverse() }))['2026-11-15'];
    assert.equal(d.strain, 15);
    assert.equal(d.sleepMin, 420);
  }
});

test('the profile gets the days once, a day WHOOP no longer has is cleared, and another account clears them all', async () => {
  const w = fakeWhoop();
  history(w, 3, { from: T0 - 5 * DAY });
  const c = await backfilled({ w });
  const S = () => c.profile.S;
  const dates = Object.keys(S().whoopDays).sort();
  assert.equal(dates.length, 3);
  const writes = c.profile.writes;
  c.clock.t += 16 * MIN;
  await c.sync.tick();
  assert.equal(c.profile.writes, writes, 'nothing new, no write');
  // WHOOP deletes the newest night and its cycle (seen by a webhook)
  const [cy, sl] = [w.cycle.at(-1), w.sleep.at(-1)];
  w.cycle.pop(); w.sleep.pop(); w.recovery.pop();
  deliver(c, { user_id: 4242, id: sl.id, type: 'sleep.deleted', trace_id: 'x1' });
  await settle(c);
  c.h._whoopStore().addDue('u1', 'cycle', String(cy.id));
  c.clock.t += MIN; await c.sync.tick();
  assert.equal(S().whoopDays[dates[2]].cleared, 1);
  // another WHOOP account: every old day cleared
  w.userId = 999; w.cycle.length = 0; w.sleep.length = 0; w.recovery.length = 0;
  const st = new URL(c.h.oauthStart('u1', 'whoop', CB)).searchParams.get('state');
  await c.h.oauthFinish({ state: st, code: 'good' }, 'u1');
  await c.sync.tick();
  assert.ok(Object.values(S().whoopDays).every(d => d.cleared === 1));
});

test('API tokens never see WHOOP days or the server’s own notes', () => {
  const S = { whoopDays: { '2026-11-14': { rec: 60, _ts: 1 } }, whoopSeen: { a: 1 }, activities: {}, whoopActs: {} };
  const all = { workouts: 'view', plans: 'view', bodyweight: 'view', measurements: 'view', notes: 'view' };
  const out = scopedState(S, all);
  assert.equal(out.whoopDays, undefined);
  assert.equal(out.whoopSeen, undefined);
  assert.equal(scopedState(S, { plans: 'view' }).whoopActs, undefined);
});

/* ---- review fixes ---- */

test('a score_state or webhook type that is a name off Object.prototype is not trusted', async () => {
  const { workout } = await import('../integrations/whoop/normalize.js');
  for (const s of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    const r = workout({ id: 'aaaaaaaa-0000-4000-8000-000000000001', start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z', score_state: s }, T0);
    assert.equal(r.st, 'pending', s);
  }
  const c = await backfilled();
  assert.deepEqual(deliver(c, { user_id: 4242, id: 'aaaaaaaa-0000-4000-8000-000000000009', type: 'toString', trace_id: 'p3' }), { ok: true });
});

test('GET /api/whoop/days refuses dates that do not exist', async () => {
  const c = await backfilled();
  for (const [f, t] of [['2020-01-01', '2024-99-99'], ['0000-00-00', '9999-99-99'], ['2024-13-01', '2026-12-31']]) {
    assert.throws(() => c.h.whoopDays('u1', f, t), e => e.status === 400, `${f}..${t}`);
  }
});

test('Disconnect forgets the sign-in and keeps everything imported', async () => {
  const w = fakeWhoop();
  history(w, 2);
  const c = await backfilled({ w });
  const before = JSON.stringify(c.profile.S);
  c.h.disconnect('u1', c.id);
  assert.equal(c.h.describe('u1').connections.length, 0);
  assert.ok(fs.existsSync(path.join(c.dataDir, 'whoop', 'u-u1.json')));
  assert.equal(Object.keys(c.doc().records.cycle).length, 2);
  assert.equal(JSON.stringify(c.profile.S), before);
  assert.ok(c.h.whoopDays('u1', '2026-01-01', '2026-11-30').days.length > 0);
});

test('a WHOOP day carries its cycle’s steps, scored or not; a cycle without a count has none', () => {
  const days = daysOf(docOf({ cycle: [
    rec.cycle({ id: 21, start: T0 - 4 * DAY, steps: 8412 }),
    rec.cycle({ id: 22, start: T0 - 3 * DAY, state: 'PENDING_SCORE', steps: 120 }),
    rec.cycle({ id: 23, start: T0 - 2 * DAY, steps: null }),
  ] }));
  assert.equal(days['2026-11-11'].steps, 8412);
  assert.equal(days['2026-11-12'].steps, 120);
  assert.equal(days['2026-11-12'].strain, undefined);
  assert.equal('steps' in days['2026-11-13'], false);
});

/* ---- WHOOP sport names as WHOOP writes them (weightlifting_msk, warm-bath) ---- */

test('Strength Trainer sessions are strength work, and baths, steam and saunas are recovery sessions', async () => {
  const w = fakeWhoop();
  const msk = rec.workout({ start: T0 - DAY, end: T0 - DAY + 50 * MIN, sport: 'weightlifting_msk' });
  const steam = rec.workout({ start: T0 - 2 * DAY, end: T0 - 2 * DAY + 15 * MIN, sport: 'steam-room' });
  const ice = rec.workout({ start: T0 - 3 * DAY, end: T0 - 3 * DAY + 4 * MIN, sport: 'ice-bath' });
  const bath = rec.workout({ start: T0 - 4 * DAY, end: T0 - 4 * DAY + 20 * MIN, sport: 'warm-bath' });
  w.workout.push(msk, steam, ice, bath);
  const c = await backfilled({ w });
  const S = c.profile.S;
  const a = S.activities[whoopActivityId(msk.id)];
  assert.equal(a.st, 1);
  assert.equal(a.title, 'Strength Trainer');
  for (const r of [steam, ice, bath]) assert.equal(S.activities[whoopActivityId(r.id)], undefined);
  const R = id => (({ _ts, ...x }) => x)(S.recoverySessions[whoopActivityId(id)]);
  assert.deepEqual(R(steam.id), { d: '2026-11-13', kind: 'sauna', min: 15, note: 'Steam room (WHOOP)' });
  assert.deepEqual(R(ice.id), { d: '2026-11-12', kind: 'cold', min: 4, note: 'WHOOP' });
  assert.deepEqual(R(bath.id), { d: '2026-11-11', kind: 'other', min: 20, note: 'Warm bath (WHOOP)' });
});

test('a profile imported with the old mapping is corrected on the next run, without a fetch, and an edited one is left alone', async () => {
  const w = fakeWhoop();
  const msk = rec.workout({ start: T0 - DAY, end: T0 - DAY + 50 * MIN, sport: 'weightlifting_msk' });
  const bath = rec.workout({ start: T0 - 2 * DAY, end: T0 - 2 * DAY + 20 * MIN, sport: 'warm-bath' });
  const mine = rec.workout({ start: T0 - 3 * DAY, end: T0 - 3 * DAY + 10 * MIN, sport: 'ice-bath' });
  w.workout.push(msk, bath, mine);
  const c = await backfilled({ w });
  const [im, ib, ix] = [msk, bath, mine].map(r => whoopActivityId(r.id));
  // what the first release wrote: all three as plain 'other' activities, one edited by the person
  const old = (r, extra = {}) => ({ d: '2026-11-1' + (4 - [msk, bath, mine].indexOf(r)), sport: 'other', min: 10, at: r.start, durMs: 600000, src: 'whoop', wu: r.id, wa: '4242', title: 'X', ...extra, _ts: 5 });
  c.profile.S = { activities: { [im]: old(msk), [ib]: old(bath), [ix]: old(mine, { edited: 1, note: 'mine' }) } };
  const store = c.h._whoopStore();
  const d = store.load('u1'); d.proj.version = 1; store.save('u1', d);
  const asked = w.calls.length;
  await c.sync.tick();
  assert.equal(w.calls.length, asked, 'fetched again');
  const S = c.profile.S;
  assert.equal(effectiveActivity(S, im, S.activities[im]).st, 1);
  assert.equal(effectiveActivity(S, im, S.activities[im]).title, 'Strength Trainer');
  assert.equal(effectiveActivity(S, ib, S.activities[ib]), null);
  assert.equal(S.recoverySessions[ib].kind, 'other');
  assert.equal(effectiveActivity(S, ix, S.activities[ix]).note, 'mine');
  assert.equal(S.recoverySessions?.[ix], undefined);
});

test('WHOOP names that read as a known sport map to it: hiking_rucking, football; HIIT keeps its capitals', () => {
  const r = (sport) => activityOf({ id: 'x', start: T0, end: T0 + 30 * MIN, off: 0, sport });
  assert.equal(r('hiking_rucking').sport, 'hike');
  assert.equal(r('football').sport, 'football');
  assert.equal(r('hiit').title, 'HIIT');
  assert.equal(r('elliptical').title, 'Elliptical');
  assert.deepEqual([r('walking').sport, r('walking').title], ['hike', 'Walking']);
});

test('stretching is a recovery session (Mobility), not an activity', async () => {
  const { recoveryOf } = await import('../integrations/whoop/activities.js');
  assert.deepEqual(recoveryOf({ start: T0, end: T0 + 12 * MIN, off: 0, sport: 'stretching' }), { d: '2026-11-15', kind: 'stretch', min: 12, note: 'Stretching (WHOOP)' });
  assert.equal(recoveryOf({ start: T0, end: T0 + 12 * MIN, off: 0, sport: 'walking' }), null);
});
