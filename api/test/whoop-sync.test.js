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
  // the 60 sleeps before the fixed end, all of them; the newer ones belong to the poll, not here
  assert.equal(Object.keys(d.records.sleep).length, 60);
  assert.equal(d.cursors.sleep.end, end);
  assert.equal(d.cursors.sleep.done, true);
});

test('a listing that repeats its page token stops instead of looping', async () => {
  const w = fakeWhoop();
  history(w, 2);
  const real = w.fetchFn;
  w.fetchFn = async (url, o) => {
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
