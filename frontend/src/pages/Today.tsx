import { useState } from 'react';
import { ArrowRight, ArrowUpRight, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Dumbbell, Flame, Info, MoveRight, Plus, Sparkles } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { createSession, db, putLocalChange } from '../db';
import { atNoon, localDate, uid, weekdayNames, type Workout } from '../domain';
import { completedStats, planWorkoutForDate, scheduledWorkout, startSession, weeklyStats } from '../training';
import { useApp } from '../state';
import { Empty, Modal, SectionTitle } from '../ui';

export function Today() {
  const { profile, plans, exercises, sessions, overrides, run } = useApp();
  const navigate = useNavigate();
  const [date, setDate] = useState(localDate());
  const [moving, setMoving] = useState(false);
  const [moveDate, setMoveDate] = useState(localDate());
  const [viewingWorkout, setViewingWorkout] = useState<Workout | null>(null);

  // Only the active plan should determine the scheduled workouts on the calendar.
  const plan = plans.find(p => p.active);

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

  const start = async (workoutToStart: Workout) => {
    if (active) { navigate(`/workout/${active.id}`); return; }
    if (!plan) return;
    await run(async () => {
      const session = startSession(plan, workoutToStart, exercises, date);
      await createSession(session);
      navigate(`/workout/${session.id}`);
    });
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
    ? 'TODAY'
    : atNoon(date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase();
  const eyebrow = plan?.schedule === 'rotation' && isToday ? 'UP NEXT IN YOUR ROTATION' : formattedDate;
  const title = sessionInProgress
    ? 'Pick up where you left off'
    : completedOnDate
      ? 'Completed workout'
      : currentWorkout
        ? 'On the schedule'
        : plan
          ? 'Rest day'
          : 'On the schedule';

  return (
    <div className="page today-page">
      <div className="page-heading">
        <span className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        <h1>Make room<br />for <span className="text-accent">stronger.</span></h1>
        <p>Your next set starts here.</p>
      </div>

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
              <span className="eyebrow">OTHER WORKOUTS IN PROGRESS</span>
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
            <span className="hero-number"><Check size={40} /></span>
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
          {currentWorkout && (
            <button className="text-button hero-move" onClick={() => start(currentWorkout)}>
              <Plus size={15} />Start another session
            </button>
          )}
        </div>
      ) : currentWorkout ? (
        <div className="workout-hero">
          <div className="hero-top">
            <span className="pill"><Dumbbell size={14} />{plan!.name}</span>
            <span className="hero-number">{String(plan!.workouts.indexOf(currentWorkout) + 1).padStart(2, '0')}</span>
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
          <button className="text-button hero-details" onClick={() => setViewingWorkout(currentWorkout)}>
            <Info size={14} />View plan details
          </button>
          {plan!.schedule === 'week' && (
            <button className="text-button hero-move" onClick={() => { setMoveDate(date); setMoving(true); }}>
              <CalendarDays size={15} />Move to another day
            </button>
          )}
        </div>
      ) : plan ? (
        <div className="rest-card">
          <span className="empty-icon"><Flame size={24} /></span>
          <div>
            <span className="pill">Rest day</span>
            <h2>Rest day</h2>
            <p>No workout scheduled for this day. Rest, recover, or choose a workout below if you want to train.</p>
          </div>
        </div>
      ) : (
        <Empty
          title="Your plan starts with you."
          text="Build your own routine or explore a sample plan with Coach. Your workouts and progress will live right here."
          action="Create a plan"
          to="/plan"
        />
      )}

      <div className="stats-grid">
        <div><span>THIS WEEK</span><strong>{week.workouts}<small> workouts</small></strong></div>
        <div><span>WORKING SETS</span><strong>{week.sets}<small> this week</small></strong></div>
        <div><span>ALL TIME</span><strong>{completed.length}<small> workouts</small></strong></div>
      </div>

      {plan && (
        <>
          <SectionTitle title="Your workouts">
            <Link to="/plan" className="text-button">Edit plan<ArrowUpRight size={15} /></Link>
          </SectionTitle>
          <div className="list-card">
            {plan.workouts.map((w, index) => (
              <button key={w.id} className="workout-list-row" onClick={() => start(w)}>
                <span className="row-index">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{w.name}</strong>
                  <small>{w.blocks.length} exercises · {w.blocks.reduce((n, b) => n + b.sets.length, 0)} sets</small>
                </div>
                <ArrowUpRight size={20} />
              </button>
            ))}
          </div>
        </>
      )}

      <Link to="/coach" className="coach-callout">
        <span className="coach-symbol"><Sparkles size={23} /></span>
        <div><strong>A plan you understand.</strong><p>Explore your routine with Coach.</p></div>
        <MoveRight size={20} />
      </Link>

      {completed.length > 0 && (
        <>
          <SectionTitle title="Last time you showed up" />
          <Link
            className="recent-card"
            to={`/workout/${completed.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0].id}`}
          >
            <HistoryPreview session={completed[0]} />
            <ArrowUpRight size={20} />
          </Link>
        </>
      )}

      {!plan && (
        <Link className="text-button" to="/coach"><Plus size={16} />Try a sample Coach plan</Link>
      )}

      {viewingWorkout && (
        <Modal title={viewingWorkout.name} onClose={() => setViewingWorkout(null)}>
          <p className="field-hint">
            Scheduled plan for {atNoon(date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <div className="workout-detail-modal-blocks">
            {viewingWorkout.blocks.map((block, bi) => {
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
          <button className="button primary" onClick={() => { setViewingWorkout(null); start(viewingWorkout); }}>
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
