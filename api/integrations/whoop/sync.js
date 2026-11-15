/* The WHOOP pull: for every connected profile, bring the WHOOP history into the WHOOP store
 * (whoop/store.js), then apply it to the profile through the server's one safe writer
 * (writeStateAs, injected). A 60 s tick decides who is due; each person's run holds their
 * connection's gate (whoop/client.js), so it never overlaps a refresh, a webhook or a check.
 *
 * Commit order, so a crash at any step replays cleanly:
 *   1. validated records (and the cursor that found them) saved, with proj.dirty set
 *   2. one profile write applying every projection, synchronous
 *   3. proj.dirty cleared
 * A crash after 1 finds dirty on the next tick and applies the same records again; projections
 * are idempotent (same ids, same values: no write). A profile with no server document yet (409)
 * keeps dirty and is tried again next tick.
 *
 * Backfill: every page of each collection, from the start of the person's history to a fixed end
 * taken when the backfill began, at most MAX_PAGES requests per person per tick. */
import { COLLECTIONS, emptyDoc } from './store.js';
import { NORMALIZE, keyOf, body as normalizeBody } from './normalize.js';
import { observationId, dayAt, timeAt } from './weigh-ins.js';
import { WhoopError } from './client.js';

export const PAGE = 25;
export const MAX_PAGES = 40;
export const TICK_MS = 60_000;
export const POLL_MS = 15 * 60_000;
// Raised when what WHOOP data becomes in a profile changes (the projectors): the next run applies
// the stored history again, once, without fetching anything. 2: Strength Trainer and recovery sports.
export const PROJ_VERSION = 4;
export const PATHS = { cycle: '/v2/cycle', sleep: '/v2/activity/sleep', recovery: '/v2/recovery', workout: '/v2/activity/workout' };
export const WINDOW_MS = 3 * 86_400_000;
export const OVERLAP_MS = 3600_000;
// Recovery is read through its cycle; the others by their own id.
const BY_ID = {
  workout: k => '/v2/activity/workout/' + k, sleep: k => '/v2/activity/sleep/' + k,
  cycle: k => '/v2/cycle/' + k, recovery: k => '/v2/cycle/' + k + '/recovery',
};

