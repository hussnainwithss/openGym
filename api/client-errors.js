/* Start-up failure reports from the web app (fork): frontend/src/lib/boot-report.js sends one when
 * the app dies or hangs before it has drawn, so a blank page on someone else's phone leaves a trace
 * on the server. One JSON object per line in DATA_DIR/client-errors.log, and the same line on the
 * container log.
 *
 * Unauthenticated by necessity (the app failed before anyone could sign in), so everything here is
 * bounded: a few fields, each a short string or number, a budget per address and one for the whole
 * instance, and a file that is rotated once instead of growing. Nothing in a report is trusted:
 * unknown fields are dropped, strings clipped, and the line is written by JSON.stringify, so a
 * report cannot forge a second line. */
import fs from 'node:fs';
import { createWindow } from './rate-limit.js';

const KINDS = new Set(['error', 'rejection', 'stuck']);
const LIMITS = { msg: 500, stack: 4000, src: 300, stage: 40, ua: 400, path: 200, build: 40, lang: 20, sw: 20 };
const MAX_STAGES = 30;
const FILE_MAX = 512 * 1024;

const str = (v, n) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, n);
const num = (v, max) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : undefined);

/** A report as it is logged, or null when it is not one. */
export function cleanReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !KINDS.has(body.kind)) return null;
  const out = { kind: body.kind };
  for (const [k, n] of Object.entries(LIMITS)) { const s = str(body[k], n); if (s) out[k] = s; }
  const ms = num(body.ms, 3_600_000);
  if (ms !== undefined) out.ms = ms;
  if (typeof body.online === 'boolean') out.online = body.online;
  if (Array.isArray(body.stages)) {
    out.stages = body.stages.slice(0, MAX_STAGES)
      .filter(s => s && typeof s === 'object')
      .map(s => ({ s: str(s.s, LIMITS.stage), t: num(s.t, 3_600_000) ?? 0 }))
      .filter(s => s.s);
  }
  return out;
}

/** The log: `record(addr, ip, body)` → 'logged' | 'limited' | 'invalid'. */
export function createClientErrorLog({ file, now = Date.now, log = console.warn, perAddress = 5, perHour = 60 } = {}) {
  const byAddr = createWindow({ max: perAddress, windowMs: 10 * 60_000, maxKeys: 2000, now });
  const all = createWindow({ max: perHour, windowMs: 60 * 60_000, maxKeys: 1, now });
  return {
    record(addr, ip, body) {
      const rep = cleanReport(body);
      if (!rep) return 'invalid';
      if (byAddr.take(addr) || all.take('all')) return 'limited';
      const line = JSON.stringify({ ts: new Date(now()).toISOString(), ...(ip ? { ip } : {}), ...rep });
      log('[client-error] ' + line);
      try {
        if (fs.statSync(file, { throwIfNoEntry: false })?.size > FILE_MAX) fs.renameSync(file, file + '.1');
        fs.appendFileSync(file, line + '\n', { mode: 0o600 });
      } catch (e) { console.error('client-error log write failed', e.message); }
      return 'logged';
    },
    sweep() { byAddr.sweep(); all.sweep(); }
  };
}
