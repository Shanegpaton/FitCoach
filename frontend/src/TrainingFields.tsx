import { Check } from 'lucide-react';
import type { Profile } from './domain';
import { Days } from './ui';

export function TrainingFields({ value, onChange }: { value: Profile; onChange: (profile: Profile) => void }) {
  return <><p className="field-hint">Your usual goals and preferences. Each plan has its own schedule, and each workout can have its own duration.</p>
    <label>What are you working toward?<textarea value={value.goals} maxLength={2000} rows={3} placeholder="Main goal, secondary goals, and any muscles you want to prioritize…" onChange={e => onChange({ ...value, goals: e.target.value })} /></label>
    <label>Training experience<select value={value.experience} onChange={e => onChange({ ...value, experience: e.target.value })}><option>Beginner</option><option>Intermediate</option><option>Experienced</option><option>Prefer not to say</option></select></label>
    <label>Training background (optional)<textarea value={value.trainingBackground ?? ''} maxLength={2000} rows={2} placeholder="How long and consistently have you trained? Returning after a break?" onChange={e => onChange({ ...value, trainingBackground: e.target.value })} /></label>
    <fieldset><legend>Usual equipment</legend><div className="chip-row">{['Full gym', 'Dumbbells', 'Bodyweight'].map(item => <button type="button" className={`chip ${value.equipment.includes(item) ? 'selected' : ''}`} key={item} aria-pressed={value.equipment.includes(item)} onClick={() => onChange({ ...value, equipment: value.equipment.includes(item) ? value.equipment.filter(e => e !== item) : [...value.equipment, item] })}>{value.equipment.includes(item) && <Check aria-hidden="true" size={13} />}{item}</button>)}</div></fieldset>
    <label>Usual training days per week (optional)<select value={value.daysPerWeek ?? ''} onChange={e => onChange({ ...value, daysPerWeek: e.target.value ? Number(e.target.value) : null })}><option value="">Flexible / not set</option>{[1, 2, 3, 4, 5, 6, 7].map(days => <option key={days} value={days}>{days} {days === 1 ? 'day' : 'days'}</option>)}</select></label>
    <fieldset><legend>Preferred days (optional)</legend><p className="field-hint">General availability for planning. Change your actual schedule in Plan.</p><Days value={value.trainingDays} onChange={trainingDays => onChange({ ...value, trainingDays })} /></fieldset>
    <details className="profile-preferences"><summary>Exercise preferences & limitations (optional)</summary>
      <label>Exercise preferences<textarea value={value.exercisePreferences ?? ''} maxLength={2000} rows={2} placeholder="Movements you enjoy or prefer to avoid…" onChange={e => onChange({ ...value, exercisePreferences: e.target.value })} /></label>
      <label>Limitations or alternatives needed<textarea value={value.limitations ?? ''} maxLength={2000} rows={2} placeholder="Anything you want taken into account when choosing exercises…" onChange={e => onChange({ ...value, limitations: e.target.value })} /></label>
    </details>
    <label>Weight unit<select value={value.unit} onChange={e => onChange({ ...value, unit: e.target.value as Profile['unit'] })}><option value="lb">Pounds (lb)</option><option value="kg">Kilograms (kg)</option></select></label></>;
}
