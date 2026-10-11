import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckCheck, ChevronDown, Clock3, Dumbbell, Minus, Pause, Pencil, Play, Plus, RotateCcw, SkipForward, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { db, deleteLocalChange } from '../db';
import { atNoon, formatLoad, newSet, sessionSchema, toKg, uid, type LoggedSet, type Profile, type Session, type Timer } from '../domain';
import { completedStats, lastPerformance, nextSet, restAfterSet, timerRemaining } from '../training';
import { finishSession } from '../db';
import { updateSession, useApp } from '../state';
import { ExercisePicker } from './Plans';
import { Empty, Modal } from '../ui';

let audio: AudioContext | undefined;
function unlockAudio() {
  try { audio ??= new AudioContext(); void audio.resume(); } catch { /* Sound is optional on unsupported devices. */ }
}
function signalRestEnd() {
  try {
    if (audio?.state === 'running') {
      const tone = audio.createOscillator(), gain = audio.createGain(); tone.connect(gain); gain.connect(audio.destination);
      tone.frequency.value = 660; gain.gain.setValueAtTime(0.08, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.5);
      tone.start(); tone.stop(audio.currentTime + 0.5);
    }
    navigator.vibrate?.([120, 60, 120]);
  } catch { /* Logging never depends on alert support. */ }
}

