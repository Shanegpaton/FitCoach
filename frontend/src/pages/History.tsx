import { useState } from 'react';
import { ArrowUpRight, CalendarDays, ChevronDown, Dumbbell, TrendingUp, Trophy } from 'lucide-react';
import { Link } from 'react-router';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { atNoon, formatLoad, fromKg } from '../domain';
import { completedStats, weeklyStats } from '../training';
import { useApp } from '../state';
import { Empty, SectionTitle } from '../ui';

export function History() {
  const { sessions, profile, exercises } = useApp();
  const completed = sessions.filter(s => s.status === 'completed').sort((a, b) => b.date.localeCompare(a.date) || (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const [selected, setSelected] = useState('all');
  const [metric, setMetric] = useState('sets');
  const [range, setRange] = useState(8);
  const exercisedIds = new Set(completed.flatMap(s => s.blocks.filter(b => b.sets.some(set => set.done)).map(b => b.exerciseId)));
  const trackedExercises = [...exercisedIds].map(id => ({ id, name: exercises.find(e => e.id === id)?.name ?? completed.flatMap(s => s.blocks).find(b => b.exerciseId === id)?.name ?? 'Exercise' }));
  const weeks = weeklyStats(completed, range);
  const weekly = weeks.at(-1)!;
  const startDate = weeks[0].date;
  const liftData = [...completed].reverse().filter(s => s.date >= startDate).flatMap(s => {
    const sets = s.blocks.filter(b => b.exerciseId === selected).flatMap(b => b.sets).filter(set => set.done && set.kind !== 'warmup');
    if (!sets.length) return [];
    return [{ date: s.date, label: atNoon(s.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      sets: sets.length, weight: Math.max(...sets.map(set => fromKg(set.kg ?? 0, profile.unit))),
      reps: Math.max(...sets.map(set => set.reps ?? 0)), volume: sets.reduce((n, set) => n + fromKg(set.kg ?? 0, profile.unit) * (set.reps ?? 0), 0) }];
  });
  const chartData: { date: string; label: string; sets: number; volume: number; weight?: number; reps?: number; workouts?: number }[] = selected === 'all' ? weeks.map(w => ({ ...w, volume: fromKg(w.volumeKg, profile.unit) })) : liftData;
  const selectedMetric = selected === 'all' && ['weight', 'reps'].includes(metric) ? 'sets' : selected !== 'all' && metric === 'workouts' ? 'weight' : metric;
  const label = { sets: 'Working sets', volume: `External-load volume (${profile.unit})`, workouts: 'Completed workouts', weight: `Best load (${profile.unit})`, reps: 'Best rep count' }[selectedMetric];
  const totalSets = completed.reduce((n, s) => n + completedStats(s).sets, 0);
  const selectedSets = completed.flatMap(s => s.blocks.filter(b => b.exerciseId === selected).flatMap(b => b.sets)).filter(set => set.done && set.kind !== 'warmup');
  return <div className="page"><div className="page-heading"><span className="eyebrow">THE WORK ADDS UP</span><h1>Proof of<br /><span className="text-accent">showing up.</span></h1><p>Your history. Your next benchmark.</p></div>
    {!completed.length ? <Empty title="Your first chapter is ahead." text="Complete a workout to see your session history, personal records, and progress over time." action="Go to Today" to="/" /> : <>
      <div className="stats-grid history-stats"><div><span>WORKOUTS</span><strong>{completed.length}<small> all time</small></strong></div><div><span>WORKING SETS</span><strong>{totalSets}<small> all time</small></strong></div><div><span>THIS WEEK</span><strong>{weekly.workouts}<small> workouts</small></strong></div></div>
      <section className="chart-card"><SectionTitle eyebrow="PROGRESS OVER TIME" title="Keep the momentum"><TrendingUp size={20} className="text-accent" /></SectionTitle>
        <div className="chart-filters"><label className="select-wrap"><span className="sr-only">Exercise trend</span><select aria-label="Exercise trend" value={selected} onChange={e => { setSelected(e.target.value); setMetric(e.target.value === 'all' ? 'sets' : 'weight'); }}><option value="all">All training</option>{trackedExercises.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}</select><ChevronDown size={14} /></label><label className="select-wrap"><span className="sr-only">Chart range</span><select aria-label="Chart range" value={range} onChange={e => setRange(Number(e.target.value))}><option value={4}>4 weeks</option><option value={8}>8 weeks</option><option value={12}>12 weeks</option><option value={52}>1 year</option></select></label></div>
        <div className="chip-row">{(selected === 'all' ? ['sets', 'workouts', 'volume'] : ['weight', 'reps', 'volume']).map(key => <button className={`chip ${selectedMetric === key ? 'selected' : ''}`} key={key} onClick={() => setMetric(key)}>{({ sets: 'Sets', workouts: 'Workouts', volume: 'Volume', weight: 'Load', reps: 'Reps' } as Record<string, string>)[key]}</button>)}</div>
        <p className="chart-caption">{label}</p>
        <div className="chart-container" role="img" aria-label={`${label} over the last ${range} weeks`}>
          <ResponsiveContainer width="100%" height={220}><AreaChart data={chartData} margin={{ top: 10, right: 8, left: -25, bottom: 0 }} accessibilityLayer><defs><linearGradient id="progressGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#c8f36b" stopOpacity={0.25} /><stop offset="100%" stopColor="#c8f36b" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#30352c" vertical={false} strokeDasharray="3 4" /><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#a2a89a', fontSize: 11 }} minTickGap={24} /><YAxis axisLine={false} tickLine={false} tick={{ fill: '#a2a89a', fontSize: 11 }} allowDecimals={selectedMetric === 'volume' || selectedMetric === 'weight'} /><Tooltip contentStyle={{ background: '#232720', border: '1px solid #3b4434', borderRadius: 12, color: '#eef3e7' }} formatter={value => [Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 }), label]} /><Area type="monotone" dataKey={selectedMetric} stroke="#c8f36b" strokeWidth={2.5} fill="url(#progressGradient)" isAnimationActive={false} dot={{ r: 3, fill: '#c8f36b', strokeWidth: 0 }} /></AreaChart></ResponsiveContainer>
        </div>
        <p className="field-hint">Completed working and drop sets only. Volume = entered external weight × reps; bodyweight contributes only added load.</p>
        <details className="chart-values"><summary>View chart values</summary><table><thead><tr><th>Date</th><th>{label}</th></tr></thead><tbody>{chartData.map((row, i) => <tr key={`${row.date}-${i}`}><td>{row.date}</td><td>{Number((row as unknown as Record<string, number>)[selectedMetric] ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}</td></tr>)}</tbody></table></details>
      </section>
      {selected !== 'all' && selectedSets.length > 0 && <div className="record-card"><span className="exercise-icon"><Trophy size={22} /></span><div><span className="eyebrow">PERSONAL BENCHMARK</span><strong>{formatLoad(Math.max(...selectedSets.map(s => s.kg ?? 0)), profile.unit)} {profile.unit} best external load</strong><small>{Math.max(...selectedSets.map(s => s.reps ?? 0))} reps · best logged rep count</small></div></div>}
      <SectionTitle title="Session journal"><span className="small-muted">{completed.length} sessions</span></SectionTitle><div className="list-card">{completed.map(session => {
        const stats = completedStats(session);
        return <Link className="history-row" key={session.id} to={`/workout/${session.id}`}><span className="history-date"><strong>{atNoon(session.date).getDate()}</strong><small>{atNoon(session.date).toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</small></span><div><strong>{session.name}</strong><small>{stats.sets} working sets · {session.blocks.length} exercises</small></div><ArrowUpRight size={19} /></Link>;
      })}</div>
    </>}
    <div className="quiet-note"><CalendarDays size={17} /><p>Progress comes from your logs. Every completed session gives you a little more to learn from.</p><Dumbbell size={18} /></div>
  </div>;
}
