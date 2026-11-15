# Capability: whoop-activities

## Spec

Source: prompt (no ticket)

### Goal
Every WHOOP workout appears as an openGym activity with its WHOOP details; a WHOOP strength session that overlaps a gym workout logged in openGym follows a default the person sets and can be changed one by one.

### Out of scope
- Dedupe against Apple Health / Health Connect imports (engineer D6)

### Domain model
Entities and value objects:
| Name | Kind | ID | Owner / parent | Invariants | States |
|---|---|---|---|---|---|
| WhoopActivity | entity | `w` + 16-char base64url SHA-256 of WHOOP workout UUID; full UUID kept as `wu` | S.activities (stamped map) | the server writes each entry once, at import, and never again; person's edits and deletes always win; src 'whoop'; carries import-time strain, avg/max HR, kJ, durMs | present, merged (hidden, data on the openGym workout), skipped, deleted (tombstone) |
| StrengthOverlapDefault | value (setting) | - | profile setting whoopStrength | one of keep / merge / skip | - |
| WhoopActUpdate | value | activity id | synced server-owned stamped map whoopActs | latest WHOOP fields (start, durMs, sport, distance, strain, HR, kJ) or `gone: 1`; only the server writes it; shown over the activity at read time unless the person edited the activity | present, gone |
| WhoopChoice | value | activity id | synced device-owned stamped map whoopChoice | explicit ov keep/merge/skip only; written only by devices; default and target computed at read time | set, cleared |

Cases:
| Case | Source | Behaviour | Covered by |
|---|---|---|---|
| WHOOP run, ride, etc. | prompt | activity with sport mapped, minutes, km, strain, HR, kJ | SC-14 |
| WHOOP strength session overlaps a logged openGym workout | engineer D10 | default from setting; person can switch that one to keep / merge / skip | SC-12 |
| WHOOP strength session with no overlapping workout | engineer D5 | kept as activity | SC-12 |
| Person deletes a WHOOP activity in openGym | activities.js tombstones | never re-imported | SC-8 |
| WHOOP deletes a workout | WHOOP workout.deleted | activity removed unless the person edited it (assumption A11) | SC-15 |

### Success criteria
- SC-8 A WHOOP activity deleted in openGym stays deleted (activities.js mergeHealthActivities precedent)
- SC-12 Overlapping WHOOP strength session follows the default setting and can be switched per item to keep / merge / skip (engineer D10)
- SC-14 Every WHOOP workout with end > start is imported, strength included (Strength Trainer too), with sport, duration (sub-minute shown as 1 min, exact duration kept), distance, strain, avg/max HR, kJ, dated by its own timezone_offset (engineer D5, A4, A9)
- SC-17 A delete or edit the person makes offline is never undone by a later WHOOP update (Codex review, D23)
- SC-15 A workout deleted in WHOOP disappears from openGym activities: via webhook at any age, via polling within the 3-day window (A11, D15)

### Ask first
- Extend activity shape (src 'whoop', strain/HR/kJ fields) read by readActivity on both api and frontend
- Two new synced keys: whoopChoice (device-owned) and whoopActs (server-owned, guarded like whoopDays); shared pure helper module under api/coach/core/

### Decisions
- D5 Import every WHOOP workout, strength included; person chooses (engineer, round 1)
- D6 No cross-source dedupe (engineer, round 1)
- D10 Default setting keep / merge / skip with per-item override (engineer, round 2)
- D16 Activity invariant reworded: untouched WHOOP entries update; tombstones and person-edited entries never overwritten (engineer, spec gate via disagreement review)
- D17 Merge stored as a link (ov 'merge' + wid); S.workouts never written (engineer, disagreement review)
- D23 Server writes each WHOOP activity once at import; later WHOOP changes and deletions go to server-owned whoopActs and are combined at read time; an activity the person edited ignores whoopActs; person's deletes always win. Implements D16 (engineer, review findings round 3)
- D21 (revised round 2) whoopChoice holds only the person's explicit keep/merge/skip and only devices write it; the effective choice is computed at read time: explicit choice, else S.whoopStrength default when a logged workout overlaps, else keep; the merge target is the current best-overlapping workout at read time; no target -> shown as an activity (engineer, review findings)

### Assumptions
- A9 WHOOP activities get source 'whoop' and keep strain, avg/max HR, kJ (source: activities.js:41 SOURCES needs extending)
- A11 WHOOP-side deletion removes the activity with a tombstone (none: my guess)

### Open questions
- none

## Plan

Files
- Add `api/integrations/whoop/activities.js`: `activityOf(rec)`, `SPORT_MAP` (WHOOP sport_name -> SPORTS; weightlifting, powerlifting, functional fitness, strength trainer -> 'other' with `st: 1`), `whoopActivityId(uuid) = 'w' + sha256(uuid) base64url first 16 chars`, `wu` holds the UUID, `projectActivities(S, store, t)`.
- `frontend/src/lib/activities.js`: SOURCES (:41) + 'whoop'; readActivity (:71-88) keeps `strain` (0-21), `hr`, `hrMax` (30-250), `kj` (0-50000), `st`, `wu`; activitiesOf (:91) hides entries whose whoopChoice is merge/skip unless `{ all: true }`; ActivityLog lookup (ActivitySheet.jsx:32) uses the unfiltered form; new pure `effectiveChoice(S, activity) -> { ov, wid }` (explicit choice, else default when a logged workout overlaps by UTC interval, greatest overlap, stable tie-break; else keep; no target -> keep), `whoopForWorkout(S, w)`, `setChoice(S, id, ov, now)` writing `S.whoopChoice[id] = { ov, _ts }`.
- New synced key `whoopChoice` (STAMPED_MAP both sides, parity test), in tokens KEY_CATEGORY workouts.
- WHOOP page lists hidden (merged/skipped) sessions with their controls.
- `components/ActivitySheet.jsx`: SOURCE_LINE.whoop, detail rows, keep/merge/skip control when `st` and `wid` set.
- Workout detail in `sheets.jsx`: WHOOP row from whoopForWorkout.
- `S.whoopStrength` setting row in WhoopDetail.

