/* Integrations (v1.4.4): the hub that ties providers, the connection store and the outbox
 * together. server.js creates one, hands its routes the session helpers, and calls
 * onStateWrite after every successful PUT /api/data.
 *
 * Off unless the admin names providers: INTEGRATIONS=webhook (comma-separated, more to come).
 * With it unset nothing here runs, nothing is written, and /api/config says nothing, so the app
 * looks exactly as it did.
 *
 * A provider is a plain object (providers/webhook.js is the first):
 *
 *   id, kind ('webhook' | 'apikey' | 'oauth'), category, events: [types it can receive]
 *   env: [names of the env vars it needs], configured(env) -> whether they are all there
 *   max: connections per profile
 *   rate / connRate: { capacity, refillMs } token buckets, per instance and per connection
 *   connect(input) -> { label, events, info, secrets, reveal }   validate a form, say what to store
 *   update(input) -> patch                                       label / events / paused
 *   deliver(job, reveal) -> { ok, retry, retryAfterMs, gone, status, ms, code, msg }
 *
 * The OAuth kind (Strava, PR #478, next) adds authorizeUrl(uid, state) and callback(query) for a
 * GET /api/integrations/oauth/callback route, and refresh(reveal) for an expired token; the
 * store, the sealing, the outbox and the log are already the ones it will use. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from './store.js';
import { createOutbox, createBuckets } from './outbox.js';
import { deriveKey, newId } from './crypto.js';
import { detectEvents, eventData, envelope, testData, EVENTS } from './events.js';
import { webhookProvider } from './providers/webhook.js';
import { stravaProvider } from './providers/strava.js';
import { whoopProvider } from './providers/whoop.js';
import { createWhoopClient } from './whoop/client.js';
import { createWhoopStore } from './whoop/store.js';
import { createWhoopSync } from './whoop/sync.js';
import { projectActivities } from './whoop/activities.js';
import { projectWeight } from './whoop/weigh-ins.js';

const on = v => /^(1|true|yes|on)$/i.test(String(v || ''));

/** The provider ids an admin switched on, known ones only. */
export function enabledIds(env, known) {
  const ids = String(env.INTEGRATIONS || '').split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const id of ids) {
    if (!known.includes(id)) { console.warn(`INTEGRATIONS: "${id.slice(0, 30)}" is not an integration this server has, ignored`); continue; }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export const OAUTH_STATE_MS = 10 * 60_000;
export const WEBHOOK_SKEW_MS = 5 * 60_000;
// WHOOP webhook types → the collection whose record to fetch again.
const WEBHOOK_TYPES = {
  'workout.updated': 'workout', 'workout.deleted': 'workout',
  'sleep.updated': 'sleep', 'sleep.deleted': 'sleep',
  'recovery.updated': 'recovery', 'recovery.deleted': 'recovery',
};

export function createIntegrations({ dataDir, secret, env = process.env, now = Date.now, transport = null, fetchFn = globalThis.fetch, version = 'dev' }) {
  const allowLan = on(env.INTEGRATIONS_ALLOW_LAN);
  const all = { webhook: webhookProvider({ allowLan, transport, version }), strava: stravaProvider({ env, fetchFn, now }), whoop: whoopProvider({ env, fetchFn, now }) };
  const ids = enabledIds(env, Object.keys(all)).filter(id => {
    if (all[id].configured(env)) return true;
    console.warn(`INTEGRATIONS: ${id} needs ${all[id].env.join(', ')}; left off`);
    return false;
  });
  const providers = Object.fromEntries(ids.map(id => [id, all[id]]));
  const active = ids.length > 0;

  // Nothing is created on disk for an instance that never turned this on.
  const dir = path.join(dataDir, 'integrations');
  let store = null, outbox = null;
  const ensure = () => {
    if (store) return;
    const key = deriveKey(secret);
    store = createStore({ dir, key, now });
    outbox = createOutbox({
      file: path.join(dir, 'outbox.json'), now,
      deliver: job => {
        const p = providers[job.provider];
        const rec = store.get(job.uid, job.conn);
        if (!p || !rec) return { ok: false, retry: false, code: 'gone', msg: 'Disconnected.' };
        if (rec.paused) return { defer: 3600_000 };
        return p.deliver(job, name => store.reveal(job.uid, rec, name), extras(job.uid, rec));
      },
      rateOf: job => {
        const p = providers[job.provider];
        if (!p) return [];
        return [{ key: 'p:' + p.id, ...p.rate }, ...(p.connRate ? [{ key: 'c:' + job.conn, ...p.connRate }] : [])];
      },
      onSettled: (job, res, { final }) => settle(job.uid, job.conn, job.ev, res, final),
    });
  };
  if (active) ensure();
  // WHOOP pulls: its requests go through one client with a per-connection gate (whoop/client.js).
  const whoop = providers.whoop ? createWhoopClient({ provider: providers.whoop, store, now }) : null;
  // The profile access server.js hands over once its own pieces exist (attach), and what WHOOP
  // data becomes in a profile (projectors, one per capability).
  const deps = {};
  const projectors = [projectActivities, projectWeight];
  const whoopStore = createWhoopStore({ dataDir });
  const seenTraces = new Map();   // WHOOP webhook trace ids already taken
  const whoopSync = whoop ? createWhoopSync({ client: whoop, conns: store, wstore: whoopStore, now, deps, projectors }) : null;

  // What a provider may do besides reading its secrets: store refreshed ones (an OAuth token that
  // was renewed), and read the connection's own settings.
  const extras = (uid, rec) => ({
    info: { ...rec.info },
    reseal: map => store.update(uid, rec.id, r => { for (const [k, v] of Object.entries(map)) r.secrets[k] = store.seal(uid, rec.id, k, v); }),
  });

  // The OAuth `state`: who asked, for which provider, until when, signed with a key of its own.
  // A nonce is taken once, so a callback link cannot be replayed.
  const stateKey = secret && String(secret).length >= 16 ? crypto.createHmac('sha256', String(secret)).update('opengym-oauth-state v1').digest() : null;
  const usedNonces = new Map();
  // A provider that wants a short state (WHOOP: exactly 8 characters) gets a random one held here,
  // bound to the profile, the provider and the callback address. Lost on restart: start again.
  const pendingStates = new Map();   // state -> { u, p, e, redirectUri }
  const PENDING_MAX = 1000;
  const shortState = () => crypto.randomBytes(6).toString('base64url');
  // Per profile, the number of the latest WHOOP sign-in started (or disconnect): a callback that
  // comes back after a newer one, or after a disconnect, is stale.
  const attempts = new Map();
  const bump = uid => { const n = (attempts.get(uid) || 0) + 1; attempts.set(uid, n); return n; };
  const signState = o => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', stateKey).update(b).digest('base64url'); };
  const readState = st => {
    if (!stateKey || typeof st !== 'string' || st.length > 600) return null;
    const [b, mac] = st.split('.');
    if (!b || !mac) return null;
    const want = crypto.createHmac('sha256', stateKey).update(b).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    try { return JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch { return null; }
  };

  // What a person may do per minute: connect, change and test.
  const userActs = createBuckets({ now });
  const userLimit = (uid, what) => {
    const wait = userActs.take(what + ':' + uid, what === 'test' ? { capacity: 6, refillMs: 10_000 } : { capacity: 20, refillMs: 3000 });
    if (wait) throw Object.assign(new Error('slow down a little'), { status: 429, code: 'rate', retryAfter: Math.ceil(wait / 1000) });
  };

  function settle(uid, id, ev, res, final) {
    store.update(uid, id, r => {
      r.log = [...r.log, { at: now(), ev, ok: !!res?.ok, status: res?.status, ms: res?.ms, msg: res?.ok ? '' : res?.msg }];
      if (res?.ok) { r.status = 'ok'; r.failures = 0; r.lastOk = now(); r.lastError = null; return; }
      r.failures = (r.failures || 0) + 1;
      r.lastError = { at: now(), msg: res?.msg || 'Delivery failed.', code: res?.code };
      if (final || res?.gone) r.status = 'attention';
      if (res?.gone) r.paused = true;
    });
  }

  const fail = (status, message, code, provider) => { throw Object.assign(new Error(message), { status, code, ...(provider ? { provider } : {}) }); };
  const off = () => fail(404, 'integrations are off on this server', 'off');
  const own = (uid, id) => {
    const rec = typeof id === 'string' ? store.get(uid, id) : null;
    if (!rec || !providers[rec.provider]) fail(404, 'no such connection', 'missing');
    return rec;
  };

  /** A connection as the app gets it: never a secret, never the full URL. */
  function view(uid, rec) {
    const sealed = Object.keys(rec.secrets).length > 0 && Object.keys(rec.secrets).some(k => store.reveal(uid, rec, k) == null);
    const counts = outbox.counts(uid, rec.id);
    return {
      id: rec.id, provider: rec.provider, label: rec.label, events: rec.events, paused: rec.paused,
      status: sealed || rec.status === 'attention' ? 'attention' : rec.paused ? 'paused' : 'connected',
      info: rec.info, createdAt: rec.createdAt, lastOk: rec.lastOk,
      lastError: sealed ? { at: rec.updatedAt, msg: 'Its settings cannot be read any more. Add it again.', code: 'sealed' } : rec.lastError,
      failures: rec.failures, queued: counts.queued, failed: counts.failed,
    };
  }

  const hub = {
    active,
    allowLan,
    ids,
    /** For /api/config: which integrations this server offers, or null for none. */
    publicConfig: () => (active ? { providers: ids, ...(allowLan ? { lan: true } : {}) } : null),

    describe(uid) {
      if (!active) return { providers: [], connections: [] };
      return {
        providers: ids.map(id => ({ id, kind: providers[id].kind, category: providers[id].category, events: providers[id].events, max: providers[id].max, ...(id === 'webhook' && allowLan ? { lan: true } : {}) })),
        connections: store.list(uid).filter(r => providers[r.provider]).map(r => view(uid, r)),
      };
    },

    connect(uid, providerId, input) {
      if (!active) off();
      const p = providers[providerId];
      if (!p) fail(404, 'no such integration', 'missing');
      userLimit(uid, 'act');
      if (store.list(uid).filter(r => r.provider === p.id).length >= p.max) fail(409, `at most ${p.max} of these per profile`, 'too-many');
      if (p.kind === 'oauth') fail(400, 'connect it through its sign-in', 'oauth');
      const made = p.connect(input || {});
      const id = newId('c');
      const secrets = Object.fromEntries(Object.entries(made.secrets || {}).map(([k, v]) => [k, store.seal(uid, id, k, v)]));
      const rec = store.add(uid, { id, provider: p.id, label: made.label, events: made.events, info: made.info, secrets, log: [{ at: now(), ev: 'connected', ok: true }] });
      return { connection: view(uid, rec), ...(made.reveal ? { reveal: made.reveal } : {}) };
    },

    update(uid, id, input) {
      if (!active) off();
      const rec = own(uid, id);
      userLimit(uid, 'act');
      const patch = providers[rec.provider].update ? providers[rec.provider].update(input || {}, rec) : {};
      const next = store.update(uid, id, r => {
        Object.assign(r, patch);
        // Switching a paused one back on is also the user saying "I fixed it".
        if (patch.paused === false) { r.status = 'ok'; r.failures = 0; }
      });
      return { connection: view(uid, next) };
    },

    disconnect(uid, id) {
      if (!active) off();
      const rec = own(uid, id);
      store.remove(uid, id);
      outbox.dropConnection(uid, id);
      // A sign-in still on its way back must not bring the connection back.
      bump(uid);
      return { ok: true, provider: rec.provider, label: rec.label };
    },

    /** "Send test event": straight to the receiver, not through the outbox, answered at once. */
    async test(uid, id, type) {
      if (!active) off();
      const rec = own(uid, id);
      userLimit(uid, 'test');
      if (rec.provider === 'whoop') {
        const res = await whoop.check(uid, id);
        // A refused sign-in was already marked (with its own message) inside the client.
        if (store.get(uid, id) && !res.already) settle(uid, id, 'test', res, !res.ok && !res.retry);
        return { ok: !!res.ok, status: res.status ?? null, ms: null, msg: res.ok ? null : res.msg, connection: store.get(uid, id) ? view(uid, store.get(uid, id)) : null };
      }
      const ev = EVENTS.includes(type) ? type : rec.events[0] || 'workout.finished';
      const job = { id: newId('evt'), uid, conn: id, provider: rec.provider, ev: 'test', payload: envelope({ id: newId('evt'), type: ev, data: testData(ev, now()), at: now(), test: true }) };
      const res = await providers[rec.provider].deliver(job, name => store.reveal(uid, rec, name), extras(uid, rec));
      settle(uid, id, 'test', res, !res.ok && !res.retry);
      return { ok: !!res.ok, status: res.status ?? null, ms: res.ms ?? null, msg: res.ok ? null : res.msg, connection: view(uid, store.get(uid, id)) };
    },

    /** OAuth (Strava): where to send the person to sign in, with a state bound to them. */
    oauthStart(uid, providerId, redirectUri) {
      if (!active) off();
      const p = providers[providerId];
      if (!p || p.kind !== 'oauth') fail(404, 'no such integration', 'missing');
      if (!stateKey) fail(503, 'the server secret is missing', 'secret');
      userLimit(uid, 'act');
      if (p.stateLen === 8) {
        for (const [k, v] of pendingStates) if (v.e <= now()) pendingStates.delete(k);
        if (pendingStates.size >= PENDING_MAX) fail(429, 'too many sign-ins waiting, try again in a few minutes', 'rate');
        let state = shortState();
        while (pendingStates.has(state)) state = shortState();
        pendingStates.set(state, { u: uid, p: p.id, e: now() + OAUTH_STATE_MS, redirectUri, seq: bump(uid) });
        return p.authorizeUrl({ state, redirectUri });
      }
      const state = signState({ u: uid, p: p.id, n: crypto.randomBytes(9).toString('base64url'), e: now() + OAUTH_STATE_MS });
      return p.authorizeUrl({ state, redirectUri });
    },

    /** The callback: the state checked (its profile, its time, once), the code for tokens, the
     *  connection stored (a second sign-in replaces the first). `sessionUid` is the signed-in
     *  profile if the browser sent its cookie, which then has to be the state's. → { uid, connection } */
    async oauthFinish(query, sessionUid = null) {
      if (!active) off();
      const raw = query?.state;
      let st, redirectUri, seq = null;
      if (typeof raw === 'string' && raw.length === 8) {
        // Short state: looked up and taken at once, so it works one time only.
        const pend = pendingStates.get(raw);
        pendingStates.delete(raw);
        if (!pend || !(pend.e > now())) fail(400, 'that sign-in link is old or not ours, start again', 'state');
        if (sessionUid && sessionUid !== pend.u) fail(403, 'signed in as someone else', 'state', pend.p);
        st = pend; redirectUri = pend.redirectUri; seq = pend.seq;
      } else {
        st = readState(raw);
        if (!st || typeof st.u !== 'string' || !(st.e > now())) fail(400, 'that sign-in link is old or not ours, start again', 'state');
        if (sessionUid && sessionUid !== st.u) fail(403, 'signed in as someone else', 'state', st.p);
        if (usedNonces.has(st.n)) fail(400, 'that sign-in link was used already', 'state', st.p);
        for (const [n, e] of usedNonces) if (e <= now()) usedNonces.delete(n);
        usedNonces.set(st.n, st.e);
      }
      const p = providers[st.p];
      if (!p || p.kind !== 'oauth') fail(404, 'no such integration', 'missing');
      let made;
      try { made = await p.callback(query || {}, { redirectUri }); }
      catch (e) { if (e && typeof e === 'object' && !e.provider) e.provider = p.id; throw e; }
      // After the wait for the provider: a newer sign-in started, a disconnect, or the account
      // deleted meanwhile, and this one is stale; storing it would undo what happened since.
      if (seq != null && (attempts.get(st.u) !== seq || (deps.users && !deps.users().some(u => u.id === st.u)))) {
        fail(409, 'a newer sign-in or a disconnect happened meanwhile, start again', 'stale', p.id);
      }
      for (const old of store.list(st.u).filter(r => r.provider === p.id)) { store.remove(st.u, old.id); outbox.dropConnection(st.u, old.id); }
      const id = newId('c');
      const secrets = Object.fromEntries(Object.entries(made.secrets || {}).map(([k, v]) => [k, store.seal(st.u, id, k, v)]));
      const rec = store.add(st.u, { id, provider: p.id, label: made.label, events: made.events, info: made.info, secrets, log: [{ at: now(), ev: 'connected', ok: true }] });
      return { uid: st.u, connection: view(st.u, rec) };
    },

    /** The Retry button: failed deliveries go back into the queue and are sent now. */
    async retry(uid, id) {
      if (!active) off();
      own(uid, id);
      userLimit(uid, 'act');
      const n = outbox.retry(uid, id);
      store.update(uid, id, r => { if (r.status === 'attention') { r.status = 'ok'; r.failures = 0; } });
      await outbox.run();
      return { requeued: n, connection: view(uid, store.get(uid, id)) };
    },

    log(uid, id) {
      if (!active) off();
      const rec = own(uid, id);
      return { log: [...rec.log].reverse(), ...outbox.counts(uid, id) };
    },

    /** After a stored PUT /api/data: queue what the profile's connections asked to hear about. */
    onStateWrite(uid, prev, next) {
      if (!active || !store.has(uid)) return 0;
      // Settings → Modules: Integrations off pauses every connection (nothing is queued meanwhile,
      // nothing is disconnected). Switched back on, the next new event goes out as usual.
      if (next?.modules?.integrations === false) return 0;
      const conns = store.list(uid).filter(r => providers[r.provider] && !r.paused);
      if (!conns.length) return 0;
      const evs = detectEvents(prev, next, { now: now() });
      let n = 0;
      for (const ev of evs) {
        for (const c of conns) {
          if (!c.events.includes(ev.type) || ev.at < c.createdAt) continue;
          const eid = newId('evt');
          const r = outbox.enqueue({
            id: eid, key: `${c.provider}:${uid}:${c.id}:${ev.type}:${ev.entity}`, uid, conn: c.id, provider: c.provider, ev: ev.type,
            payload: envelope({ id: eid, type: ev.type, data: eventData(ev, next), at: ev.at }),
          });
          if (r === 'queued') n++;
          else if (r === 'full') settle(uid, c.id, ev.type, { ok: false, msg: 'Too much waiting to be sent, this one was skipped.' }, false);
        }
      }
      return n;
    },

    removeUser(uid) {
      // Sign-ins on their way back are void, and whatever is on disk goes, whether or not the
      // providers are switched on at this start (an admin may have turned WHOOP off since).
      for (const [k, v] of pendingStates) if (v.u === uid) pendingStates.delete(k);
      bump(uid);
      whoopStore.remove(uid);
      if (!store) { try { fs.unlinkSync(path.join(dir, 'u-' + String(uid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) + '.json')); } catch { /* none */ } return; }
      store.removeUser(uid);
      outbox.dropUser(uid);
    },

    /** WHOOP's webhook (POST /api/integrations/whoop/webhook), raw body and headers.
     *  The signature is base64(HMAC-SHA256(client secret, timestamp header + raw body)); the
     *  timestamp must be within five minutes. A valid event only names an id to fetch again, so a
     *  replayed or forged one cannot put data in. → { ok } or { ok: false, status }. */
    whoopWebhook: whoop ? (raw, headers) => {
      const sig = String(headers['x-whoop-signature'] || '');
      const ts = String(headers['x-whoop-signature-timestamp'] || '');
      if (!/^\d{10,16}$/.test(ts) || !sig || sig.length > 200) return { ok: false, status: 401 };
      if (Math.abs(now() - Number(ts)) > WEBHOOK_SKEW_MS) return { ok: false, status: 401 };
      const want = crypto.createHmac('sha256', providers.whoop.clientSecret).update(Buffer.concat([Buffer.from(ts), raw])).digest();
      const got = Buffer.from(sig, 'base64');
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, status: 401 };
      let ev;
      try { ev = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, status: 400 }; }
      const coll = WEBHOOK_TYPES[ev?.type];
      const id = typeof ev?.id === 'string' ? ev.id.toLowerCase() : '';
      // An event type we do not use is acknowledged, as WHOOP asks.
      if (!coll) return { ok: true };
      if (!Number.isSafeInteger(ev.user_id) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return { ok: false, status: 400 };
      const trace = typeof ev.trace_id === 'string' ? ev.trace_id.slice(0, 80) : null;
      if (trace) {
        if (seenTraces.has(trace)) return { ok: true };
        seenTraces.set(trace, now());
        if (seenTraces.size > 2000) seenTraces.delete(seenTraces.keys().next().value);
      }
      // Whose WHOOP account is it: every profile connected with that WHOOP user id.
      for (const u of deps.users ? deps.users() : []) {
        const conn = store.list(u.id).find(r => r.provider === 'whoop' && r.info.whoopUser === String(ev.user_id));
        if (!conn) continue;
        if (coll === 'recovery') {
          // A recovery event names its sleep; recovery is read through the sleep's cycle.
          let cyc = null;
          try { cyc = whoopStore.load(u.id).sleepCycle[id] || null; } catch { /* unreadable: fetch the sleep */ }
          if (cyc) whoopStore.addDue(u.id, 'recovery', cyc);
          else whoopStore.addDue(u.id, 'sleep', id);
        } else whoopStore.addDue(u.id, coll, id);
        whoopSync.runOne(u.id, conn.id).catch(e => console.error('whoop: webhook run', e.message));
      }
      return { ok: true };
    } : null,

    /** server.js: the users, and the profile reader and writer (writeStateAs), once they exist. */
    attach({ users, readState, writeState } = {}) { Object.assign(deps, { users, readState, writeState }); },

    start(everyMs) { if (active) outbox.start(everyMs); whoopSync?.start(); },
    stop() { outbox?.stop(); whoopSync?.stop(); },
    // For the tests.
    _whoop: () => whoop,
    _whoopSync: () => whoopSync,
    _whoopStore: () => whoopStore,
    _projectors: projectors,
    _outbox: () => outbox,
    _store: () => store,
  };
  return hub;
}
