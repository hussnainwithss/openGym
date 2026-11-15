# Capability: whoop-connection

## Spec

Source: prompt (no ticket)

### Goal
A person connects WHOOP once from Settings -> Integrations. The server keeps a valid token, backfills the full WHOOP history, then keeps pulling new and changed records, and holds them in a per-user server store the other capabilities read from.

### Out of scope
- Revoking access at WHOOP on disconnect (engineer D12)
- Connect from inside the phone app (A3)

### Domain model
Entities and value objects:
| Name | Kind | ID | Owner / parent | Invariants | States |
|---|---|---|---|---|---|
| WhoopConnection | entity | hub connection id + generation; bound to WHOOP user_id | user (data/integrations/u-<uid>.json) | one per user (second sign-in replaces, index.js:231); tokens sealed AES-GCM; at most one refresh in flight; a different WHOOP user_id on reconnect resets the WhoopStore | connected, paused, attention, removed |
| WhoopSyncCursor | value object | connection + collection (cycle, recovery, sleep, workout, body) | WhoopStore | per collection: fixed query bounds (start, end, limit) + nextToken while paging, backfill done flag, last completed scan end; moves forward only after records and projection progress are persisted | backfilling, live |
| WhoopStore | entity | uid + WHOOP user_id | server file data/whoop/u-<uid>.json, server only writer | records keyed by WHOOP id (UUID for sleep/workout, int64 kept as decimal string for cycle; recovery keyed by cycle_id); sleep_id -> cycle_id map persisted; projection progress persisted; body weight as durable observations `{ id, kg, observedAt, day, hhmm }` kept until projected; full history | - |

Cases:
| Case | Source | Behaviour | Covered by |
|---|---|---|---|
| First connect pulls whole history | prompt | every page of cycle, recovery, sleep, workout fetched; profile written in batches | SC-2 |
| New data after connect | prompt | appears within one poll | SC-3 |
| Record edited or deleted in WHOOP | WHOOP webhook types | webhook when ORIGIN is public HTTPS; else recent window re-read each poll | SC-5 |
| Access token expired | WHOOP 1h tokens | one refresh; rotated refresh token saved before use | SC-6 |
| Refresh fails / revoked at WHOOP | WHOOP OAuth | card shows Needs attention; Reconnect restores | SC-7 |
| Disconnect | engineer D12 | tokens forgotten, imported data kept, WHOOP not called | SC-11 |
| Account deleted | server.js:1599 removeUser | tokens, cursors and WHOOP store removed | SC-11 |
| Webhook with bad signature | WHOOP webhook doc | dropped, nothing fetched | SC-5 |
| Server or module off for more than 3 days | Codex review | next poll fetches from the last completed scan to now | SC-3 |
| Reconnect with a different WHOOP account | Codex review | store reset, no mixing | SC-7 |

### Success criteria
- SC-1 Admin sets INTEGRATIONS=whoop and WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET; Settings shows a WHOOP card; Connect runs WHOOP OAuth (8-char state, scopes read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement offline) and returns to a connected card (derived from prompt, A2)
- SC-2 Full history backfills within WHOOP rate limits and without one profile write per record (derived from prompt, A10)
- SC-3 New WHOOP data appears within one poll interval (A7)
- SC-3a After downtime of any length, the next poll fetches every record whose occurrence time falls after the last completed scan (minus overlap); records added later for an earlier occurrence time arrive only by webhook (WHOOP lists filter by occurrence, not creation) (Codex review, D22)
- SC-4a Records pending a score are re-fetched by id every poll, regardless of age, until SCORED or UNSCORABLE (derived)
- SC-5 Edited/deleted WHOOP records are reflected (polling treats a record as deleted only after a fully completed listing of its window omits it AND a GET by id returns 404; unconfirmed candidates persist across polls and window moves): workout, sleep and recovery at any age via signed webhook (base64 HMAC-SHA256 of timestamp + raw body with client secret); cycle and body only by polling (WHOOP publishes no webhook for them); by polling, all collections within the 3-day window plus pending records (engineer D7, D15, D19)
- SC-6 Never two concurrent refreshes per connection; the rotated refresh token is persisted before the new access token is used (WHOOP OAuth doc)
- SC-7 A rejected refresh (400/401 invalid_grant) puts the connection in attention; Reconnect restores. A refresh that provably never reached WHOOP (connect/DNS failure) or got a 429/5xx response keeps credentials and retries automatically. A refresh whose outcome is unknown (timeout or reset after the request was sent) goes to attention, because WHOOP may already have rotated the token (derived, Codex review)
- SC-11 Disconnect keeps imported data; account deletion removes tokens, cursors and the WHOOP store, invalidates pending WHOOP OAuth states, and no request in flight at deletion (poll, webhook work, OAuth exchange) recreates any of them (engineer D12, derived)

