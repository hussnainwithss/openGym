/* A person's WHOOP history on the server: DATA_DIR/whoop/u-<uid>.json, written only by the
 * server (whoop/sync.js), never synced to devices as a whole (the profile gets projections of it).
 * Written temp-then-rename at 0600. A file that exists but cannot be read is an error, never an
 * empty history: syncing on top of it would look like everything was deleted.
 *
 *   { v: 1,
 *     whoopUser: '4242',                       // whose WHOOP account this history is
 *     records: { cycle: {id: r}, recovery: {cycleId: r}, sleep: {id: r}, workout: {id: r} },
 *     sleepCycle: { sleepId: cycleId },        // kept after a sleep is gone, for recovery.deleted
 *     cursors: { coll: { start, end, next, done, scanEnd } },
 *     pending: { coll: [ids] },                // scored later, asked for by id until final
 *     candidates: { coll: [ids] },             // missing from a full listing, confirmed by id
 *     due: { coll: [ids] },                    // named by a webhook, fetched by id
 *     body: { kg, heightM, maxHr, at },        // the last WHOOP body measurement seen
 *     obs: [{ id, kg, observedAt, day, hhmm }],// weight changes not yet in the profile
 *     proj: { dirty, version, at },            // the profile still needs this history applied
 *     poll: { at, colls }, polledAt,           // the 15-minute poll in progress, the last one
 *   } */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../../durable.js';

export const COLLECTIONS = ['cycle', 'sleep', 'recovery', 'workout'];

const safeUid = uid => String(uid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);

export function emptyDoc(whoopUser = null) {
  return {
    v: 1, whoopUser,
    records: Object.fromEntries(COLLECTIONS.map(c => [c, {}])),
    sleepCycle: {}, cursors: {},
    pending: Object.fromEntries(COLLECTIONS.map(c => [c, []])),
    candidates: Object.fromEntries(COLLECTIONS.map(c => [c, []])),
    due: Object.fromEntries(COLLECTIONS.map(c => [c, []])),
    body: null, obs: [], proj: { dirty: false, version: 0, at: 0 },
    poll: null, polledAt: 0,                  // a poll in progress, and when the last one began
  };
}

function shape(d) {
  const out = emptyDoc(typeof d.whoopUser === 'string' ? d.whoopUser : null);
  for (const c of COLLECTIONS) {
    if (plain(d.records?.[c])) out.records[c] = d.records[c];
    for (const k of ['pending', 'candidates', 'due']) if (Array.isArray(d[k]?.[c])) out[k][c] = d[k][c].filter(x => typeof x === 'string');
  }
  if (plain(d.sleepCycle)) out.sleepCycle = d.sleepCycle;
  if (plain(d.cursors)) out.cursors = d.cursors;
  if (plain(d.body)) out.body = d.body;
  if (Array.isArray(d.obs)) out.obs = d.obs.filter(plain);
  if (plain(d.proj)) out.proj = { dirty: d.proj.dirty === true, version: Number(d.proj.version) || 0, at: Number(d.proj.at) || 0 };
  if (plain(d.poll)) out.poll = d.poll;
  if (Number.isFinite(d.polledAt)) out.polledAt = d.polledAt;
  return out;
}

export function createWhoopStore({ dataDir }) {
  const dir = path.join(dataDir, 'whoop');
  const fileOf = uid => path.join(dir, 'u-' + safeUid(uid) + '.json');

  return {
    fileOf,
    has: uid => fs.existsSync(fileOf(uid)),
    /** The stored history, or a fresh one when there is none. Throws on a file it cannot read. */
    load(uid) {
      let raw;
      try { raw = fs.readFileSync(fileOf(uid), 'utf8'); }
      catch (e) { if (e.code === 'ENOENT') return emptyDoc(); throw e; }
      const d = JSON.parse(raw);
      if (!plain(d) || d.v !== 1) throw new Error('whoop store: unknown format');
      return shape(d);
    },
    save(uid, doc) {
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(fileOf(uid), JSON.stringify(doc), 0o600);
    },
    remove(uid) { try { fs.unlinkSync(fileOf(uid)); } catch { /* none */ } },
  };
}
