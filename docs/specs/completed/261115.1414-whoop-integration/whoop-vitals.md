# Capability: whoop-vitals

## Spec

Source: prompt (no ticket)

### Goal
The person sees today's WHOOP recovery, HRV, resting HR, SpO2, skin temp, sleep and strain in the Daily form card (web too), and history and trends on a new WHOOP page; the last 120 days are on every device for offline use.

### Out of scope
- Feeding WHOOP vitals into the Coach or the recovery/fatigue model (not asked)
- Showing WHOOP vitals in the published App Store app (it bundles upstream UI)

### Domain model
Entities and value objects:
| Name | Kind | ID | Owner / parent | Invariants | States |
|---|---|---|---|---|---|
| WhoopDay | entity | local wake date YYYY-MM-DD (main sleep end + its timezone_offset); a cycle with no main sleep keys by its local start date | WhoopStore (server file) | one per date; sleep = main sleep ending that date (nap excluded; longest if several); recovery joined via that sleep_id; strain from the cycle with that sleep's cycle_id, independent of recovery; each component (sleep, recovery, cycle) keeps its own score state | per component: scored, pending, unscorable, absent; day: present, cleared |
| WhoopDay window | value (copy) | local date | synced profile key whoopDays (per-day stamped map) | last 120 days; server only writer; devices read-only; a date whose source records vanish becomes a stamped cleared entry | present, cleared, aged out |

Cases:
| Case | Source | Behaviour | Covered by |
|---|---|---|---|
| Score still PENDING_SCORE | WHOOP score_state | shown as pending, re-fetched until SCORED or UNSCORABLE | SC-4 |
| Nap | WHOOP sleep.nap | not counted as the night's sleep | SC-10 |
| No signal at the gym | engineer D14 | last 120 days still shown from the synced copy | SC-13 |
| Older history | engineer D13, D14 | WHOOP page reads it from the server | SC-13 |
| Overnight sleep crossing midnight | Codex review | night belongs to wake date | SC-10 |
| Cycle scored, recovery pending | Codex review | strain shown, recovery pending | SC-4b |
| Last record of a retained day deleted | Codex review | cleared on every device | SC-16 |

### Success criteria
- SC-4b A pending component shows as pending, never filled from an earlier day (derived, Codex review)
- SC-10 Naps excluded from nightly sleep (derived)
- SC-13 Daily form shows today's WHOOP recovery, HRV, RHR, SpO2, skin temp, sleep, strain on web, labelled WHOOP and never combined with phone vitals; WHOOP page shows history older than 120 days from the server, with trends; last 120 days render without a server connection (engineer D13, D14)
- SC-16 A day whose WHOOP records are deleted disappears on every device (Codex review)

### Ask first
- New synced profile key (per-day stamped map) in api/sync-stamps.js and frontend/src/lib/sync-merge.js, kept equal by the parity test
- New read route GET /api/whoop/days for history

### Decisions
- D13 Daily form for today, new WHOOP page for history and trends (engineer, round 2)
- D14 Full history server file plus 120-day synced copy (engineer, round 3)
- D18 120-day window by trimming to the newest 120 days on both sides plus server restoring its copy on every device write; no retention marker (engineer, disagreement review)

### Assumptions
- A4 Local day of a WHOOP record comes from its own timezone_offset (source: WHOOP API fields)
- A6 whoopDays and whoopSeen hidden from API tokens and trainers (NEVER in api/tokens.js); whoopActs and whoopChoice in token category workouts like activities, so plans-only tokens never see them (none: my guess; Codex review)

### Open questions
- none

## Plan

Finding F5: an old client (published App Store app) treats the new key as an unknown setting; its merge takes its stale copy when newer (sync-merge.js:858) and PUTs with stamped: true. A server guard in commitState is mandatory.

Files
- Add `api/integrations/whoop/days.js`: `daysOf(store)` -> `{ [iso]: { rec, hrv, rhr, spo2, skin, sleepMin, strain, st } }`; `windowOf(days)` keeps the 120 newest keys counted from the newest key.
- `api/sync-stamps.js:77` and `frontend/src/lib/sync-merge.js:96`: add `whoopDays` to STAMPED_MAPS and both OWN_MERGE sets; after the stamped-map loop (sync-merge.js:963) apply the same windowOf trim.
- `api/tokens.js:59`: add `whoopDays` to NEVER.
- `api/server.js` commitState (:530): before stampPut, `state.whoopDays = cur.whoopDays` (delete when cur has none); when this changed what the device sent, mark the report changed so the response tells the device to refetch (existing rev-based refetch, useStore.js:886).
- `frontend/src/lib/sync-merge.js` stampReplace (:1104) and its api counterpart: skip server-owned keys (`SERVER_OWNED = ['whoopDays', 'whoopActs', 'whoopSeen']`, same guard in commitState). When a device accepts a server document (pull or 409 merge), server-owned keys are replaced wholesale by the server's copy, never merged. so a device backup restore never authors WHOOP stamps.
- `api/integrations/routes.js`: `GET /api/whoop/days` (session only, from/to ISO, <= 400 days, from the store); openapi.yaml.
- Frontend: `lib/whoop-days.js` (`whoopVitals(S)` in phone-store shape `{ days }`, `whoopToday`, `trendOf`); DailyFormCard.jsx:63-78 drops MOBILE gate when S.whoopDays has data, adds recovery, strain, SpO2, skin temp tiles; `views/Whoop.jsx` + `/whoop` route in App.jsx gated on isOn(S, 'integrations').