### Ask first
- Hub interface change: a pull hook beside `deliver`, and an 8-char OAuth state for WHOOP (touches the Strava OAuth path)
- New unauthenticated route POST /api/integrations/whoop/webhook with raw-body HMAC check (D7)
- New server data directory data/whoop/ (D14)

### Decisions
- D7 Polling plus optional WHOOP webhooks when a public HTTPS ORIGIN exists (engineer, round 1)
- D12 Disconnect forgets tokens, keeps data, no revoke at WHOOP (engineer, round 2)
- D14 Full history in data/whoop/u-<uid>.json (engineer, round 3)
- D15 SC-5/SC-15 narrowed: polling covers 3-day window + pending records; older edits/deletions only via webhook (engineer, spec gate via disagreement review)
- D19 SC-5 per collection: cycle and body edits only via polling, no WHOOP webhook exists (engineer, review findings)
- D20 Reconnect with a different WHOOP account resets the store and clears the previous account's synced whoopDays with stamped cleared entries; imported activities and weigh-ins stay (D12) (engineer, review findings)
- D22 SC-3a narrowed: catch-up by occurrence time; backdated additions older than the scan via webhook only (engineer, review findings round 2)

### Assumptions
- A1 One WHOOP connection per profile (source: index.js:231)
- A2 Each self-hoster registers their own WHOOP developer app (source: strava.js:5-8 precedent)
- A3 Connect starts from a browser signed in to the server (source: Integrations.jsx:508-511 precedent)
- A5 WHOOP API v2 exposes only cycle, recovery, sleep, workout, body measurement, profile (source: developer.whoop.com/api)
- A7 Poll every 15 min; each poll re-reads the last 3 days for edits and late scores (none: my guess)
- A8 Poll and webhook processing stop while the profile has the Integrations module off (source: index.js:260)
- A10 Backfill writes the profile in batches, not per record (source: writeStateAs rewrites the whole document, server.js:505)

### Open questions
- none

## Plan

Skills loaded: domain-modeling, defensive-programming, pragmatic-testing. Repo style per CLAUDE.md (no linter, match existing code).

Cross-cutting findings (apply to all capabilities):
- F2 English-only (D8) vs `check-source-strings.mjs --strict`: new UI strings are plain English literals, not `t('...')`; CARDS text goes through `t(variable)` which the script skips.
- F3 OAuth return toast is dead today: routes.js:12 redirects to a path, app is HashRouter (App.jsx:632). Redirect to `/#/settings/integrations?...`; update api/test/server-strava.test.js:75,82.
- F4 Webhook URL is registered by hand in the WHOOP dashboard; the route exists whenever `whoop` is enabled; the 3-day re-read always runs.

Files
- Add `api/integrations/providers/whoop.js`: `whoopProvider({ env, fetchFn, now })`, id 'whoop', kind 'oauth', category 'health', events [], env WHOOP_CLIENT_ID/SECRET, max 1, `stateLen: 8`; `authorizeUrl`, `callback`, `update` (paused), `deliver` (test only: runs a refresh), `token(reveal, reseal, connId)` single-flight, `get(path, params, token)`, `verifyWebhook(raw, headers)`.
- Add `api/integrations/whoop/store.js`: `createWhoopStore({ dir, now })` over `data/whoop/u-<uid>.json` (0600, atomicWrite, safeUid as store.js:75): `{ v, whoopUser, cursors, body: { kg }, cycle, recovery, sleep, workout, pending, dirty }`.
- Add `api/integrations/whoop/sync.js`: `createWhoopSync({ provider, conns, wstore, now, deps })` with `tick()`, `noteWebhook(evt)`, `project(uid)`.
- Add `api/integrations/whoop/normalize.js`: pure validators per collection.
- `api/integrations/index.js`: register provider (:48); `oauthStart` (:204) uses 6 random bytes base64url (8 chars) in an in-memory `pending` Map when `p.stateLen === 8`, else signState; `oauthFinish` (:217) looks up+deletes 8-char states, errors carry `e.provider`; new `hub.attach({ users, readState, writeState, userNow })`; `start`/`stop` also run the pull timer; `removeUser` (:283) deletes the WHOOP store; `disconnect` unchanged (D12).
- `api/integrations/routes.js`: `back()` to `/#/settings/integrations`; :86 `e.provider || 'strava'`; `POST /api/integrations/whoop/webhook` with injected `readRaw`.
- `api/server.js`: `readRaw(req, max)` beside readBody (:986), cap 8 KB; webhook path in CSRF_EXEMPT (:857); `integrations.attach({ users, readState: readStateCached, writeState: writeStateAs, userNow })` before `integrations.start()` (:3649).
- `api/openapi.yaml` + `node scripts/build-api-docs.mjs`; `.env.example`, docs/INTEGRATIONS.md WHOOP section.
- Frontend `lib/integrations.js` CARDS entry, cardState case, `CARD_MODULE.whoop = 'integrations'`; `views/Integrations.jsx` `startWhoop`, `WhoopDetail` (status, last sync, backfill progress from info, Reconnect, Disconnect), return effect generalised per provider.

