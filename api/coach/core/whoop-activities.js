/* WHOOP activities as everyone reads them (fork): the app (frontend/src/lib/activities.js) and the
 * server (streak.js) both go through this file, so a session the server counts is one the phone
 * shows. It lives in coach/core because that is the folder every build already shares with the
 * frontend. Pure, no node or DOM imports.
 *
 * The server writes a WHOOP activity once (api/integrations/whoop/activities.js); what WHOOP
 * changes later sits in S.whoopActs[id], written by the server only. Read here:
 *   - an activity the person edited (`edited: 1`) is theirs: WHOOP's later changes are not shown
 *   - otherwise WHOOP's latest fields are shown over the stored ones, and `gone: 1` hides it */

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
// The fields a WHOOP update may carry over the stored activity.
const UPDATE_FIELDS = ['d', 'sport', 'min', 'at', 'durMs', 'km', 'title', 'st', 'strain', 'hr', 'hrMax', 'kj'];

/** The activity as it should show: the stored `entry` with WHOOP's later changes, or null when
 *  WHOOP deleted it. Any other source passes through untouched. */
export function effectiveActivity(S, id, entry) {
  if (!isMap(entry) || entry.src !== 'whoop' || entry.edited === 1) return entry;
  const u = isMap(S?.whoopActs) ? S.whoopActs[id] : null;
  if (!isMap(u)) return entry;
  if (u.gone === 1) return null;
  const out = { ...entry };
  for (const k of UPDATE_FIELDS) {
    if (u[k] !== undefined) out[k] = u[k];
    else if (k === 'km' || k === 'title' || k === 'st' || k === 'strain' || k === 'hr' || k === 'hrMax' || k === 'kj') delete out[k];
  }
  return out;
}
