## Summary

Goal: pull a person's WHOOP data (workouts, body weight, recovery, HRV, resting HR, SpO2, skin temp, sleep, daily strain) into their openGym profile on the server, full history included, through a native integration like Strava. Fork-only (hussnainwithss/openGym), English strings.

Four capabilities, built in order: whoop-connection (OAuth, tokens, poller, backfill, webhooks), then whoop-activities, whoop-bodyweight, whoop-vitals.

Review rounds added D19 (cycle/body edits polling-only), D20 (different WHOOP account resets store and clears its synced days), D21 (explicit keep/merge/skip in device-only `whoopChoice`; default and target computed at read time), D22 (catch-up by occurrence time; backdated older entries via webhook only), D23 (server writes each WHOOP activity once; later WHOOP changes kept in server-owned `whoopActs`, so your edits and deletes always win). Engineer must confirm: assumptions A6-A10 (vitals key hidden from API tokens and trainers, 15 min poll with 3-day re-read, Integrations module switch stops the poll, own `whoop` activity source with strain/HR/kJ, batched backfill writes). Ask first: new synced profile key, new unauthenticated webhook route, hub interface change.

Top risks: WHOOP rotates the refresh token on every refresh, so two concurrent refreshes kill the connection; sync-merge rules must change identically in api and frontend; hub OAuth state is ~150 chars, WHOOP needs exactly 8.

Plan part: one server pull engine (provider + per-user WHOOP store + 60 s tick, 15 min poll, signed webhooks) projects into the profile through writeStateAs; 21 slices (C1-C7, A1-A5, B1-B4, V1-V5). Drafted by Fable, reconciled with Codex (D15-D18), revised for Codex review rounds 1-4 (D19-D23).

## Map

| Capability id | What a caller can do afterwards | Ticket ACs / cases it owns | Depends on | Status |
|---|---|---|---|---|
| whoop-connection | Person connects WHOOP; server keeps fresh, serialized tokens and pulls every WHOOP collection (backfill + poll + optional webhook) into a per-user server store | SC-1, SC-2, SC-3, SC-3a, SC-4a (pending acquisition), SC-5, SC-6, SC-7, SC-11; cases: connect, token expiry, refresh failure, edits/deletes, downtime catch-up, account deletion, disconnect | - | done |
| whoop-activities | WHOOP workouts appear as openGym activities, strength sessions handled by a default + per-item choice | SC-8, SC-12, SC-14, SC-15, SC-17; cases: deleted activity, strength overlap, WHOOP-side deletion, offline edit/delete vs WHOOP update | whoop-connection | done |
| whoop-bodyweight | WHOOP profile weight changes become WHOOP weigh-ins | SC-9; cases: weight change, typed weigh-in same day | whoop-connection | done |
| whoop-vitals | Recovery, HRV, RHR, SpO2, skin temp, sleep, strain shown today (Daily form) and as history (WHOOP page), last 120 days offline | SC-4b (pending presentation), SC-10, SC-13, SC-16; cases: pending score, nap, deleted day | whoop-connection | done |

Build order: whoop-connection, then whoop-activities, whoop-bodyweight, whoop-vitals.

Terms (ticket -> repo), shared by every capability:
| Ticket term | Repo concept | Where | Note |
|---|---|---|---|
| WHOOP integration | Integration provider + connection record | api/integrations/index.js:46-48, store.js:10-16 | New provider id `whoop` beside `webhook`, `strava` |
| WHOOP workout | Activity | frontend/src/lib/activities.js:19-20 | Not an openGym Workout (S.workouts = sessions logged in openGym) |
| Body weight | Weigh-in reading inside a bodyweight day | frontend/src/lib/weigh-ins.js:1-30 | Day value chosen by S.bwDaily from all readings regardless of src (weigh-ins.js:105); typed-beats-src exists only for legacy whole-day merge (:308). whoop-bodyweight adds typed-wins |
| Recovery, HRV, RHR, SpO2, skin temp, sleep | Vitals | frontend/src/lib/vitals.js:1-7 | Phone-only today, never synced; only sleepMin/rhr/hrv/steps |
| Strain / cycle | (new) | - | No concept in openGym |
| Backfill / poll | (new) | - | Hub is push-only (deliver from outbox, strava.js:1-3) |

Shared decisions:
- D1 Native provider, not sidecar (engineer, round 0)
- D2 Data scope: workouts, body weight, recovery/HRV/RHR/sleep, strain/cycles, full history, healthspan if it exists (engineer, round 0)
- D3 Healthspan out of scope: no public endpoint (agent, fact: developer.whoop.com/api, 2026-11-15)
- D4 Four capabilities (engineer, round 1)
- D8 Fork-only bar: English strings, minimal docs (engineer, round 1)
- D9 Sync runs server side only; web UI displays (engineer, round 1)

Shared out of scope:
- Healthspan / WHOOP Age, journal, stress monitor (no public API v2 endpoint)
- Writing back to WHOOP
- Raspberry Pi deployment (engineer: "leave pi for now")
- Cross-source dedupe with Apple Health / Health Connect (engineer D6)
- All 26 locales, openapi/website regeneration beyond what CI checks need (D8)

Glossary changes (create GLOSSARY.md):
| Term | What it is in this repo | Not to be confused with | Code | Set by | Status |
|---|---|---|---|---|---|
| Activity | Training done outside openGym's logger (run, ride, WHOOP session), one entry per session in S.activities | Workout: a session logged in openGym (S.workouts) | frontend/src/lib/activities.js | this spec | confirmed |
| Vitals | Per-day body readings (sleep, resting HR, HRV, recovery, strain) from a wearable | Daily form: the person's own 1-5 self ratings (S.dayForm) | frontend/src/lib/vitals.js | this spec D14 | confirmed |
| WHOOP connection | A person's linked WHOOP account on this server, tokens sealed by the integration hub, bound to one WHOOP user_id | Strava connection: push-only | api/integrations/providers/whoop.js (new) | this spec D1, D20 | confirmed |
| WHOOP store | Server-only file holding a person's full WHOOP history, cursors and projection progress | The profile document: synced to devices | api/integrations/whoop/store.js (new) | this spec D14 | confirmed |
| WHOOP day | One local wake date of WHOOP sleep, recovery and strain, each with its own score state | Daily form: self ratings | api/integrations/whoop/days.js (new) | this spec | confirmed |
| WHOOP update | The latest WHOOP-side fields or deletion for an imported WHOOP activity, kept apart from the activity so the person's edits win | The activity entry | api/integrations/whoop/activities.js (new) | this spec D23 | confirmed |
| WHOOP choice | The person's explicit keep/merge/skip for one WHOOP strength session, separate from the activity; default and target are derived at read time | Activity: the session itself | frontend/src/lib/activities.js | this spec D21 | confirmed |
| WHOOP weigh-in | A weigh-in reading with src 'whoop', added when the WHOOP profile weight changes; a typed reading wins the day | Typed weigh-in (no src) | api/integrations/whoop/weigh-ins.js (new) | this spec D11 | confirmed |

