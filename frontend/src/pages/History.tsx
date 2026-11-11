import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, CalendarDays, ChevronDown, Dumbbell, TrendingUp, Trophy } from 'lucide-react';
import { Link } from 'react-router';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { atNoon, formatLoad, fromKg, localDate, type Session } from '../domain';
import { completedStats, sessionDuration, weeklyStats } from '../training';
import { useApp } from '../state';
import { Empty, Modal, SectionTitle } from '../ui';
import type { TrainingDB } from '../db';
import { useDatabaseQuery } from '../queries';
import { completedInRange, countJournal, journalCursor, readHistorySummary, readJournalPage, weekBounds, type JournalCursor } from '../historyQueries';

export function History() {
  const { database, profile, exercises } = useApp();
  const [selected, setSelected] = useState('all');
  const [metric, setMetric] = useState('sets');
  const [range, setRange] = useState(8);
  const [journalOpen, setJournalOpen] = useState(false);
  const count = useDatabaseQuery(database, database => countJournal(database, ''));
  const summary = useDatabaseQuery(database, readHistorySummary);
  const recent = useDatabaseQuery(database, async database => (await readJournalPage(database, null, '', 3)).rows);
  const bounds = weekBounds(localDate(), range);
  const chartSessions = useDatabaseQuery(database, database => completedInRange(database, bounds.start, bounds.end).toArray(), [bounds.start, bounds.end]);
  const weeks = useMemo(() => weeklyStats(chartSessions ?? [], range), [chartSessions, range]);
  if (count === undefined || !recent) return <div className="page" role="status">Opening your history…</div>;
  const trackedExercises = (summary?.exercises ?? []).map(ex => ({ ...ex, name: exercises.find(e => e.id === ex.id)?.name ?? ex.name }));
  const weekly = weeks.at(-1)!;
  const liftData = (chartSessions ?? []).flatMap(s => {
    const sets = s.blocks.filter(b => b.exerciseId === selected).flatMap(b => b.sets).filter(set => set.done && set.kind !== 'warmup');
    if (!sets.length) return [];
    return [{ date: s.date, label: atNoon(s.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      sets: sets.length, weight: Math.max(...sets.map(set => fromKg(set.kg ?? 0, profile.unit))),
      reps: Math.max(...sets.map(set => set.reps ?? 0)), volume: sets.reduce((n, set) => n + fromKg(set.kg ?? 0, profile.unit) * (set.reps ?? 0), 0) }];
  });
  const chartData: { date: string; label: string; sets: number; volume: number; weight?: number; reps?: number; workouts?: number }[] = selected === 'all' ? weeks.map(w => ({ ...w, volume: fromKg(w.volumeKg, profile.unit) })) : liftData;
  const selectedMetric = selected === 'all' && ['weight', 'reps'].includes(metric) ? 'sets' : selected !== 'all' && metric === 'workouts' ? 'weight' : metric;
  const label = { sets: 'Working sets', volume: `External-load volume (${profile.unit})`, workouts: 'Completed workouts', weight: `Best load (${profile.unit})`, reps: 'Best rep count' }[selectedMetric];
  const benchmark = summary?.exercises.find(ex => ex.id === selected);
  return <div className="page"><div className="page-heading"><h1>History</h1><p>Your sessions and progress.</p></div>
    {!count ? <Empty title="No completed workouts yet" text="Complete a workout to see your session history, personal records, and progress over time." action="Go to Today" to="/" /> : <>
      <SectionTitle title="Session journal"><span className="small-muted">{count} sessions</span></SectionTitle><div className="list-card">{recent.map(session => <SessionRow key={session.id} session={session} />)}</div>
      <button className="text-button" onClick={() => { setJournalOpen(true); }}>View all {count} sessions</button>
      <div className="stats-grid history-stats" aria-busy={!summary}><div><span>Workouts</span><strong>{count}<small> all time</small></strong></div><div><span>Working sets</span><strong>{summary?.sets ?? '…'}<small> all time</small></strong></div><div><span>This week</span><strong>{weekly.workouts}<small> workouts</small></strong></div></div>
      <section className="chart-card"><SectionTitle title="Training trends"><TrendingUp size={20} className="text-accent" /></SectionTitle>
        <div className="chart-filters"><label className="select-wrap"><span className="sr-only">Exercise trend</span><select aria-label="Exercise trend" value={selected} onChange={e => { setSelected(e.target.value); setMetric(e.target.value === 'all' ? 'sets' : 'weight'); }}><option value="all">All training</option>{trackedExercises.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}</select><ChevronDown size={14} /></label><label className="select-wrap"><span className="sr-only">Chart range</span><select aria-label="Chart range" value={range} onChange={e => setRange(Number(e.target.value))}><option value={4}>4 weeks</option><option value={8}>8 weeks</option><option value={12}>12 weeks</option><option value={52}>1 year</option></select></label></div>
        <div className="chip-row">{(selected === 'all' ? ['sets', 'workouts', 'volume'] : ['weight', 'reps', 'volume']).map(key => <button className={`chip ${selectedMetric === key ? 'selected' : ''}`} aria-pressed={selectedMetric === key} key={key} onClick={() => setMetric(key)}>{({ sets: 'Sets', workouts: 'Workouts', volume: 'Volume', weight: 'Load', reps: 'Reps' } as Record<string, string>)[key]}</button>)}</div>
        <p className="chart-caption">{label}</p>
        <div className="chart-container" aria-busy={!chartSessions} role="img" aria-label={`${label} over the last ${range} weeks`}>
          {!chartSessions ? <p className="field-hint" role="status">Loading chart…</p> : <ResponsiveContainer width="100%" height={220}><AreaChart data={chartData} margin={{ top: 10, right: 8, left: -25, bottom: 0 }} accessibilityLayer><defs><linearGradient id="progressGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#c8f36b" stopOpacity={0.25} /><stop offset="100%" stopColor="#c8f36b" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#30352c" vertical={false} strokeDasharray="3 4" /><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#a2a89a', fontSize: 11 }} minTickGap={24} /><YAxis axisLine={false} tickLine={false} tick={{ fill: '#a2a89a', fontSize: 11 }} allowDecimals={selectedMetric === 'volume' || selectedMetric === 'weight'} /><Tooltip contentStyle={{ background: '#232720', border: '1px solid #3b4434', borderRadius: 12, color: '#eef3e7' }} formatter={value => [Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 }), label]} /><Area type="monotone" dataKey={selectedMetric} stroke="#c8f36b" strokeWidth={2.5} fill="url(#progressGradient)" isAnimationActive={false} dot={{ r: 3, fill: '#c8f36b', strokeWidth: 0 }} /></AreaChart></ResponsiveContainer>}
        </div>
        <p className="field-hint">Completed working and drop sets only. Volume = entered external weight × reps; bodyweight contributes only added load.</p>
        <details className="chart-values"><summary>View chart values</summary><table><thead><tr><th>Date</th><th>{label}</th></tr></thead><tbody>{chartData.map((row, i) => <tr key={`${row.date}-${i}`}><td>{row.date}</td><td>{Number((row as unknown as Record<string, number>)[selectedMetric] ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}</td></tr>)}</tbody></table></details>
      </section>
      {selected !== 'all' && benchmark && benchmark.sets > 0 && <div className="record-card"><span className="exercise-icon"><Trophy size={22} /></span><div><span className="eyebrow">Personal benchmark</span><strong>{formatLoad(benchmark.kg, profile.unit)} {profile.unit} best external load</strong><small>{benchmark.reps} reps · best logged rep count</small></div></div>}

    </>}
    {journalOpen && <Journal database={database} onClose={() => setJournalOpen(false)} />}
    <div className="quiet-note"><CalendarDays size={17} /><p>Progress comes from your logs. Every completed session gives you a little more to learn from.</p><Dumbbell size={18} /></div>
  </div>;
}


function SessionRow({ session }: { session: Session }) {
  const stats = completedStats(session);
  return <Link className="history-row" to={`/workout/${session.id}`}><span className="history-date"><strong>{atNoon(session.date).getDate()}</strong><small>{atNoon(session.date).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</small></span><div><strong>{session.name}</strong><small>{stats.sets} working sets · {session.blocks.length} exercises · {sessionDuration(session)}</small></div><ArrowUpRight size={19} /></Link>;
}

function Journal({ database, onClose }: { database: TrainingDB; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const [search, setSearch] = useState(normalized);
  useEffect(() => { const timeout = setTimeout(() => setSearch(normalized), 200); return () => clearTimeout(timeout); }, [normalized]);
  const count = useDatabaseQuery(database, database => countJournal(database, search), [search]);
  const pending = search !== normalized || count === undefined;
  return <Modal title="All sessions" onClose={onClose}>
    <label>Search sessions<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Workout, exercise, or date" /></label>
    <p className="field-hint" role="status">{pending ? 'Searching sessions…' : `${count} matching sessions`}</p>
    <div aria-busy={pending}>{!pending && (count === 0 ? <p>No matching sessions. Try another workout name, exercise, or date.</p> : <JournalPage key={search} database={database} cursor={null} query={search} />)}</div>
  </Modal>;
}

function JournalPage({ database, cursor, query }: { database: TrainingDB; cursor: JournalCursor | null; query: string }) {
  const [expanded, setExpanded] = useState(false);
  const cursorKey = JSON.stringify(cursor);
  const page = useDatabaseQuery(database, database => readJournalPage(database, cursor, query), [cursorKey, query]);
  if (!page) return <p className="field-hint" role="status">Loading sessions…</p>;
  const next = page.rows.length ? journalCursor(page.rows.at(-1)!) : null;
  return <>
    <div className="list-card">{page.rows.map(session => <SessionRow key={session.id} session={session} />)}</div>
    {page.hasMore && next && (expanded ? <JournalPage key={JSON.stringify(next)} database={database} cursor={next} query={query} /> : <button className="button secondary" onClick={() => setExpanded(true)}>Show more sessions</button>)}
  </>;
}