Slices
- C1 Connect. Test (api/test/whoop.test.js): authorize URL state is exactly 8 chars; replayed state refused; callback under another session 403. Existing strava.test.js state tests prove Strava untouched.
- C2 Refresh. Test: two concurrent `token()` on an expired token make one token POST; the fake rejects reuse of rotated r1. Test: reseal happens before the first authed GET; reseal throwing means no GET and status attention.
- C3 Backfill. Fixed end at backfill start; cursor persists start, end, limit and nextToken. Test (whoop-sync.test.js, injected clock): 3 pages per collection land; restart mid-backfill after the clock advanced and newer records were added resumes with the same bounds and no duplicates or gaps. Test: repeated next_token or > MAX_PAGES stops the loop.
- C4 Poll. 60 s tick, due when `now - polledAt >= 15 min`; fetch window `start = min(lastScanEnd - 1h, now - 3d)` to a fixed `end = now`, paged with persisted bounds (bounds are occurrence time, D22); ids missing from a complete listing inside the 3-day part become delete candidates, confirmed by GET by id (404 -> delete, 200 -> keep, error -> retry next poll). Test: listing omits a stored record whose by-id GET returns 200 -> it survives. Pending ids re-fetched by id every poll, any age. Test: server off 10 days, records created then appear on next poll (SC-3a). Test: pending record older than 3 days becomes scored with no webhook (SC-4a). Test: edit and delete in window reflected; a listing failing on page 2 deletes nothing. Test: integrations module off or paused makes zero fetches (A8).
- C5 Failure. 400/401 on refresh -> attention + paused, lastError 'reconnect'. Reconnect by same whoopUser keeps cursors; different user resets the store. Test both.
- C6 Webhook. Test (server-whoop.test.js, spawned server): valid signature 204 and user marked due; bad signature, stale timestamp (>5 min), oversize -> 401/413 with zero fetches; replayed trace_id ignored.
- C7 Deletion. Extend account-delete test: whoop store file gone. Disconnect test: file stays, tokens gone.

Reuse: createBuckets (outbox.js:44), extras().reseal (index.js:85), store.seal/reveal, atomicWrite, settle() for log/attention, strava.js call/tokensFrom shape, startCadence tick shape (cadence.js:24-60), fake fetchFn harness (strava.test.js:21-40).

Added from Codex reconcile
- store.js:93 publishes the in-memory cache before the durable write: for WHOOP token rotation, reseal must be durable before the new token is usable. Fix store.update order (tested in C2).
- One execution gate per connection covers poll, webhook work and Check connection; inside the gate the hub resolves the current connection record from the store (not a reveal closure captured earlier, index.js:201) before revealing tokens. Test (C2, through the hub): Check connection queued behind a refresh uses the newly persisted token and makes no second refresh POST. A refresh whose response is lost (network error after send) -> attention + reconnect, never a second spend of the old refresh token.
- Connection generation check before every commit: work started before disconnect/reconnect/account deletion never writes back (C7 extends to in-flight fetch/refresh).
- Batch commit order: persist validated source records + pending projection -> one writeStateAs -> persist checkpoint. Replay after a crash at any step is idempotent.
- Rate limit per HTTP request across all users and entry points; WHOOP documents 100/min and 10,000/day (developer.whoop.com/docs/developing/rate-limiting); honour rate headers; reserve capacity for recent data while history backfills.
- Recovery collection is keyed by cycle_id; recovery webhook id is the sleep UUID: resolve sleep -> cycle before fetching recovery.
- Webhook: mark the referenced id due in the WHOOP store (durable) before answering 204; processing is async; re-fetch by id is idempotent, so dedupe by trace_id stays a bounded in-memory guard.
- removeUser deletes data/whoop/u-<uid>.json even when whoop is not enabled at startup.
- `frontend/src/lib/build-caps.js`: hide the WHOOP card in the networkless build.
- Poll-only limitation: edits/deletions older than the 3-day window are seen only via webhook (see disagreement D-B).