Slices
- A1 Import. Test (whoop-sync.test.js): scored run -> `{ d, sport: 'run', min, km, strain, hr, hrMax, kj, src: 'whoop' }` under stable id; second projection writes nothing (skipIf). Test (activities.test.js): readActivity keeps new fields and src.
- A2 Tombstone. Test: existing `{ _ts }` never overwritten (SC-8).
- A3 WHOOP-side update and delete. The server never rewrites an activity after import; it writes `whoopActs[id] = { ...latest fields, _ts }` or `{ gone: 1, _ts }`. Read time (`effectiveActivity` in the shared helper): untouched entry (no `edited` mark set by withActivity) shows whoopActs fields and is hidden when gone; edited entry ignores whoopActs. Test (sync-merge.test.js): offline device deletes at T+1, server writes whoopActs strain at T+2 -> stays deleted; offline note edit at T+1 + server update at T+2 -> note kept, WHOOP update ignored for that entry (SC-17).
- A4 Strength overlap. The server never writes whoopChoice. `effectiveChoice` table test: default merge hides; standalone strength stays visible; workout logged after import picks up the default immediately; workout A moved away and B now overlaps -> target B; greatest overlap of two; target deleted -> shown as activity, explicit merge preserved and re-applies if a workout overlaps again; explicit keep beats default.
- A5 Sync merge. Choice and activity are separate stamped maps and only devices write choices. Test (sync-merge.test.js): offline device sets whoopChoice keep at T+1 while server updates strain on the activity at T+2; merge keeps both. UI test: skip -> reopen from hidden list -> keep makes it visible again.
- Shared helper: `effectiveActivity`, `effectiveChoice` and `activitiesOf` filtering live in a pure module under `api/coach/core/` (shared with the apps per CLAUDE.md; API must not import frontend files), imported by frontend activities.js and the server streak calc. Server test: streak ignores merge/skip and gone entries.
- `whoopActs` joins SERVER_OWNED (commitState guard, stampReplace skip), STAMPED_MAPS both sides, tokens KEY_CATEGORY workouts. Each update carries derived `d` (from start + timezone_offset) so a WHOOP correction across local midnight moves an untouched activity's day.
- withActivity sets `edited: 1` on any person edit of a src 'whoop' entry; editing the duration replaces `durMs` with min*60000 (a note-only save keeps durMs). Test: session shortened 10:00-11:00 to 10:00-10:30 no longer merges into a workout starting 10:45.
- WHOOP page hidden-sessions list offers keep / merge / skip and 'use default' (`setChoice(S, id, null)` writes a stamped clear `{ _ts }`). Test: clear survives sync and follows a later whoopStrength change.
- readActivity keeps `durMs`; overlap uses exact start + durMs. Test: 20 s WHOOP session ending 30 s before a gym workout starts does not overlap.
- Merge target id: workout `id`, else the existing day/start key (workout-date.js:15). Test: overlapping workout without id is linked and shown.
- A6 Consumers. Every reader of activities goes through activitiesOf/effectiveChoice; memoized consumers (Home.jsx:121, Calendar in sheets.jsx:3886, Stats.jsx:221, RecoveryHint, Wrapped, server streak calc) add S.whoopChoice, S.whoopStrength, S.whoopActs and S.workouts to their dependencies. Mounted UI tests: changing only whoopChoice updates calendar dot and streak at once; a whoopActs `gone` on an untouched activity removes its dot and streak contribution at once.

Blast radius
- Activity shape: published upstream app reads src 'whoop' as manual and drops extra fields at read time; stored entries merge whole by `_ts`. Edit there rewrites without WHOOP fields; A3 then leaves it alone.
- Old apps show merged/skipped entries as plain activities and count WHOOP strength as 'other' in recovery load/streak. Known limitation of the published app.
- Merge is a link (`ov: 'merge'` + `wid`), never a write to S.workouts, so detectEvents, Strava and webhooks see no workout change.
- `S.whoopStrength` unknown key readable by any token (one of three words). Tokens with workouts scope see WHOOP activities, same as health-store activities.

Added from Codex reconcile
- Overlap computed at read time (effectiveChoice), so later or moved workouts are always current.
- Audit every direct S.activities reader (server streak calc included) so merge/skip entries do not count.
- WHOOP-side deletion of a merged item removes only the link, never the openGym workout.

Trust boundaries: activityOf rejects only end <= start or unparsable times; `min` = round(duration) clamped to readActivity's 1..1440 with exact `durMs` kept (test: a 20 s workout imports as 1 min); non-SCORED keeps duration, drops metrics; WHOOP title ignored; `d` from start + record timezone_offset (test: workout at 23:30 local crossing UTC midnight, server in another zone); whoopChoice values validated, unknown ignored. Unknown sport -> 'other'.

