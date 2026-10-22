import { useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronRight, Copy, Dumbbell, Library, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { db, putLocalChange, savePlan } from '../db';
import { starterPlan } from '../catalog';
import { exerciseSchema, formatLoad, newBlock, newPlan, newSet, normalizeDropChains, toKg, uid, type Block, type Exercise, type Plan } from '../domain';
import { useApp } from '../state';
import { Days, Empty, Modal, SectionTitle } from '../ui';

export function Plans() {
  const { plans, profile, run } = useApp();
  const [editing, setEditing] = useState<Plan | null>(null);
  const [library, setLibrary] = useState(false);
  const duplicate = (plan: Plan) => {
    const copy = structuredClone(plan); copy.id = uid(); copy.name += ' copy'; copy.active = false; copy.revision = 0; copy.cursor = 0;
    copy.workouts.forEach(w => { w.id = uid(); w.blocks.forEach(b => { b.id = uid(); b.sets.forEach(s => { s.id = uid(); }); }); });
    setEditing(copy);
  };
  return <div className="page"><div className="page-heading"><span className="eyebrow">BUILT AROUND YOU</span><h1>Your training<br /><span className="text-accent">blueprint.</span></h1><p>Structure for the days you show up.</p></div>
    <div className="action-row"><button className="button primary" onClick={() => setEditing(newPlan())}><Plus size={18} />New plan</button><button className="button secondary" onClick={() => setLibrary(true)}><Library size={18} />Exercises</button></div>
    {plans.length === 0 ? <Empty title="Start with a little structure." text="Create your own routine, or use an editable sample template. Choose your own starting weights." action="Explore a starter template" onClick={() => setEditing(starterPlan(profile))} />
      : <div className="plan-grid">{plans.map(plan => <article className={`plan-card ${plan.active ? 'is-active' : ''}`} key={plan.id}>
        <div className="card-top"><span className={plan.active ? 'pill accent' : 'pill'}>{plan.active ? <><Check size={13} />Active plan</> : 'Saved plan'}</span><span className="small-muted">{plan.schedule === 'week' ? 'Weekly schedule' : 'Rotation'}</span></div>
        <h2>{plan.name}</h2>{plan.description && <p>{plan.description}</p>}<p>{plan.workouts.length} workouts · {plan.workouts.reduce((n, w) => n + w.blocks.length, 0)} exercise slots</p>
        <div className="plan-preview">{plan.workouts.map((w, i) => <div key={w.id}><span className="row-index">{String(i + 1).padStart(2, '0')}</span><strong>{w.name}</strong><small>{w.blocks.length} exercises</small></div>)}</div>
        <div className="card-actions"><button className="button secondary" onClick={() => setEditing(structuredClone(plan))}><Pencil size={16} />Edit plan</button>{!plan.active && <button className="text-button" onClick={() => run(() => savePlan({ ...plan, active: true }), 'Active plan updated')}>Make active</button>}<button className="icon-button" aria-label={`Duplicate ${plan.name}`} onClick={() => duplicate(plan)}><Copy size={18} /></button></div>
      </article>)}</div>}
    {plans.length > 0 && <button className="text-button" onClick={() => setEditing(starterPlan(profile))}>Explore a sample template<ArrowRight size={16} /></button>}
    {editing && <PlanEditor initial={editing} onClose={() => setEditing(null)} onSave={async plan => {
      if (await run(() => savePlan({ ...plan, active: plan.active || !plans.some(p => p.active) }), 'Plan saved')) setEditing(null);
    }} />}
    {library && <ExerciseLibrary onClose={() => setLibrary(false)} />}
  </div>;
}

export function PlanEditor({ initial, onClose, onSave, saveLabel = 'Save plan', title }: { initial: Plan; onClose: () => void; onSave: (plan: Plan) => Promise<void>; saveLabel?: string; title?: string }) {
  const { exercises, profile, run } = useApp();
  const [plan, setPlan] = useState(() => structuredClone(initial));
  const [index, setIndex] = useState(0);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const workout = plan.workouts[index];
  const changeWorkout = (update: (workout: Plan['workouts'][number]) => void) => setPlan(current => {
    const copy = structuredClone(current); update(copy.workouts[index]); return copy;
  });
  const changeBlock = (blockId: string, update: (block: Block) => void) => changeWorkout(w => {
    const block = w.blocks.find(b => b.id === blockId); if (block) { update(block); normalizeDropChains(block.sets); }
  });
  const moveBlock = (blockIndex: number, delta: number) => changeWorkout(w => {
    const next = blockIndex + delta;
    if (next < 0 || next >= w.blocks.length) return;
    [w.blocks[blockIndex], w.blocks[next]] = [w.blocks[next], w.blocks[blockIndex]];
  });
  return <Modal title={title ?? (saveLabel === 'Save plan' ? 'Plan editor' : 'Review proposal')} onClose={onClose} wide>
    <div className="form-grid"><label>Plan name<input value={plan.name} maxLength={100} onChange={e => setPlan({ ...plan, name: e.target.value })} /></label><label>Schedule<select value={plan.schedule} onChange={e => setPlan({ ...plan, schedule: e.target.value as Plan['schedule'], cursor: 0 })}><option value="week">Weekday schedule</option><option value="rotation">Rotating sequence</option></select></label></div>
    <label>Plan description<textarea value={plan.description ?? ''} maxLength={2000} rows={2} onChange={e => setPlan({ ...plan, description: e.target.value })} placeholder="What is this plan designed to help you do?" /></label>
    <p className="field-hint">{plan.schedule === 'week' ? 'Choose training days for each workout. Missed days do not move the rest of the week.' : 'Complete the next workout to advance. Train whenever it works for you.'}</p>
    <div className="workout-tabs">{plan.workouts.map((w, i) => <button key={w.id} className={i === index ? 'selected' : ''} onClick={() => setIndex(i)}>{w.name || `Workout ${i + 1}`}</button>)}<button aria-label="Add workout" onClick={() => { setPlan({ ...plan, workouts: [...plan.workouts, { id: uid(), name: `Workout ${String.fromCharCode(65 + plan.workouts.length)}`, days: [], blocks: [] }] }); setIndex(plan.workouts.length); }}><Plus size={18} /></button></div>
    <div className="workout-edit-heading"><label>Workout name<input value={workout.name} maxLength={100} onChange={e => changeWorkout(w => { w.name = e.target.value; })} /></label><div className="inline-actions"><button className="icon-button" aria-label="Move workout earlier" disabled={index === 0} onClick={() => {
      const workouts = [...plan.workouts]; [workouts[index - 1], workouts[index]] = [workouts[index], workouts[index - 1]]; setPlan({ ...plan, workouts, cursor: 0 }); setIndex(index - 1);
    }}><ArrowUp size={17} /></button><button className="icon-button" aria-label="Move workout later" disabled={index === plan.workouts.length - 1} onClick={() => {
      const workouts = [...plan.workouts]; [workouts[index + 1], workouts[index]] = [workouts[index], workouts[index + 1]]; setPlan({ ...plan, workouts, cursor: 0 }); setIndex(index + 1);
    }}><ArrowDown size={17} /></button><button className="icon-button" aria-label="Duplicate workout" onClick={() => {
      const copy = structuredClone(workout); copy.id = uid(); copy.name += ' copy'; copy.days = [];
      copy.blocks.forEach(b => { b.id = uid(); b.sets.forEach(s => { s.id = uid(); }); });
      setPlan({ ...plan, workouts: [...plan.workouts, copy] }); setIndex(plan.workouts.length);
    }}><Copy size={17} /></button><button className="icon-button danger" aria-label="Delete workout" disabled={plan.workouts.length === 1} onClick={() => {
      if (window.confirm(`Remove ${workout.name} from this plan? Past logs will stay intact.`)) {
        setPlan({ ...plan, cursor: 0, workouts: plan.workouts.filter(w => w.id !== workout.id) }); setIndex(Math.max(0, index - 1));
      }
    }}><Trash2 size={17} /></button></div></div>
    {plan.schedule === 'week' && <label className="days-label">Training days<Days value={workout.days} onChange={days => setPlan(current => ({ ...current, workouts: current.workouts.map((w, i) => i === index ? { ...w, days } : { ...w, days: w.days.filter(d => !days.includes(d)) }) }))} /></label>}
    <div className="editor-blocks">{workout.blocks.map((block, bi) => {
      const exercise = exercises.find(e => e.id === block.exerciseId);
      return <section className="editor-block" key={block.id}><div className="block-heading"><span className="exercise-icon"><Dumbbell size={19} /></span><button className="exercise-name" onClick={() => setChoosing(block.id)}><strong>{exercise?.name}</strong><small>{exercise?.muscle} · tap to substitute</small></button><div className="inline-actions"><button className="icon-button" aria-label={`Move ${exercise?.name} up`} disabled={bi === 0} onClick={() => moveBlock(bi, -1)}><ArrowUp size={16} /></button><button className="icon-button" aria-label={`Move ${exercise?.name} down`} disabled={bi === workout.blocks.length - 1} onClick={() => moveBlock(bi, 1)}><ArrowDown size={16} /></button><button className="icon-button danger" aria-label={`Remove ${exercise?.name}`} onClick={() => changeWorkout(w => { w.blocks = w.blocks.filter(b => b.id !== block.id); })}><X size={17} /></button></div></div>
        <div className="form-grid compact"><label>Rest (seconds)<input type="number" min={0} max={1800} inputMode="numeric" value={block.restSeconds} onChange={e => changeBlock(block.id, b => { b.restSeconds = Number(e.target.value); })} /></label><label>Superset group<select value={block.supersetId ?? ''} onChange={e => changeBlock(block.id, b => { b.supersetId = e.target.value || null; })}><option value="">None</option>{['A', 'B', 'C', 'D'].map(group => <option key={group} value={`superset-${group}`}>Group {group}</option>)}</select></label></div>
        <div className="prescription-header"><span>TYPE</span><span>REPS</span><span>{profile.unit.toUpperCase()} TARGET</span><span /></div>
        {block.sets.map((set, si) => <div className="prescription-row" key={set.id}><select aria-label={`Set ${si + 1} type for ${exercise?.name}`} value={set.kind} onChange={e => changeBlock(block.id, b => {
          const target = b.sets[si]; target.kind = e.target.value as typeof set.kind;
          if (target.kind !== 'drop') { if (target.kind === 'warmup') target.chainId = null; }
          else { const previous = b.sets[si - 1]; if (!previous || previous.kind === 'warmup') { target.kind = 'working'; return; } const chain = previous.chainId ?? uid(); previous.chainId = chain; target.chainId = chain; }
        })}><option value="working">Set {si + 1}</option><option value="warmup">Warm-up</option><option value="drop" disabled={si === 0}>Drop</option></select>
          <input type="number" inputMode="numeric" min={1} max={100} aria-label={`Target reps set ${si + 1} for ${exercise?.name}`} value={set.targetReps} onChange={e => changeBlock(block.id, b => { b.sets[si].targetReps = Number(e.target.value); })} />
          <input type="number" inputMode="decimal" step="any" min={0} max={4000} aria-label={`Target weight set ${si + 1} for ${exercise?.name}`} placeholder={exercise?.loadMode === 'bodyweight' ? 'BW' : '—'} value={set.targetKg === null ? '' : formatLoad(set.targetKg, profile.unit)} onChange={e => changeBlock(block.id, b => { b.sets[si].targetKg = e.target.value === '' ? null : toKg(Number(e.target.value), profile.unit); })} />
          <button className="icon-button danger" disabled={block.sets.length === 1} aria-label={`Remove set ${si + 1} from ${exercise?.name}`} onClick={() => changeBlock(block.id, b => { b.sets.splice(si, 1); })}><X size={15} /></button></div>)}
        <div className="set-add-actions"><button className="text-button" onClick={() => changeBlock(block.id, b => { b.sets.push(newSet()); })}><Plus size={14} />Set</button><button className="text-button" onClick={() => changeBlock(block.id, b => { b.sets.unshift(newSet('warmup')); })}>Warm-up</button><button className="text-button" onClick={() => changeBlock(block.id, b => {
          const previous = b.sets.at(-1)!; if (previous.kind === 'warmup') return;
          const chain = previous.chainId ?? uid(); previous.chainId = chain; b.sets.push(newSet('drop', chain));
        })}>Drop set</button></div>
      </section>;
    })}</div>
    <button className="button dashed" onClick={() => setChoosing('new')}><Plus size={18} />Add exercise</button>
    <div className="editor-footer"><p className="field-hint">Targets are yours to choose. Existing workout logs stay unchanged.</p><button className="button primary" disabled={saving} onClick={async () => {
      setSaving(true); await run(async () => {
        if (plan.workouts.some(w => w.blocks.length === 0)) throw new Error('Add at least one exercise to every workout.');
        await onSave(plan);
      }); setSaving(false);
    }}>{saving ? 'Saving…' : saveLabel}<Check size={18} /></button></div>
    {choosing && <ExercisePicker onClose={() => setChoosing(null)} onChoose={exercise => {
      if (choosing === 'new') changeWorkout(w => { w.blocks.push(newBlock(exercise.id)); });
      else changeBlock(choosing, b => { b.exerciseId = exercise.id; });
      setChoosing(null);
    }} />}
  </Modal>;
}

export function ExercisePicker({ onChoose, onClose }: { onChoose: (exercise: Exercise) => void; onClose: () => void }) {
  const { exercises } = useApp();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const filtered = exercises.filter(ex => `${ex.name} ${ex.muscle} ${ex.equipment}`.toLowerCase().includes(search.toLowerCase()));
  return <Modal title="Choose an exercise" onClose={onClose}><div className="search-box"><Search size={18} /><input aria-label="Search exercises" value={search} placeholder="Search name, muscle, equipment" onChange={e => setSearch(e.target.value)} /></div><div className="exercise-picker">{filtered.map(ex => <button key={ex.id} onClick={() => onChoose(ex)}><span className="exercise-icon"><Dumbbell size={18} /></span><div><strong>{ex.name}</strong><small>{ex.muscle} · {ex.equipment}</small></div><Plus size={18} /></button>)}</div>{filtered.length === 0 && <p className="field-hint">No matching exercises. Create your own below.</p>}<button className="button dashed" onClick={() => setCreating(true)}><Plus size={18} />Create custom exercise</button>{creating && <ExerciseForm initial={{ id: uid(), name: search, muscle: '', equipment: '', loadMode: 'external', custom: true }} onClose={() => setCreating(false)} onSaved={exercise => { setCreating(false); onChoose(exercise); }} />}</Modal>;
}

function ExerciseForm({ initial, onClose, onSaved }: { initial: Exercise; onClose: () => void; onSaved: (exercise: Exercise) => void }) {
  const { run } = useApp(); const [exercise, setExercise] = useState(initial);
  return <Modal title={initial.name ? 'Edit exercise' : 'Custom exercise'} onClose={onClose}><label>Name<input value={exercise.name} maxLength={100} onChange={e => setExercise({ ...exercise, name: e.target.value })} /></label><div className="form-grid"><label>Muscle group<input value={exercise.muscle} onChange={e => setExercise({ ...exercise, muscle: e.target.value })} /></label><label>Equipment<input value={exercise.equipment} onChange={e => setExercise({ ...exercise, equipment: e.target.value })} /></label></div><label>Load type<select value={exercise.loadMode} onChange={e => setExercise({ ...exercise, loadMode: e.target.value as Exercise['loadMode'] })}><option value="external">External weight</option><option value="bodyweight">Bodyweight (+ optional added weight)</option></select></label><p className="field-hint">For dumbbells, enter the combined external load consistently. Bodyweight volume counts only added weight.</p><button className="button primary" onClick={() => run(async () => { const valid = exerciseSchema.parse(exercise); await putLocalChange('exercises', valid, db.exercises); onSaved(valid); }, 'Exercise saved')}>Save exercise<Check size={18} /></button></Modal>;
}

function ExerciseLibrary({ onClose }: { onClose: () => void }) {
  const { exercises } = useApp(); const [editing, setEditing] = useState<Exercise | null>(null);
  return <Modal title="Your exercise library" onClose={onClose}><SectionTitle title={`${exercises.length} exercises`} /><div className="exercise-picker">{exercises.map(ex => <button key={ex.id} onClick={() => setEditing(ex)}><span className="exercise-icon"><Dumbbell size={18} /></span><div><strong>{ex.name}</strong><small>{ex.muscle} · {ex.custom ? 'Custom' : ex.equipment}</small></div><ChevronRight size={18} /></button>)}</div><button className="button dashed" onClick={() => setEditing({ id: uid(), name: '', muscle: '', equipment: '', loadMode: 'external', custom: true })}><Plus size={18} />Create exercise</button>{editing && <ExerciseForm initial={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}</Modal>;
}
