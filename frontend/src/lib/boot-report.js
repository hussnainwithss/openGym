// Fork: a start-up that fails or hangs on someone else's phone leaves a trace on the server.
// main.jsx imports this first, so its listeners are in place before any other module of the app
// runs. Until the app has drawn (bootDone), an uncaught error, an unhandled rejection, a script or
// stylesheet that failed to load, or no first screen after STUCK_MS sends one report to
// POST /api/client-error (api/client-errors.js) with the steps reached so far (bootStage).
// Nothing shows on screen. After the first screen it goes quiet: later errors are the app's own.
// Not in the phone apps: they have their own network log, and their server is optional.

const STUCK_MS = 20000
const MAX_REPORTS = 3

const now = () => Math.round(typeof performance !== 'undefined' ? performance.now() : 0)
const stages = []
let done = false, sent = 0, timer = null

const native = () => { try { return !!window.Capacitor?.isNativePlatform?.() } catch { return false } }

/** Records a start-up step ('store', 'config', ...); the report says which was reached last. */
export function bootStage(s) {
  if (done || stages.length >= 30) return
  stages.push({ s: String(s).slice(0, 40), t: now() })
}

/** The app has drawn its first screen: no report from here on. */
export function bootDone() {
  if (done) return
  bootStage('drawn')
  done = true
  if (timer) clearTimeout(timer)
}

/** The report as sent, for the tests. */
export function bootReport(kind, err, extra = {}) {
  const e = err && typeof err === 'object' ? err : null
  const msg = e ? String(e.message || e.name || '') : err == null ? '' : String(err)
  return {
    kind,
    msg: msg.slice(0, 500),
    stack: String(e?.stack || '').slice(0, 4000),
    src: String(extra.src || '').slice(0, 300),
    stage: stages.length ? stages[stages.length - 1].s : 'none',
    stages: stages.slice(),
    ms: now(),
    ua: String(navigator.userAgent || '').slice(0, 400),
    // The route only: no query string, which can carry a sign-in or device-link code.
    path: (location.pathname + location.hash.split('?')[0]).slice(0, 200),
    build: typeof __APP_VERSION__ !== 'undefined' ? String(__APP_VERSION__) : '',
    lang: String(navigator.language || '').slice(0, 20),
    sw: !('serviceWorker' in navigator) ? 'none' : navigator.serviceWorker.controller ? 'controlled' : 'not-controlled',
    online: navigator.onLine !== false,
  }
}

function send(kind, err, extra) {
  if (done || sent >= MAX_REPORTS) return
  sent++
  try {
    fetch('/api/client-error', {
      method: 'POST', keepalive: true, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bootReport(kind, err, extra)),
    }).catch(() => {})
  } catch { /* nothing left to tell */ }
}

function onError(ev) {
  const t = ev.target
  // A <script> or <link> that failed to load: no error object, only the element.
  if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
    send('error', 'failed to load ' + t.tagName.toLowerCase(), { src: t.src || t.href || '' })
    return
  }
  send('error', ev.error || ev.message, { src: ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : '' })
}

export function startBootReport() {
  if (typeof window === 'undefined' || native()) return
  bootStage('script')
  // Capture: a failed resource load does not bubble to window.
  window.addEventListener('error', onError, true)
  window.addEventListener('unhandledrejection', ev => send('rejection', ev.reason))
  timer = setTimeout(() => send('stuck', 'no first screen after ' + STUCK_MS / 1000 + ' s'), STUCK_MS)
}

// Every test file that imports the store would otherwise start it too; its own test starts it.
if (!import.meta.env?.VITEST) startBootReport()
