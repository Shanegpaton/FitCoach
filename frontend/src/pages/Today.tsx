import { useState } from 'react';
import { ArrowRight, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Clock3, Dumbbell, Flame, MoveRight, Plus, Sparkles } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { createSession, db, putLocalChange } from '../db';
import { atNoon, localDate, uid, weekdayNames, type Workout } from '../domain';
import { completedStats, scheduledWorkout, startSession, weeklyStats } from '../training';
import { useApp } from '../state';
import { Empty, Modal, SectionTitle } from '../ui';

export function Today() {
  const { profile, plans, exercises, sessions, overrides, run } = useApp();
  const navigate = useNavigate();
  const [date, setDate] = useState(localDate());
  const [moving, setMoving] = useState(false);
  const [moveDate, setMoveDate] = useState(localDate());
  const plan = plans.find(p => p.active);
  const workout = plan && scheduledWorkout(plan, date, overrides);
  const activeSessions = sessions.filter(s => s.status === 'active').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const active = activeSessions[0];
  const completed = sessions.filter(s => s.status === 'completed');
  const week = weeklyStats(sessions, 1)[0];
  const start = async (workout: Workout) => {
    if (active) { navigate(`/workout/${active.id}`); return; }
    if (!plan) return;
    await run(async () => { const session = startSession(plan, workout, exercises, date); await createSession(session); navigate(`/workout/${session.id}`); });
  };
  const monday = atNoon(date); monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const dates = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return d; });
  const shift = (days: number) => { const d = atNoon(date); d.setDate(d.getDate() + days); setDate(localDate(d)); };
  return <div className="page today-page">
    <div className="page-heading"><span className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span><h1>Make room<br />for <span className="text-accent">stronger.</span></h1><p>Your next set starts here.</p></div>
    <div className="week-heading"><span>{atNoon(date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span><div><button className="icon-button" onClick={() => shift(-7)} aria-label="Previous week"><ChevronLeft size={18} /></button><button className="text-button" onClick={() => setDate(localDate())}>Today</button><button className="icon-button" onClick={() => shift(7)} aria-label="Next week"><ChevronRight size={18} /></button></div></div>
    <div className="week-strip">{dates.map(d => {
      const iso = localDate(d); const scheduled = plan && scheduledWorkout(plan, iso, overrides);
      const logged = completed.some(s => s.date === iso);
      return <button key={iso} className={`${iso === date ? 'selected' : ''} ${iso === localDate() ? 'is-today' : ''}`} aria-label={d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} aria-pressed={iso === date} onClick={() => setDate(iso)}><span>{weekdayNames[d.getDay()]}</span><strong>{d.getDate()}</strong><i className={logged ? 'logged' : scheduled ? 'planned' : ''} /></button>;
    })}</div>
    <SectionTitle eyebrow={plan?.schedule === 'rotation' ? 'UP NEXT IN YOUR ROTATION' : date === localDate() ? 'YOUR TRAINING TODAY' : 'YOUR TRAINING'} title={active ? 'Pick up where you left off' : 'On the schedule'} />
    {active ? <div className="workout-hero"><span className="pill"><span className="pulse" />In progress</span><h2>{active.name}</h2><p>{active.blocks.length} exercises · {active.blocks.flatMap(b => b.sets).filter(s => s.done).length} sets logged</p><Link to={`/workout/${active.id}`} className="button primary">Resume workout<ArrowRight size={20} /></Link>{activeSessions.length > 1 && <div className="other-active"><span className="eyebrow">OTHER WORKOUTS IN PROGRESS</span>{activeSessions.slice(1).map(item => <Link key={item.id} to={`/workout/${item.id}`}>{item.name} · {item.blocks.flatMap(b => b.sets).filter(s => s.done).length} sets logged<ArrowUpRight size={16} /></Link>)}</div>}</div>
      : workout ? <div className="workout-hero"><div className="hero-top"><span className="pill"><Dumbbell size={14} />{plan!.name}</span><span className="hero-number">{String(plan!.workouts.indexOf(workout) + 1).padStart(2, '0')}</span></div>
        <h2>{workout.name}</h2><div className="hero-meta"><span><Dumbbell size={15} />{workout.blocks.length} exercises</span><span><Clock3 size={15} />{profile.sessionMinutes} min target</span></div>
        <div className="hero-exercises">{workout.blocks.slice(0, 3).map(b => <span key={b.id}>{exercises.find(ex => ex.id === b.exerciseId)?.name}</span>)}{workout.blocks.length > 3 && <span>+{workout.blocks.length - 3} more</span>}</div>
        <button className="button primary" onClick={() => start(workout)}>Start workout<ArrowRight size={20} /></button>
        {plan!.schedule === 'week' && <button className="text-button hero-move" onClick={() => { setMoveDate(date); setMoving(true); }}><CalendarDays size={15} />Move to another day</button>}
      </div> : plan ? <div className="rest-card"><span className="empty-icon"><Flame size={24} /></span><div><h2>A little room to recover.</h2><p>No workout scheduled. Rest, or choose a session below.</p></div></div>
      : <Empty title="Your plan starts with you." text="Build your own routine or explore a sample plan with Coach. Your workouts and progress will live right here." action="Create a plan" to="/plan" />}
    <div className="stats-grid"><div><span>THIS WEEK</span><strong>{week.workouts}<small> workouts</small></strong></div><div><span>WORKING SETS</span><strong>{week.sets}<small> this week</small></strong></div><div><span>ALL TIME</span><strong>{completed.length}<small> workouts</small></strong></div></div>
    {plan && <><SectionTitle title="Your workouts"><Link to="/plan" className="text-button">Edit plan<ArrowUpRight size={15} /></Link></SectionTitle><div className="list-card">{plan.workouts.map((w, index) => <button key={w.id} className="workout-list-row" onClick={() => start(w)}><span className="row-index">{String(index + 1).padStart(2, '0')}</span><div><strong>{w.name}</strong><small>{w.blocks.length} exercises · {w.blocks.reduce((n, b) => n + b.sets.length, 0)} sets</small></div><ArrowUpRight size={20} /></button>)}</div></>}
    <Link to="/coach" className="coach-callout"><span className="coach-symbol"><Sparkles size={23} /></span><div><strong>A plan you understand.</strong><p>Explore your routine with Coach.</p></div><MoveRight size={20} /></Link>
    {completed.length > 0 && <><SectionTitle title="Last time you showed up" /><Link className="recent-card" to={`/workout/${completed.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0].id}`}><HistoryPreview session={completed[0]} /><ArrowUpRight size={20} /></Link></>}
    {!plan && <Link className="text-button" to="/coach"><Plus size={16} />Try a sample Coach plan</Link>}
    {moving && workout && plan && <Modal title="Move workout" onClose={() => setMoving(false)}><p>Move {workout.name} from {date}. Other weeks keep their usual schedule.</p><label>New date<input type="date" value={moveDate} onChange={e => setMoveDate(e.target.value)} /></label><button className="button primary" onClick={async () => {
      if (moveDate === date) { setMoving(false); return; }
      const conflict = scheduledWorkout(plan, moveDate, overrides);
      if (conflict) { await run(async () => { throw new Error('That day already has a workout. Choose a rest day.'); }); return; }
      if (await run(async () => {
        const existing = overrides.find(o => o.planId === plan.id && o.workoutId === workout.id && o.date === date);
        const override = { id: existing?.id ?? uid(), planId: plan.id, workoutId: workout.id, originalDate: existing?.originalDate ?? date, date: moveDate };
        await putLocalChange('overrides', override, db.overrides);
      }, 'Workout moved')) { setMoving(false); setDate(moveDate); }
    }}>Move workout<ArrowRight size={18} /></button></Modal>}
  </div>;
}

function HistoryPreview({ session }: { session: import('../domain').Session }) {
  return <div><span className="eyebrow">{atNoon(session.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><strong>{session.name}</strong><small>{completedStats(session).sets} working sets completed</small></div>;
}