export function WorkoutPage() {
  const { id } = useParams(); const navigate = useNavigate();
  const { sessions, profile, run, notify } = useApp();
  const session = sessions.find(s => s.id === id);
  const [expanded, setExpanded] = useState(0);
  const [editing, setEditing] = useState(false);
  const [substitute, setSubstitute] = useState<number | 'new' | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [duration, setDuration] = useState(90);
  const [timerSetup, setTimerSetup] = useState(false);
  if (!session) return <div className="page"><Empty title="Workout not found" text="This workout may not exist in the current backup." action="Back to Today" to="/" /></div>;
  const active = session.status === 'active';
  const editable = active || editing;
  const stats = completedStats(session);
  const done = session.blocks.flatMap(b => b.sets).filter(s => s.done).length;
  const total = session.blocks.reduce((n, b) => n + b.sets.length, 0);
  const update = (fn: (session: Session) => void) => run(() => updateSession(session.id, s => { fn(s); sessionSchema.parse(s); }));
  const toggleSet = async (bi: number, si: number) => {
    unlockAudio();
    let focus: { block: number; set: number } | null = null;
    const saved = await update(s => {
      const block = s.blocks[bi], set = block.sets[si];
      if (!set.done) {
        if (set.reps === null) throw new Error('Enter reps before completing this set.');
        if (block.loadMode === 'external' && set.kg === null) throw new Error('Enter a weight before completing this set.');
      }
      set.done = !set.done;
      if (set.done && active) {
        const rest = restAfterSet(s.blocks, bi, si);
        if (rest) s.timer = { duration: rest, remaining: rest, endAt: Date.now() + rest * 1000 };
        focus = nextSet(s.blocks, bi, si);
      }
    });
    if (saved && focus) {
      const target = focus as { block: number; set: number }; setExpanded(target.block);
      if (target.block !== bi) setTimeout(() => document.getElementById(`block-${target.block}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  };
  const addSet = (bi: number, kind: LoggedSet['kind']) => update(s => {
    const block = s.blocks[bi]; let chain: string | null = null;
    if (kind === 'drop') { const last = block.sets.at(-1)!; if (last.kind === 'warmup') throw new Error('Add a working set before a drop set.'); chain = last.chainId ?? uid(); last.chainId = chain; }
    const set = { ...newSet(kind, chain), kg: null, reps: null, effort: null, done: false };
    if (kind === 'warmup') block.sets.unshift(set); else block.sets.push(set);
  });
  return <div className="page workout-page"><div className="workout-page-top"><Link className="text-button" to={active ? '/' : '/history'}><ArrowLeft size={17} />{active ? 'Today' : 'History'}</Link><span className="pill">{active ? <><span className="pulse" />In progress</> : <><CheckCheck size={14} />Completed</>}</span></div>
    <div className="page-heading compact-heading"><span className="eyebrow">{atNoon(session.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span><h1>{session.name}</h1><p>{session.blocks.length} exercises · {done} of {total} sets logged</p></div>
    <div className="progress-track" role="progressbar" aria-label="Workout sets completed" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}><div style={{ width: `${done / total * 100}%` }} /></div>
    {!active && <div className="action-row"><button className="button secondary" onClick={() => setEditing(!editing)}>{editing ? <Check size={16} /> : <Pencil size={16} />}{editing ? 'Done editing' : 'Edit log'}</button><span className="small-muted">{stats.sets} working sets · {Math.round(Number(formatLoad(stats.volumeKg, profile.unit))).toLocaleString()} {profile.unit} volume</span></div>}
    <p className="field-hint">{active ? 'Enter your actual weight and reps, then check off each set. Changes save on this device.' : 'A snapshot of the workout you completed.'}</p>
    <div className="logging-blocks">{session.blocks.map((block, bi) => {
      const previous = lastPerformance(sessions.filter(s => s.id !== session.id), block.exerciseId);
      const expandedHere = expanded === bi;
      const count = block.sets.filter(s => s.done).length;
      return <section className={`logging-card ${expandedHere ? 'expanded' : ''}`} key={block.id} id={`block-${bi}`}><button className="logging-heading" aria-expanded={expandedHere} onClick={() => setExpanded(expandedHere ? -1 : bi)}><span className="exercise-icon"><Dumbbell size={21} /></span><div><strong>{block.name}</strong><small>{block.supersetId ? `Superset ${block.supersetId.replace('superset-', '')} · ` : ''}{count}/{block.sets.length} sets · {block.restSeconds}s rest</small></div><ChevronDown className={expandedHere ? 'rotated' : ''} size={19} /></button>
        {expandedHere && <div className="logging-body">
          <div className="last-performance"><span>LAST TIME</span><strong>{previous.length ? `${previous[0].kg !== null ? `${formatLoad(previous[0].kg, profile.unit)} ${profile.unit}` : 'BW'} × ${previous[0].reps} · ${previous.length} sets` : 'Your first logged session'}</strong>{editable && previous.length > 0 && <button className="text-button" onClick={() => update(s => {
            const working = s.blocks[bi].sets.filter(set => set.kind !== 'warmup');
            working.forEach((set, i) => { const last = previous[i]; if (last && !set.done) { set.kg = last.kg; set.reps = last.reps; } });
          })}>Use previous</button>}</div>
          <div className="log-table-heading"><span>SET</span><span>{profile.unit.toUpperCase()}</span><span>REPS</span><span>RPE</span><span /></div>
          {block.sets.map((set, si) => <SetRow key={set.id} set={set} index={si} blockName={block.name} unit={profile.unit} bodyweight={block.loadMode === 'bodyweight'} editable={editable}
            onCommit={(field, value) => update(s => {
              const changed = s.blocks[bi].sets[si]; changed[field] = value;
              if ((field === 'reps' && value === null) || (field === 'kg' && value === null && block.loadMode === 'external')) changed.done = false;
            })} onToggle={() => toggleSet(bi, si)} onRemove={() => update(s => { s.blocks[bi].sets.splice(si, 1); })} canRemove={block.sets.length > 1} />)}
          {editable && <><div className="set-add-actions"><button className="text-button" onClick={() => addSet(bi, 'working')}><Plus size={15} />Set</button><button className="text-button" onClick={() => addSet(bi, 'warmup')}>Warm-up</button><button className="text-button" onClick={() => addSet(bi, 'drop')}>Drop set</button><button className="text-button" onClick={() => setSubstitute(bi)}>Substitute</button></div>
            <label className="notes-label">Exercise notes<textarea placeholder="How did it feel?" defaultValue={block.notes} key={`${block.id}-notes`} rows={2} onBlur={e => update(s => { s.blocks[bi].notes = e.target.value; })} /></label>
            <label className="inline-field">Rest (seconds)<input aria-label={`Rest seconds for ${block.name}`} type="number" inputMode="numeric" min={0} max={1800} defaultValue={block.restSeconds} onBlur={e => update(s => { s.blocks[bi].restSeconds = Number(e.target.value); })} /></label>
          </>}
        </div>}
      </section>;
    })}</div>
    {editable && <button className="button dashed" onClick={() => setSubstitute('new')}><Plus size={18} />Add exercise to this session</button>}
    {editable ? <label className="notes-label session-notes">Workout notes<textarea key={`${session.id}-session-notes`} defaultValue={session.notes} rows={2} placeholder="A little context for next time." onBlur={e => update(s => { s.notes = e.target.value; })} /></label> : session.notes && <p className="card-note">{session.notes}</p>}
    {active && <><div className="session-actions"><button className="button secondary" onClick={() => { unlockAudio(); setTimerSetup(true); }}><Clock3 size={18} />Rest timer</button><button className="button primary" onClick={() => setConfirmFinish(true)}>Finish workout<CheckCheck size={18} /></button></div><button className="text-button danger" onClick={async () => {
      if (window.confirm('Discard this unfinished workout and its logged sets?')) if (await run(() => deleteLocalChange('sessions', session.id, db.sessions))) navigate('/');
    }}><Trash2 size={15} />Discard session</button></>}
    {active && session.timer && <RestTimer timer={session.timer} onChange={timer => update(s => { s.timer = timer; })} onExpire={() => notify('Rest complete. Ready for your next set.')} />}
    {timerSetup && <Modal title="Rest timer" onClose={() => setTimerSetup(false)}><label>Duration (seconds)<input type="number" inputMode="numeric" min={1} max={1800} value={duration} onChange={e => setDuration(Number(e.target.value))} /></label><div className="chip-row">{[60, 90, 120, 180].map(seconds => <button className={`chip ${duration === seconds ? 'selected' : ''}`} key={seconds} onClick={() => setDuration(seconds)}>{seconds}s</button>)}</div><p className="field-hint">The timer resumes accurately when you return. Sound and vibration work while the app is open; locked-screen alerts depend on your browser.</p><button className="button primary" onClick={async () => { if (duration < 1 || duration > 1800) return; if (await update(s => { s.timer = { duration, remaining: duration, endAt: Date.now() + duration * 1000 }; })) setTimerSetup(false); }}><Play size={18} />Start timer</button></Modal>}
    {confirmFinish && <Modal title="Wrap it up" onClose={() => setConfirmFinish(false)}><div className="finish-summary"><CheckCheck size={35} /><h2>Every set counts.</h2><p>{done} sets logged across {session.blocks.length} exercises.</p></div>{done < total && <p className="field-hint">{total - done} unfinished sets will stay uncompleted in your log.</p>}<button className="button primary" onClick={async () => {
      if (await run(() => finishSession(session), 'Workout saved. Nice work.')) { setConfirmFinish(false); navigate('/history'); }
    }}>Save completed workout<Check size={18} /></button></Modal>}
    {substitute !== null && <ExercisePicker onClose={() => setSubstitute(null)} onChoose={async exercise => {
      const saved = await update(s => {
        if (substitute === 'new') s.blocks.push({ id: uid(), exerciseId: exercise.id, name: exercise.name, loadMode: exercise.loadMode, restSeconds: 90, supersetId: null, notes: '', sets: [0, 1, 2].map(() => ({ ...newSet(), kg: null, reps: null, effort: null, done: false })) });
        else {
          const block = s.blocks[substitute];
          if (block.sets.some(set => set.done)) throw new Error('This exercise has completed sets. Add the substitute as a new exercise to preserve your log.');
          block.exerciseId = exercise.id; block.name = exercise.name; block.loadMode = exercise.loadMode;
          block.sets.forEach(set => { set.kg = null; set.reps = null; });
        }
      });
      if (saved) { setSubstitute(null); if (substitute === 'new') setExpanded(session.blocks.length); }
    }} />}
  </div>;
}

function SetRow({ set, index, blockName, unit, bodyweight, editable, onCommit, onToggle, onRemove, canRemove }: {
  set: LoggedSet; index: number; blockName: string; unit: Profile['unit']; bodyweight: boolean; editable: boolean;
  onCommit: (field: 'kg' | 'reps' | 'effort', value: number | null) => Promise<boolean>;
  onToggle: () => Promise<void>; onRemove: () => Promise<boolean>; canRemove: boolean;
}) {
  const [kg, setKg] = useState(set.kg === null ? '' : formatLoad(set.kg, unit));
  const [reps, setReps] = useState(set.reps === null ? '' : String(set.reps));
  const [effort, setEffort] = useState(set.effort === null ? '' : String(set.effort));
  const { notify } = useApp();
  useEffect(() => setKg(set.kg === null ? '' : formatLoad(set.kg, unit)), [set.kg, unit]);
  useEffect(() => setReps(set.reps === null ? '' : String(set.reps)), [set.reps]);
  useEffect(() => setEffort(set.effort === null ? '' : String(set.effort)), [set.effort]);
  const commit = async (field: 'kg' | 'reps' | 'effort', text: string) => {
    const restore = () => {
      if (field === 'kg') setKg(set.kg === null ? '' : formatLoad(set.kg, unit));
      if (field === 'reps') setReps(set.reps === null ? '' : String(set.reps));
      if (field === 'effort') setEffort(set.effort === null ? '' : String(set.effort));
    };
    const number = Number(text); const max = field === 'effort' ? 10 : field === 'reps' ? 100 : 4000;
    if (text !== '' && (!Number.isFinite(number) || number < (field === 'kg' ? 0 : 1) || number > max || (field === 'reps' && !Number.isInteger(number)))) {
      notify(`Enter a valid ${field === 'kg' ? 'weight' : field === 'effort' ? 'RPE from 1 to 10' : 'rep count from 1 to 100'}.`, true); restore(); return;
    }
    const value = text === '' ? null : field === 'kg' ? toKg(number, unit) : number;
    if (value !== set[field] && !await onCommit(field, value)) restore();
  };
  return <div className={`log-row ${set.done ? 'done' : ''} ${set.kind === 'drop' ? 'drop-row' : ''}`}>
    <div className="set-number"><strong>{set.kind === 'warmup' ? 'W' : set.kind === 'drop' ? 'D' : index + 1}</strong><small>{set.targetReps} target</small></div>
    <input aria-label={`Weight set ${index + 1} ${blockName}`} type="number" inputMode="decimal" step="any" min={0} disabled={!editable} value={kg} placeholder={set.targetKg !== null ? formatLoad(set.targetKg, unit) : bodyweight ? 'BW' : '—'} onChange={e => setKg(e.target.value)} onBlur={() => commit('kg', kg)} />
    <input aria-label={`Reps set ${index + 1} ${blockName}`} type="number" inputMode="numeric" min={1} max={100} disabled={!editable} value={reps} placeholder={String(set.targetReps)} onChange={e => setReps(e.target.value)} onBlur={() => commit('reps', reps)} />
    <input aria-label={`RPE set ${index + 1} ${blockName}`} type="number" inputMode="decimal" min={1} max={10} step="0.5" disabled={!editable} value={effort} placeholder="—" onChange={e => setEffort(e.target.value)} onBlur={() => commit('effort', effort)} />
    <button className={`set-check ${set.done ? 'checked' : ''}`} aria-label={`${set.done ? 'Uncomplete' : 'Complete'} set ${index + 1} ${blockName}`} aria-pressed={set.done} disabled={!editable} onClick={onToggle}><Check size={19} /></button>
    {editable && canRemove && <button className="remove-log-set" aria-label={`Delete set ${index + 1} ${blockName}`} onClick={() => { if (!set.done || window.confirm('Remove this completed set?')) void onRemove(); }}><Minus size={12} /></button>}
  </div>;
}

function RestTimer({ timer, onChange, onExpire }: { timer: Timer; onChange: (timer: Timer | null) => Promise<boolean>; onExpire: () => void }) {
  const [remaining, setRemaining] = useState(timerRemaining(timer));
  const alerted = useRef<number | null>(null);
  useEffect(() => {
    const tick = () => {
      const seconds = timerRemaining(timer); setRemaining(seconds);
      if (timer.endAt !== null && seconds === 0 && alerted.current !== timer.endAt) {
        alerted.current = timer.endAt; signalRestEnd(); onExpire();
      }
    };
    tick(); const interval = setInterval(tick, 250); document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', tick); };
  }, [timer.endAt, timer.remaining, onExpire]);
  return <aside className={`rest-timer ${remaining === 0 ? 'finished' : ''}`} aria-label="Rest timer"><div className="timer-circle"><Clock3 size={19} /></div><div className="timer-readout"><span>{remaining === 0 ? 'READY FOR YOUR NEXT SET' : timer.endAt === null ? 'REST PAUSED' : 'REST & RESET'}</span><strong role="timer" aria-label={`${remaining} seconds remaining`}>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</strong></div><div className="timer-controls"><button className="icon-button" aria-label={timer.endAt === null ? 'Resume timer' : 'Pause timer'} onClick={() => { unlockAudio(); void onChange(timer.endAt === null ? { ...timer, endAt: Date.now() + remaining * 1000 } : { ...timer, remaining, endAt: null }); }}>{timer.endAt === null ? <Play size={19} /> : <Pause size={19} />}</button><button className="icon-button" aria-label="Reset timer" onClick={() => onChange({ ...timer, remaining: timer.duration, endAt: Date.now() + timer.duration * 1000 })}><RotateCcw size={17} /></button><button className="icon-button" aria-label="Add 30 seconds" onClick={() => onChange({ ...timer, remaining: remaining + 30, duration: Math.min(1800, timer.duration + 30), endAt: timer.endAt === null ? null : Date.now() + (remaining + 30) * 1000 })}><Plus size={18} /></button><button className="icon-button" aria-label="Skip timer" onClick={() => onChange(null)}><SkipForward size={18} /></button></div></aside>;
}