Slices
- V1 Day assembly. A sleep-backed day always wins its date; a cycle-only day is used only when no sleep-backed day exists for that date. Test (whoop-sync.test.js, table): collision of sleep-backed day and cycle-only start on the same date in both input orders keeps the sleep-backed day's strain; two main sleeps ending the same date -> longer one supplies sleep, recovery and strain regardless of order; nap excluded; overnight sleep belongs to wake date (own offset); recovery joins by sleep_id; strain from sleep.cycle_id's cycle even with recovery absent or pending; cycle with no main sleep keyed by its local start date; per-component states asserted.
- V1b Projection publish. Each tick's writeStateAs sets `whoopDays` = windowOf(daysOf(store)), restamping only changed dates; a retained date with no source records becomes `{ cleared: 1, _ts }`. Test (server-whoop.test.js): ingest -> GET /api/data has the days -> device merge shows them; delete last record of a day -> offline device copy merged -> day cleared (SC-16).
- V2 Pending. Re-fetch handled by connection (SC-4a, no age cutoff). UI: `whoopToday` reads only today's date; a pending component renders 'pending', never yesterday's value. Test: yesterday scored + today pending -> today shows pending.
- V3 Synced window. Test (sync-stamps-parity.test.js): both STAMPED_MAPS equal; highestStamp agrees on a doc with whoopDays. Test (sync-merge.test.js): merging device copy with day 121 and server copy leaves 120 days in either order (key union at sync-merge.js:474 would resurrect aged-out days).
- V4 Device cannot write. Test (server-whoop.test.js): PUT /api/data with altered or missing whoopDays, stamped true, stores the server's copy and the device converges to it without any new projection; a backup reading stamped 200 vs server cleared stamped 100 disappears locally after PUT + refetch. Test (sync-merge.test.js): backup replacement holding an old recovery entry, then merge with the server's cleared entry -> cleared wins locally. Test: GET /api/token/data omits the key.
- V5 UI. Stats.jsx:945 mounts DailyFormCard when Health is on OR (Integrations is on and S.whoopDays has data); inside the card, phone vitals, check-in offers and insights render only when isOn(S, 'health') (test: Health off with populated phone vitals and check-ins -> only the WHOOP block shows); DailyFormCard renders a separate 'WHOOP' block only when isOn(S, 'integrations') (test through Stats: Health off, Integrations on, no phone vitals, check-ins off -> WHOOP block shows) (test: integrations off hides it, phone vitals still render), (recovery, HRV rmssd, RHR, SpO2, skin temp, sleep, strain) beside, never merged with, phone vitals (their hrvKind may be sdnn). Test (non-mobile): block renders from S.whoopDays with api rejecting (offline). WHOOP page: range picker (30/90/365 days, earlier pages), fetches /api/whoop/days in <= 400-day chunks; test: a server-only day older than 120 days appears in history and its LineChart series; fetch failure falls back to S.whoopDays.

Reuse: none of vitals.js for WHOOP presentation: sleepHoursOn drops sleepMin 0 and vitalsSummary backfills from earlier days. The WHOOP adapter keeps a scored 0 (test in the value/state table). Charts: existing `LineChart` component.

Added from Codex reconcile
- Guard covers every profile write path that takes device input, not only PUT /api/data: backup restore/replace and first sync too. V4 test covers each path.
- Sleep minutes from asleep stages (light + SWS + REM), not in-bed time. Each day keeps per-component score state (recovery, sleep, cycle can differ).
- WHOOP data stays out of S.dayForm, the phone health file, Coach, form-insights and fatigue inputs.
- /api/whoop/days keeps serving history after disconnect (D12 keeps data).

Blast radius
- New synced key: ~12 KB per profile PUT. Upstream phones carry it as unknown setting; their stale copy cannot land because commitState restores the stored value.
- "Reset everything" wipes it (RESET_MAPS includes STAMPED_MAPS, sync-merge.js:502); next projection rewrites it from the store.
- Trainers: api/trainers/projections.js builds from named keys; V4 test confirms no pass-through.
- Coach: cleanVitals (context.js:225) still gets only the phone summary; check DailyFormCard's vitals variable does not feed the Coach payload.

Trust boundaries: device-sent whoopDays discarded server-side; GET /api/whoop/days validates ISO dates, clamps range, 401 without session; WHOOP numbers accepted when finite and non-negative (no physiological cutoffs: the API contract defines them); a non-finite or negative value makes that field absent, component state unchanged.

Choices: key `whoopDays`, one entry per local date with own `_ts`, restamped only when content changes; trim relative to newest key (pure, clock-free, same both sides); history route reads the store directly, never via token API.