Revisions R1 (Codex review)
- Delivery contract to other capabilities: WhoopStore holds `proj` = { version, pendingIds per projection }. Commit order: (1) persist validated records + mark them pending for each projection, (2) one writeStateAs applying all projections (activities, weight, whoopDays) synchronously, (3) clear pending + advance cursor. A crash at any step replays from (1)'s marks. Projection version bump re-projects from the store without refetching. Test: crash injected after (1) and after (2); next tick ends with the same profile and no duplicates.
- Identity: callback fetches GET /v2/user/profile/basic, stores user_id in conn info (whoopUser) and WhoopStore. Different user_id on reconnect resets the store and the next projection writes `{ cleared: 1, _ts }` for every old date in whoopDays (D20). Webhook routes by user_id. Test in C5: switch accounts while another device holds the old days offline; after merge that device shows only the new account's days.
- Recovery resolution: store keeps sleep_id -> cycle_id for every sleep and recovery seen. recovery.updated: map sleep -> cycle (fetch sleep if unknown), then GET /v2/cycle/{id}/recovery. recovery.deleted / sleep.deleted: use the stored map; a 404 on sleep or recovery means delete locally. Test (C6): recovery.deleted after its sleep is gone (404), both arrival orders.
- removeUser: deletes data/integrations/u-<uid>.json and data/whoop/u-<uid>.json directly, without needing an active provider. Test (C7): seed both, restart with INTEGRATIONS unset, delete account, both gone.
- In-flight work: each tick captures conn generation; before every store or profile commit, re-check generation and account existence; mismatch discards. Test (C7): fetch held open, then disconnect / reconnect / account delete; released fetch writes nothing.
- OAuth attempts: each start records a per-user attempt sequence number; oauthFinish commits only if its attempt is the latest for that user and no disconnect happened since it started. Tests: two held exchanges released newest-first -> the newer connection survives; disconnect during a held exchange -> connection stays removed.
- OAuth exchange: removeUser drops the uid's pending 8-char states; oauthFinish re-checks that the account exists and the state was not invalidated immediately before storing the connection (after the awaited token exchange). Test (C7): hold the token exchange open, delete the account, release; neither integrations nor whoop file reappears.
- Delete candidates: ids omitted by a complete listing go into `store.candidates` (durable) and are confirmed by GET by id each poll until 404 (delete) or 200 (drop candidate), independent of later windows. Test: confirm GET fails, restart, clock passes the 3-day cutoff, next poll still resolves it.
- Refresh errors: invalid_grant / 400 / 401 -> attention; failure before the request was sent (DNS, connect refused) or a 429/5xx response -> keep tokens, back off, retry; timeout or reset after send -> attention (WHOOP may have rotated). Tests: each class; a fake that consumes r1 then throws before responding -> attention, no second POST with r1.
- Rate limit test: shared clock, backfill of user A plus webhook work for user B; 429 on page 2 with reset header; every entry point waits; resumes with no skipped records and no deletion candidates created from the aborted listing.

Design choices
- Fetch and projection are separate phases. writeStateAs throws 409 not-synced for a profile with no document: store sets `dirty`, next tick retries the projection.
- Cursors live in the WHOOP store, not the hub record (capRecord would drop them).
- Batching: at most 40 pages per user per tick; at most one writeStateAs per tick; WHOOP store writes as the R1 commit order needs (before and after the profile write). Crash tests run against the real file store.
- Pacing: provider bucket 60/min plus daily counter 8,000 (WHOOP limits to confirm in C1).
- A tick whose connection id is gone discards its result. Single api process assumed.

Blast radius
| Change | Consumers | Safe because |
|---|---|---|
| Optional `stateLen`, `token` on providers; `hub.attach` | webhook, strava providers | hub branches only on `stateLen === 8`, which neither sets |
| `back()` to `/#/...` | Strava return, 2 test asserts | current target never reaches HashRouter (F3) |
| in-memory `pending` states | connects in flight at restart | same as Strava's usedNonces today; person restarts connect |
| New `data/whoop/` | backups, account deletion | nothing existing reads it; removeUser deletes it |
Rollout: api then web; old web shows no card (CARDS is client-side).

Trust boundaries
- WHOOP replies: normalize.js before store. Ids UUID string or safe integer; timestamps parse, within [2010, now+1d]; score_state one of SCORED/PENDING_SCORE/UNSCORABLE, unknown -> pending and retried, never trusted as scored; numeric ranges checked, bad field dropped, record kept.
- HTTP: 401 -> one single-flight refresh, one retry; 429 sets a provider-wide blocked-until from Retry-After / rate-limit reset headers (no cap) that poll, backfill, webhook work and Check connection all respect; 5xx/network ends tick, cursor unchanged.
- Webhook: raw bytes <= 8 KB; timingSafeEqual on base64 HMAC; timestamp within 5 min; bounded trace_id dedupe; user_id must match a connection's whoopUser; payload only triggers a re-fetch by id.
- OAuth callback: state exactly 8 chars and present in pending; code sliced to 512; `error` -> denied redirect.

