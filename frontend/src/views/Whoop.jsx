// The WHOOP page (fork, whoop-vitals): recovery, HRV, resting heart rate, sleep and strain over
// weeks and months, and every day's numbers. The last 120 days are in the profile (S.whoopDays) and
// show offline; longer ranges are read from the server's WHOOP history (GET /api/whoop/days, at
// most 400 days a request), falling back to what the profile holds when the server cannot answer.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { fmtDate, fmtNum, todayISO } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { whoopDaysOf, trendOf, rangeOf, partValue } from '../lib/whoop-days.js'
import LineChart from '../components/LineChart.jsx'
import Icon from '../components/Icon.jsx'
import { Segmented } from '../components/ui.jsx'

const RANGES = [{ value: 30, label: '1M' }, { value: 90, label: '3M' }, { value: 365, label: '1Y' }, { value: 730, label: '2Y' }]
const CHARTS = [
  { key: 'rec', label: 'Recovery', unit: '%', color: 'var(--green)' },
  { key: 'hrv', label: 'HRV (RMSSD)', unit: 'ms', color: 'var(--teal)' },
  { key: 'rhr', label: 'Resting heart rate', unit: 'bpm', color: 'var(--red)' },
  { key: 'sleepMin', label: 'Sleep', unit: 'min', color: 'var(--indigo)' },
  { key: 'strain', label: 'Strain', unit: '', color: 'var(--orange)' },
]

/** Days for a range: the server's history in chunks of at most 400 days, or the profile's copy. */
export async function loadDays(S, today, n, get = p => api(p)) {
  const { from, to } = rangeOf(today, n)
  const chunks = []
  for (let end = to; end >= from;) {
    const r = rangeOf(end, 400)
    const start = r.from < from ? from : r.from
    chunks.push([start, end])
    end = rangeOf(start, 2).from   // the day before this chunk
  }
  try {
    const parts = await Promise.all(chunks.map(([f, e]) => get(`/api/whoop/days?from=${f}&to=${e}`)))
    return { days: parts.flatMap(p => p?.days || []).sort((a, b) => (a.d < b.d ? -1 : 1)), offline: false }
  } catch {
    return { days: whoopDaysOf(S).filter(x => x.d >= from && x.d <= to), offline: true }
  }
}

export default function Whoop() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const [range, setRange] = useState(90)
  const [state, setState] = useState(null)
  const today = todayISO()
  useEffect(() => {
    let gone = false
    loadDays(S, today, range).then(r => { if (!gone) setState(r) })
    return () => { gone = true }
  }, [range, today, S.whoopDays]) // eslint-disable-line react-hooks/exhaustive-deps
  const days = state?.days || []
  const lines = useMemo(() => CHARTS.map(c => ({ ...c, points: trendOf(days, c.key) })).filter(c => c.points.length > 1), [days])
  const hm = m => `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`
  const dayLine = x => [
    partValue(x, 'rec', 'rec') != null ? 'Recovery ' + (typeof partValue(x, 'rec', 'rec') === 'number' ? fmtNum(x.rec) + '%' : partValue(x, 'rec', 'rec')) : null,
    Number.isFinite(x.hrv) ? 'HRV ' + fmtNum(Math.round(x.hrv)) + ' ms' : null,
    Number.isFinite(x.rhr) ? 'RHR ' + fmtNum(x.rhr) : null,
    Number.isFinite(x.sleepMin) ? 'Sleep ' + hm(x.sleepMin) : null,
    Number.isFinite(x.strain) ? 'Strain ' + fmtNum(x.strain) : null,
  ].filter(Boolean).join(' · ')

  return <div className="narrow" data-whoop-page>
    <div className="hdr">
      <button className="iconbtn" data-back="/stats" onClick={() => nav('/stats')} aria-label={t('Stats')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>WHOOP</h1><div className="sub">Recovery, sleep and strain</div></div>
    </div>
    <div className="card">
      <Segmented className="seg-range" value={range} onChange={setRange} options={RANGES} />
      {state?.offline && <div className="small muted" style={{ marginTop: 8 }}>Your server cannot be reached: showing the last 120 days this device has.</div>}
      {lines.map(c => <div key={c.key} data-whoop-chart={c.key} style={{ marginTop: 12 }}>
        <div className="muted small">{c.label}</div>
        <div className="chart"><LineChart points={c.points} h={130} unit={c.unit} color={c.color} /></div>
      </div>)}
      {state && !days.length && <div className="small muted" style={{ marginTop: 12 }}>No WHOOP days in this range yet.</div>}
    </div>
    {days.length > 0 && <div className="list" data-whoop-days>
      {[...days].reverse().map(x => <div key={x.d} className="item" data-whoop-day={x.d}>
        <div className="grow"><div className="tt">{fmtDate(x.d, true)}</div><div className="ss">{dayLine(x)}</div></div>
      </div>)}
    </div>}
  </div>
}
