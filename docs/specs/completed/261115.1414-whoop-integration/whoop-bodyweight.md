# Capability: whoop-bodyweight

## Spec

Source: prompt (no ticket)

### Goal
When the weight in the person's WHOOP profile changes, openGym logs a WHOOP weigh-in for that day.

### Out of scope
- Weight history before connect (WHOOP has none: body measurement is one undated value)

### Domain model
Entities and value objects:
| Name | Kind | ID | Owner / parent | Invariants | States |
|---|---|---|---|---|---|
| WhoopWeighIn | value | `wh` + 16-char SHA-256 of WHOOP user_id + observation time | S.bodyweight day `ins` | src 'whoop'; kg converted to S.unit; day from the person's local date | present, removed (day.gone) |

Cases:
| Case | Source | Behaviour | Covered by |
|---|---|---|---|
| WHOOP weight changes | engineer D11 | WHOOP weigh-in added for that day | SC-9 |
| Person typed a weigh-in that day | weigh-ins.js:309 | typed reading wins the day value | SC-9 |
| WHOOP weight unchanged | derived | nothing written | SC-9 |
| First poll after connect | engineer D11 | current WHOOP weight logged once | SC-9 |

### Success criteria
- SC-9 Any change in WHOOP profile weight (exact compare) adds one WHOOP weigh-in for that day; unchanged weight writes nothing; a typed reading (no src) wins the day value in every bwDaily mode and in legacy whole-day corrections; existing readings are never overwritten (engineer D11, Codex review)

### Ask first
- Port weigh-in merge rules (addWeighIn/mergeWeighIns) to the api: code that exists twice

### Decisions
- D11 Weight change -> WHOOP weigh-in; typed wins; no history before connect (engineer, round 2)

### Assumptions
- A12 Local day for the weigh-in uses the timezone_offset of the most recent WHOOP sleep or cycle, fixed at observation; fallback S.reminder.tz, then server zone (Codex review: reminder.tz is only kept while reminders are on, useStore.js:2292)

### Open questions
- none

## Plan

Finding F1: SC-9 "typed wins" does not hold today for days with readings. settleDay sets `w = dailyValue(ins, mode)` with no src preference (weigh-ins.js:106-112, 149-166); the typed-beats-src rule (:309-311) covers legacy days only. Codex reproduced typed 80 + WHOOP 90 -> 90 (first), 85 (avg). Plan: on both sides, only on days holding a 'whoop' reading, when a typed reading (no src) exists dailyValue and absorbLegacyEdit use only typed readings; days without a WHOOP reading (typed + Health/CSV) keep today's behaviour.

Files
- Add `api/integrations/whoop/weigh-ins.js` (legacy readings converted with the person's zone from A12, never the server zone; test: legacy 07:00 Riyadh reading unchanged when a UTC server adds a WHOOP reading): port of cleanTime, readingsOf, dailyValue, stampOf, absorbLegacyEdit, settleDay, toReadings, addWeighIn (weigh-ins.js:51-223) + `projectWeight(S, store, { date, hhmm }, t)`.
- Add `frontend/src/lib/weigh-ins-parity.test.js`: random days through both implementations.
- dailyValue and absorbLegacyEdit (weigh-ins.js:133) both sides: only on a day that holds a 'whoop' reading and a typed reading, select among typed readings; every other day unchanged.

Slices
- B1 Change adds one reading: store keeps body.kg; any change (exact compare of WHOOP's value) persists a pending observation `{ id, kg, observedAt, day, hhmm }` in the WHOOP store (and updates body.kg) in one store write before any projection; projection replays pending observations with their stored id and acknowledges each after writeStateAs succeeds. The same writeStateAs records the id in server-owned profile key `whoopSeen` (SERVER_OWNED, NEVER for tokens); replay skips any id already in whoopSeen, so a reading deleted (or the day deleted and recreated, or Reset everything) before acknowledgement never returns. Tests: publish -> crash before ack -> delete -> recreate day with typed reading -> replay -> only typed remains; publish -> crash before ack -> Reset everything -> replay -> absent, while a weight change observed after the reset still imports. Test: crash before and after the profile write -> exactly one reading, same id; day/hhmm fixed at observation from the most recent WHOOP sleep/cycle timezone_offset (fallback S.reminder.tz, then server zone); reading `{ id: 'wh' + sha256(whoopUser + observedAt) 16 chars, at, w, t, src: 'whoop' }` in S.unit; never overwrites an existing reading id. Test: first poll logs once; unchanged writes nothing; change adds one; lb profile gets pounds.
- B2 Typed wins. Table test both sides: typed 07:00 + WHOOP 03:15 -> w typed in first/avg/last; typed 80 at 07:00 + typed 82 at 19:00 + WHOOP 90 -> first 80, avg 81, last 82; WHOOP + Health import -> today's rule unchanged; legacy whole-day correction on a WHOOP+typed day edits the typed reading. Regression: import 80, person edits to 79, WHOOP goes 81 then 80 -> person's 79 untouched.
- B3 Removal sticks. Compare deletions against the queued observedAt, never the publish stamp t (writeStateAs makes t newer than everything, server.js:510). Test: observe -> publish -> person deletes day -> replay observation -> day stays deleted; day.gone[id] blocks re-add. Test: replay of an already projected WHOOP id the person edited keeps value, time and cleared src.
- B4 Day. Day/hhmm come from the queue (fixed at observation). Test: observed 23:55 local, published after midnight and replayed -> same day, same id.

Blast radius
- dailyValue change affects only days holding a 'whoop' reading; none exist today. Upstream app recomputes w with the old rule when merging such a day, so w can differ on an upstream phone until the fork merges next.
- weighin.logged fires to the person's webhooks on a WHOOP weigh-in (events.js:43-49 via server.js:523): intended; outbox dedupes by day.
- Trainers/tokens with bodyweight scope see it, as any weigh-in.

Trust boundary: weight_kilogram finite and within KG_MIN/KG_MAX (health-read.js), else ignored and body.kg unchanged. Risk: third hand-copied rule set; parity test is the guard.

