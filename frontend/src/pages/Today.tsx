import { useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Dumbbell, Flame, Info, MoveRight, Plus, Sparkles } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { createSession, db, putLocalChange } from '../db';
import { atNoon, localDate, uid, weekdayNames, type Plan, type Workout } from '../domain';
import { completedStats, planWorkoutForDate, scheduledWorkout, startSession, weeklyStats } from '../training';
import { useApp } from '../state';
import { Empty, Modal, SectionTitle } from '../ui';

type Routine = { plan: Plan; workout: Workout };

export function Today() {
  const { profile, plans, exercises, sessions, overrides, run } = useApp();
  const navigate = useNavigate();
  const [date, setDate] = useState(localDate());
  const [moving, setMoving] = useState(false);
  const [moveDate, setMoveDate] = useState(localDate());
  const [viewingWorkout, setViewingWorkout] = useState<Routine | null>(null);
  const [blockedWorkout, setBlockedWorkout] = useState<Routine | null>(null);
  const starting = useRef(false);

  // Only the active plan should determine the scheduled workouts on the calendar.
  const plan = plans.find(p => p.active);
  const routinePlans = [...plans.filter(item => item.active), ...plans.filter(item => !item.active)];

  const getScheduled = (iso: string): Workout | undefined => planWorkoutForDate(plan, iso, overrides);

  const currentWorkout = getScheduled(date);
  const activeSessions = sessions.filter(s => s.status === 'active').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const active = activeSessions[0];
  const activeOnDate = activeSessions.find(s => s.date === date);
  const isActiveToday = active && date === localDate() && active.date === localDate();
  const sessionInProgress = activeOnDate ?? (isActiveToday ? active : undefined);

  const completed = sessions.filter(s => s.status === 'completed');
  const completedOnDate = completed.find(s => s.date === date);
  const week = weeklyStats(sessions, 1)[0];

  const start = async (workoutToStart: Workout, sourcePlan = plan) => {
    if (!sourcePlan) return;
    if (active) {
      if (active.planId === sourcePlan.id && active.workoutId === workoutToStart.id) navigate(`/workout/${active.id}`);
      else setBlockedWorkout({ plan: sourcePlan, workout: workoutToStart });
      return;
    }
    if (starting.current) return;
    starting.current = true;
    try { await run(async () => {
      const session = startSession(sourcePlan, workoutToStart, exercises, date);
      await createSession(session);
      navigate(`/workout/${session.id}`);
    }); } finally { starting.current = false; }
  };

  const monday = atNoon(date);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });

  const shift = (days: number) => {
    const d = atNoon(date);
    d.setDate(d.getDate() + days);
    setDate(localDate(d));
  };

  const isToday = date === localDate();
  const formattedDate = isToday
    ? 'Today'
    : atNoon(date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const eyebrow = plan?.schedule === 'rotation' && isToday ? 'Next in your rotation' : formattedDate;
  const title = sessionInProgress
    ? 'Pick up where you left off'
    : completedOnDate
      ? 'Completed workout'
      : currentWorkout
        ? (isToday ? 'Start today’s workout' : 'Suggested workout')
        : routinePlans.length
          ? 'Choose a routine'
          : 'Get started';

  return (
    <div className="page today-page">
      <div className="page-heading today-heading">
        <h1>Today</h1>
        <p>{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      </div>


      {active && !sessionInProgress && (
        <div className="active-callout-banner">
          <span className="pulse" />
          <div>
            <strong>Workout in progress</strong>
            <small>{active.name} · Started {active.date === localDate() ? 'today' : atNoon(active.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</small>
          </div>
          <Link to={`/workout/${active.id}`} className="text-button">Resume workout &rarr;</Link>
        </div>
      )}

      <SectionTitle eyebrow={eyebrow} title={title} />

      {sessionInProgress ? (
        <div className="workout-hero">
          <span className="pill"><span className="pulse" />In progress</span>
          <h2>{sessionInProgress.name}</h2>
          <p>{sessionInProgress.blocks.length} exercises · {sessionInProgress.blocks.flatMap(b => b.sets).filter(s => s.done).length} sets logged</p>
          <Link to={`/workout/${sessionInProgress.id}`} className="button primary">
            Resume workout<ArrowRight size={20} />
          </Link>
          {activeSessions.length > 1 && (
            <div className="other-active">
              <span className="eyebrow">Other workouts in progress</span>
              {activeSessions.filter(item => item.id !== sessionInProgress.id).map(item => (
                <Link key={item.id} to={`/workout/${item.id}`}>
                  {item.name} · {item.blocks.flatMap(b => b.sets).filter(s => s.done).length} sets logged<ArrowUpRight size={16} />
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : completedOnDate ? (
        <div className="workout-hero">
          <div className="hero-top">
            <span className="pill accent"><Check size={13} />Completed</span>

          </div>
          <h2>{completedOnDate.name}</h2>
          <div className="hero-meta">
            <span><Dumbbell size={15} />{completedOnDate.blocks.length} exercises</span>
            <span><Check size={15} />{completedStats(completedOnDate).sets} working sets logged</span>
          </div>
          <div className="hero-exercises">
            {completedOnDate.blocks.map(b => (
              <span key={b.id}>{b.name}</span>
            ))}
          </div>
          <Link to={`/workout/${completedOnDate.id}`} className="button primary">
            View completed session<ArrowUpRight size={20} />
          </Link>
          {routinePlans.some(item => item.workouts.length > 0) && (
            <button className="text-button hero-move" onClick={() => document.getElementById('today-workouts')?.scrollIntoView({ block: 'start' })}>
              <Plus size={15} />Start another session
            </button>
          )}
        </div>
      ) : currentWorkout ? (
        <div className="workout-hero">
          <div className="hero-top">
            <span className="pill"><Dumbbell size={14} />{plan!.name}</span>

          </div>
          <h2>{currentWorkout.name}</h2>
          <div className="hero-meta">
            <span><Dumbbell size={15} />{currentWorkout.blocks.length} exercises</span>
            <span><Clock3 size={15} />{profile.sessionMinutes} min target</span>
          </div>
          <div className="hero-exercises">
            {currentWorkout.blocks.slice(0, 3).map(b => (
              <span key={b.id}>{exercises.find(ex => ex.id === b.exerciseId)?.name}</span>
            ))}
            {currentWorkout.blocks.length > 3 && <span>+{currentWorkout.blocks.length - 3} more</span>}
          </div>
          <button className="button primary" onClick={() => start(currentWorkout)}>
            Start workout<ArrowRight size={20} />
          </button>
          <button className="text-button hero-details" onClick={() => setViewingWorkout({ plan: plan!, workout: currentWorkout })}>
            <Info size={14} />View plan details
          </button>
          {plan!.schedule === 'week' && (
            <button className="text-button hero-move" onClick={() => { setMoveDate(date); setMoving(true); }}>
              <CalendarDays size={15} />Move to another day
            </button>
          )}
        </div>
      ) : routinePlans.length ? (
        <div className="rest-card">
          <span className="empty-icon"><Flame size={24} /></span>
          <div>
            <h2>Choose what you want to train</h2>
            <p>No workout planned for this day. Start any routine below whenever you’re ready.</p>
          </div>
        </div>
      ) : (
        <Empty
          title="Create your first plan"
          text="Choose your exercises or start with an editable sample. Your plan and workout log stay available offline."
          action="Create a plan"
          to="/plan"
        />
      )}

      {routinePlans.length > 0 && <section id="today-workouts" className="routine-library" aria-label="Your routines">
        <SectionTitle title="Your routines"><Link to="/plan" className="text-button">Manage routines<ArrowUpRight size={15} /></Link></SectionTitle>
        <p className="field-hint">Tap a routine to start. Your plan is a suggestion; choose what fits today.</p>
        {routinePlans.map(sourcePlan => <section key={sourcePlan.id} className="routine-group" aria-label={`Workouts from ${sourcePlan.name}`}>
          <div className="routine-group-heading"><h3>{sourcePlan.name}</h3><span>{sourcePlan.active ? 'Current plan' : 'Saved plan'}</span></div>
          <div className="list-card">
            {sourcePlan.workouts.map(workout => <button key={workout.id} className="workout-list-row" aria-label={`Start ${workout.name} from ${sourcePlan.name}`} onClick={() => void start(workout, sourcePlan)}>
              <span className="exercise-icon"><Dumbbell size={20} /></span>
              <div><strong>{workout.name}</strong><small>{workout.blocks.length} {workout.blocks.length === 1 ? 'exercise' : 'exercises'} · {workout.blocks.reduce((total, block) => total + block.sets.length, 0)} sets</small></div>
              <span className="routine-start">Start<ArrowRight size={17} /></span>
            </button>)}
          </div>
        </section>)}
      </section>}

      <section className="calendar-section" aria-label="Workout calendar">
      <div className="week-heading">
        <span>{atNoon(date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <div>
          <button className="icon-button" onClick={() => shift(-7)} aria-label="Previous week"><ChevronLeft size={18} /></button>
          <button className="text-button" onClick={() => setDate(localDate())}>Today</button>
          <button className="icon-button" onClick={() => shift(7)} aria-label="Next week"><ChevronRight size={18} /></button>
        </div>
      </div>

      <div className="week-strip">
        {dates.map(d => {
          const iso = localDate(d);
          const scheduled = getScheduled(iso);
          const logged = completed.some(s => s.date === iso);
          const hasActive = activeSessions.some(s => s.date === iso);
          return (
            <button
              key={iso}
              className={`${iso === date ? 'selected' : ''} ${iso === localDate() ? 'is-today' : ''}`}
              aria-label={d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
              aria-pressed={iso === date}
              onClick={() => setDate(iso)}
            >
              <span>{weekdayNames[d.getDay()]}</span>
              <strong>{d.getDate()}</strong>
              <i className={logged ? 'logged' : scheduled || hasActive ? 'planned' : ''} />
            </button>
          );
        })}
      </div>

      </section>

      <div className="stats-grid">
        <div><span>This week</span><strong>{week.workouts}<small> workouts</small></strong></div>
        <div><span>Working sets</span><strong>{week.sets}<small> this week</small></strong></div>
        <div><span>All time</span><strong>{completed.length}<small> workouts</small></strong></div>
      </div>

      <Link to="/coach" className="coach-callout">
        <span className="coach-symbol"><Sparkles size={23} /></span>
        <div><strong>Talk through your training</strong><p>Explore your routine with Coach.</p></div>
        <MoveRight size={20} />
      </Link>

      {completed.length > 0 && (
        <>
          <SectionTitle title="Last completed workout" />
          <Link
            className="recent-card"
            to={`/workout/${completed.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0].id}`}
          >
            <HistoryPreview session={completed[0]} />
            <ArrowUpRight size={20} />
          </Link>
        </>
      )}

      {routinePlans.length === 0 && (
        <Link className="text-button" to="/coach"><Plus size={16} />Try a sample Coach plan</Link>
      )}

      {blockedWorkout && active && <Modal title="Workout already in progress" onClose={() => setBlockedWorkout(null)}><p>{active.name} is still in progress. Finish it before starting {blockedWorkout.workout.name}. Your recorded sets are kept.</p><div className="action-row"><Link className="button primary" to={`/workout/${active.id}`}>Resume {active.name}</Link><button className="button secondary" onClick={() => { setViewingWorkout(blockedWorkout); setBlockedWorkout(null); }}>Review {blockedWorkout.workout.name}</button></div></Modal>}
      {viewingWorkout && (
        <Modal title={viewingWorkout.workout.name} onClose={() => setViewingWorkout(null)}>
          <p className="field-hint">
            Workout preview for {atNoon(date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <div className="workout-detail-modal-blocks">
            {viewingWorkout.workout.blocks.map((block, bi) => {
              const ex = exercises.find(e => e.id === block.exerciseId);
              const workingSets = block.sets.filter(s => s.kind !== 'warmup');
              return (
                <div key={block.id} className="workout-detail-block">
                  <div>
                    <strong>{bi + 1}. {ex?.name ?? 'Unknown exercise'}</strong>
                    <span>{ex?.muscle} · {ex?.equipment}</span>
                  </div>
                  <span>{block.sets.length} sets ({workingSets.length} working)</span>
                </div>
              );
            })}
          </div>
          <button className="button primary" onClick={() => { setViewingWorkout(null); start(viewingWorkout.workout, viewingWorkout.plan); }}>
            Start this workout<ArrowRight size={18} />
          </button>
        </Modal>
      )}

      {moving && currentWorkout && plan && (
        <Modal title="Move workout" onClose={() => setMoving(false)}>
          <p>Move {currentWorkout.name} from {date}. Other weeks keep their usual schedule.</p>
          <label>New date<input type="date" value={moveDate} onChange={e => setMoveDate(e.target.value)} /></label>
          <button
            className="button primary"
            onClick={async () => {
              if (moveDate === date) { setMoving(false); return; }
              const conflict = scheduledWorkout(plan, moveDate, overrides);
              if (conflict) {
                await run(async () => { throw new Error('That day already has a workout. Choose a rest day.'); });
                return;
              }
              if (await run(async () => {
                const existing = overrides.find(o => o.planId === plan.id && o.workoutId === currentWorkout.id && o.date === date);
                const override = { id: existing?.id ?? uid(), planId: plan.id, workoutId: currentWorkout.id, originalDate: existing?.originalDate ?? date, date: moveDate };
                await putLocalChange('overrides', override, db.overrides);
              }, 'Workout moved')) {
                setMoving(false);
                setDate(moveDate);
              }
            }}
          >
            Move workout<ArrowRight size={18} />
          </button>
        </Modal>
      )}
    </div>
  );
}

function HistoryPreview({ session }: { session: import('../domain').Session }) {
  return (
    <div>
      <span className="eyebrow">{atNoon(session.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
      <strong>{session.name}</strong>
      <small>{completedStats(session).sets} working sets completed</small>
    </div>
  );
}