const iso = ms => new Date(ms).toISOString();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createWhoopSync({ client, conns, wstore, now = Date.now, deps = {}, projectors = [] }) {
  let running = false;
  let timer = null;

  // The connection, if it is still the one this run started with (not disconnected, replaced or
  // deleted meanwhile).
  const alive = (uid, connId) => {
    const rec = conns.get(uid, connId);
    if (!rec || rec.provider !== 'whoop') return null;
    if (deps.users && !deps.users().some(u => u.id === uid)) return null;
    return rec;
  };

  // Every save first folds in the ids a webhook named meanwhile; all synchronous, so a webhook
  // cannot write between the merge and the save.
  const save = (uid, doc) => { wstore.takeDue(uid, doc); wstore.save(uid, doc); wstore.clearDue(uid); };

  function note(uid, connId, patch) {
    if (!alive(uid, connId)) return;
    conns.update(uid, connId, r => {
      if (patch.info) r.info = { ...r.info, ...patch.info };
      if (patch.ok) { r.lastOk = now(); if (r.status !== 'attention') { r.failures = 0; r.lastError = null; } }
      if (patch.error) { r.failures = (r.failures || 0) + 1; r.lastError = { at: now(), msg: patch.error.msg, code: patch.error.code }; }
    });
  }

  /** Records from one page into the doc. → { changed, keys } (the keys it saw). */
  function absorb(doc, coll, records) {
    let changed = false;
    const keys = [];
    const t = now();
    for (const raw of records) {
      const r = NORMALIZE[coll](raw, t);
      if (!r) continue;
      const k = keyOf(coll, r);
      keys.push(k);
      const cand = doc.candidates[coll].indexOf(k);
      if (cand >= 0) doc.candidates[coll].splice(cand, 1);
      if (coll === 'sleep' && r.cycle) doc.sleepCycle[r.id] = r.cycle;
      if (coll === 'recovery' && r.sleep) doc.sleepCycle[r.sleep] = r.cycle;
      if (!same(doc.records[coll][k], r)) { doc.records[coll][k] = r; changed = true; }
      const pend = doc.pending[coll];
      const i = pend.indexOf(k);
      if (r.st === 'pending' && i < 0) pend.push(k);
      else if (r.st !== 'pending' && i >= 0) pend.splice(i, 1);
    }
    return { changed, keys };
  }

  /** A record WHOOP no longer has: out of the store (sleep → cycle stays, for recovery.deleted). */
  function drop(doc, coll, k) {
    for (const list of [doc.pending[coll], doc.candidates[coll], doc.due[coll]]) {
      const i = list.indexOf(k);
      if (i >= 0) list.splice(i, 1);
    }
    if (!(k in doc.records[coll])) return false;
    delete doc.records[coll][k];
    return true;
  }

  // When a record happened, for the poll window: recovery has no time of its own, its cycle has.
  const whenOf = (doc, coll, r) => r.start ?? doc.records.cycle[r.cycle]?.start ?? r.at ?? 0;

  /** One record by id. → { gone: true } on 404, { record } on 200; throws WhoopError otherwise. */
  async function byId(uid, connId, coll, k) {
    const r = await client.get(uid, connId, BY_ID[coll](k));
    if (r.status === 404) return { gone: true };
    if (r.status !== 200 || !r.data || typeof r.data !== 'object') throw new WhoopError('http', `WHOOP answered ${r.status}.`, { retry: true });
    return { record: r.data };
  }

  /** Pending scores, delete candidates and webhook ids, each asked for by id. → pages left. */
  async function settleIds(uid, connId, doc, budget, lists) {
    for (const coll of COLLECTIONS) {
      for (const list of lists) {
        for (const k of [...doc[list][coll]]) {
          if (budget <= 0) return budget;
          const got = await byId(uid, connId, coll, k);
          budget--;
          // A sleep named by a webhook may come with a new or deleted recovery: check its cycle's.
          const recoveryOf = () => {
            const cyc = coll === 'sleep' && list === 'due' ? (doc.records.sleep[k]?.cycle || doc.sleepCycle[k]) : null;
            if (cyc && !doc.due.recovery.includes(cyc)) doc.due.recovery.push(cyc);
          };
          if (got.gone) { recoveryOf(); if (drop(doc, coll, k)) doc.proj.dirty = true; }
          else {
            const { changed } = absorb(doc, coll, [got.record]);
            if (changed) doc.proj.dirty = true;
            recoveryOf();
            const i = doc[list][coll].indexOf(k);
            // still pending stays on the pending list; anything else is settled
            if (i >= 0 && !(list === 'pending' && doc.records[coll][k]?.st === 'pending')) doc[list][coll].splice(i, 1);
          }
          if (!alive(uid, connId)) throw new WhoopError('gone', 'Disconnected.');
          save(uid, doc);
        }
      }
    }
    return budget;
  }

  /** The 15-minute poll: everything that happened since the last completed scan (with an hour of
   *  overlap, and never less than the last WINDOW_MS), then, for the last WINDOW_MS only, what a
   *  complete listing no longer shows becomes a delete candidate, confirmed by id. → pages left. */
  async function poll(uid, connId, doc, budget) {
    const t = now();
    doc.poll ||= { at: t, colls: {} };
    for (const coll of COLLECTIONS) {
      const p = doc.poll.colls[coll] ||= {
        start: Math.min((doc.cursors[coll].scanEnd ?? t) - OVERLAP_MS, doc.poll.at - WINDOW_MS), end: doc.poll.at, next: null, seen: [], done: false,
      };
      while (!p.done && budget > 0) {
        const { records, next } = await page(uid, connId, coll, p);
        budget--;
        if (next && next === p.next) throw new WhoopError('http', 'WHOOP repeated a page.', { retry: true });
        const { changed, keys } = absorb(doc, coll, records);
        if (changed) doc.proj.dirty = true;
        p.seen.push(...keys);
        p.next = next;
        if (!next) p.done = true;
        if (!alive(uid, connId)) throw new WhoopError('gone', 'Disconnected.');
        save(uid, doc);
      }
      if (!p.done) return budget;
    }
    // Every listing completed: what is stored for the window but was not listed may be deleted.
    for (const coll of COLLECTIONS) {
      const p = doc.poll.colls[coll];
      const seen = new Set(p.seen);
      const from = Math.max(p.start, p.end - WINDOW_MS);
      for (const [k, r] of Object.entries(doc.records[coll])) {
        const w = whenOf(doc, coll, r);
        if (w >= from && w < p.end && !seen.has(k) && !doc.candidates[coll].includes(k)) doc.candidates[coll].push(k);
      }
      doc.cursors[coll].scanEnd = p.end;
    }
    doc.polledAt = doc.poll.at;
    doc.poll = null;
    save(uid, doc);
    return budget;
  }

  /** One page of a collection listing. → { records, next } or throws WhoopError. */
  async function page(uid, connId, coll, cur) {
    const r = await client.get(uid, connId, PATHS[coll], {
      limit: PAGE, ...(cur.start ? { start: iso(cur.start) } : {}), end: iso(cur.end), ...(cur.next ? { nextToken: cur.next } : {}),
    });
    if (r.status !== 200 || !Array.isArray(r.data?.records)) throw new WhoopError('http', `WHOOP sent an unexpected listing (${r.status}).`, { retry: true });
    const next = typeof r.data.next_token === 'string' && r.data.next_token ? r.data.next_token.slice(0, 512) : null;
    return { records: r.data.records, next };
  }

  // The person's offset from UTC now, in minutes: from their latest WHOOP sleep or cycle (WHOOP
  // records where it was), else the zone their reminders use, else the server's.
  function offsetNow(uid, doc) {
    let best = null;
    for (const c of ['sleep', 'cycle']) for (const r of Object.values(doc.records[c])) if (!best || r.start > best.start) best = r;
    if (best && Number.isFinite(best.off)) return best.off;
    const tz = deps.readState?.(uid)?.reminder?.tz;
    if (typeof tz === 'string' && tz) {
      try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(now()));
        const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(parts.find(p => p.type === 'timeZoneName')?.value || '');
        if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
      } catch { /* an unknown zone: the server's */ }
    }
    return -new Date(now()).getTimezoneOffset();
  }

  /** WHOOP's body measurement: a changed weight becomes an observation, its day and time fixed
   *  now, saved before anything else happens with it. */
  async function observeBody(uid, connId, doc) {
    const r = await client.get(uid, connId, '/v2/user/measurement/body');
    if (r.status !== 200) return;
    const b = normalizeBody(r.data);
    if (!b) return;
    const t = now();
    if (doc.body?.kg !== b.kg) {
      const off = offsetNow(uid, doc);
      doc.obs.push({ id: observationId(doc.whoopUser, t), kg: b.kg, observedAt: t, day: dayAt(t, off), hhmm: timeAt(t, off), off });
      doc.proj.dirty = true;
    }
    doc.body = { ...b, at: t };
    if (!alive(uid, connId)) throw new WhoopError('gone', 'Disconnected.');
    save(uid, doc);
  }

  /** Applies the stored history to the profile when it is dirty. → true when done. */
  function project(uid, connId, doc) {
    if (!doc.proj.dirty) return true;
    // `acked`: the weight observations the write put in the profile (whoop/weigh-ins.js).
    const ctx = { now: now(), acked: [] };
    if (projectors.length && deps.writeState) {
      try {
        deps.writeState(uid, (S, t) => {
          let changed = false;
          for (const p of projectors) changed = p(S, doc, t, ctx) || changed;
          return changed;
        }, { skipIf: changed => !changed });
      } catch (e) {
        if (e?.status === 409 || e?.status === 503) return false;   // no server document yet, or unreadable: next tick
        throw e;
      }
    }
    if (!alive(uid, connId)) return false;
    // Only now that the profile holds them do the observations leave the WHOOP store.
    if (ctx.acked.length) doc.obs = doc.obs.filter(o => !ctx.acked.includes(o.id));
    doc.proj = { ...doc.proj, dirty: false, at: now() };
    save(uid, doc);
    return true;
  }

  function backfillLabel(doc) {
    const done = COLLECTIONS.filter(c => doc.cursors[c]?.done).length;
    if (done === COLLECTIONS.length) return 'done';
    const n = COLLECTIONS.reduce((a, c) => a + Object.keys(doc.records[c]).length, 0);
    return `${n} records so far`;
  }

  /** One person's run, with their connection's gate held. */
  async function runOne(uid, connId) {
    return client.withGate(uid, connId, async () => {
      const conn = alive(uid, connId);
      if (!conn || conn.paused || conn.status === 'attention') return;
      if (deps.readState) {
        const S = deps.readState(uid);
        if (S?.modules?.integrations === false) return;
      }
      let doc = wstore.load(uid);
      const who = conn.info.whoopUser || null;
      if (doc.whoopUser == null) doc.whoopUser = who;
      else if (who && doc.whoopUser !== who) {
        // Reconnected with another WHOOP account: its history starts over, never mixed with the
        // last one's. The projections then clear the old account's synced days (D20); imported
        // activities and weigh-ins stay (D12).
        doc = emptyDoc(who);
        doc.proj.dirty = true;
        save(uid, doc);
      }
      wstore.takeDue(uid, doc);
      if (doc.proj.version !== PROJ_VERSION) { doc.proj.dirty = true; doc.proj.version = PROJ_VERSION; }
      let budget = MAX_PAGES;
      const backfilled = () => COLLECTIONS.every(c => doc.cursors[c]?.done);
      const waiting = () => COLLECTIONS.some(c => doc.due[c].length);
      const pollDue = () => !!doc.poll || now() - (doc.polledAt || 0) >= POLL_MS;
      if (backfilled() && !doc.proj.dirty && !waiting() && !pollDue()) return;
      try {
        for (const coll of COLLECTIONS) {
          const cur = doc.cursors[coll] || (doc.cursors[coll] = { start: null, end: now(), next: null, done: false });
          while (!cur.done && budget > 0) {
            const { records, next } = await page(uid, connId, coll, cur);
            budget--;
            if (next && next === cur.next) throw new WhoopError('http', 'WHOOP repeated a page.', { retry: true });
            const { changed } = absorb(doc, coll, records);
            cur.next = next;
            if (!next) { cur.done = true; cur.scanEnd = cur.end; }
            if (changed) doc.proj.dirty = true;
            if (!alive(uid, connId)) return;
            save(uid, doc);
          }
        }
        if (backfilled()) {
          // The backfill was the first scan: the first poll is due 15 minutes after its end.
          if (!doc.polledAt) doc.polledAt = Math.min(...COLLECTIONS.map(c => doc.cursors[c].end));
          let polled = false;
          if (pollDue()) { budget = await poll(uid, connId, doc, budget); polled = !doc.poll; }
          // WHOOP's weight has no webhook and no date: read with every completed poll, and once
          // as soon as the history is in.
          if ((polled || !doc.body) && budget > 0) { await observeBody(uid, connId, doc); budget--; }
          // Webhook ids at once; pending scores and delete candidates with each completed poll.
          budget = await settleIds(uid, connId, doc, budget, polled ? ['due', 'candidates', 'pending'] : ['due']);
        }
        if (!alive(uid, connId)) return;
        project(uid, connId, doc);
        note(uid, connId, { ok: true, info: { backfill: backfillLabel(doc) } });
      } catch (e) {
        if (!(e instanceof WhoopError)) throw e;
        if (e.code === 'gone' || !alive(uid, connId)) return;
        // What was fetched before the failure is saved; apply it.
        if (doc.proj.dirty) { try { project(uid, connId, doc); } catch (pe) { console.error('whoop: projection', pe.message); } }
        if (e.code !== 'reconnect') note(uid, connId, { error: { msg: e.message, code: e.code }, info: { backfill: backfillLabel(doc) } });
        if (e.code === 'rate') throw e;
      }
    });
  }

  /** Every connected profile that is due. A rate limit ends the whole tick. */
  async function tick() {
    if (running) return;
    running = true;
    try {
      const users = deps.users ? deps.users() : [];
      for (const u of users) {
        for (const c of conns.list(u.id).filter(r => r.provider === 'whoop')) {
          if (now() < client.blockedUntil()) return;
          try { await runOne(u.id, c.id); }
          catch (e) {
            if (e instanceof WhoopError && e.code === 'rate') return;
            console.error('whoop: sync of a profile failed', e.message);
          }
        }
      }
    } finally { running = false; }
  }

  return {
    tick,
    runOne,
    start(everyMs = TICK_MS) {
      if (timer) return;
      timer = setInterval(() => { tick().catch(e => console.error('whoop tick', e)); }, everyMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    emptyDoc,
  };
}
