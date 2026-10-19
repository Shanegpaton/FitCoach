import { useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, ArrowRight, Check, Download, HardDrive, RefreshCw, ShieldCheck, Smartphone, Upload } from 'lucide-react';
import { Link } from 'react-router';
import { backupSchema, type Backup, type Profile } from '../domain';
import { db, exportBackup, importBackup, putLocalChange } from '../db';
import { useApp } from '../state';
import { Days, Modal, SectionTitle } from '../ui';
import { ConflictReview } from './ConflictReview';
import { ChatGPTConnection } from './ChatGPTConnection';

function TrainingFields({ value, onChange }: { value: Profile; onChange: (profile: Profile) => void }) {
  return <><label>What are you working toward?<textarea value={value.goals} maxLength={2000} rows={3} placeholder="Build muscle, get stronger, feel more consistent…" onChange={e => onChange({ ...value, goals: e.target.value })} /></label>
    <div className="form-grid"><label>Training experience<select value={value.experience} onChange={e => onChange({ ...value, experience: e.target.value })}><option>Beginner</option><option>Intermediate</option><option>Experienced</option><option>Prefer not to say</option></select></label><label>Session length<select value={value.sessionMinutes} onChange={e => onChange({ ...value, sessionMinutes: Number(e.target.value) })}>{[20, 30, 45, 60, 90].map(minutes => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select></label></div>
    <fieldset><legend>Available equipment</legend><div className="chip-row">{['Full gym', 'Dumbbells', 'Bodyweight'].map(item => <button type="button" className={`chip ${value.equipment.includes(item) ? 'selected' : ''}`} key={item} aria-pressed={value.equipment.includes(item)} onClick={() => onChange({ ...value, equipment: value.equipment.includes(item) ? value.equipment.filter(e => e !== item) : [...value.equipment, item] })}>{value.equipment.includes(item) && <Check size={13} />}{item}</button>)}</div></fieldset>
    <fieldset><legend>Days that usually work for you</legend><Days value={value.trainingDays} onChange={trainingDays => onChange({ ...value, trainingDays })} /></fieldset>
    <label>Weight unit<select value={value.unit} onChange={e => onChange({ ...value, unit: e.target.value as Profile['unit'] })}><option value="lb">Pounds (lb)</option><option value="kg">Kilograms (kg)</option></select></label></>;
}

export function Onboarding() {
  const { profile, run } = useApp(); const [step, setStep] = useState(0); const [draft, setDraft] = useState(profile);
  const save = () => run(() => putLocalChange('profile', { ...draft, onboardingDone: true }, db.profile));
  return <Modal title="Welcome to your training space" onClose={() => run(() => putLocalChange('profile', { ...profile, onboardingDone: true }, db.profile)).then(() => undefined)}><div className="onboarding-progress"><span className={step === 0 ? 'selected' : ''} /><span className={step === 1 ? 'selected' : ''} /></div>
    {step === 0 ? <div className="onboarding-intro"><span className="brand-mark large">f.</span><h2>A plan that fits.<br /><span className="text-accent">Progress that lasts.</span></h2><p>Make a little space for your goals. We’ll keep your workouts and history right here, on your device.</p><button className="button primary" onClick={() => setStep(1)}>Set up my profile<ArrowRight size={18} /></button></div> : <form onSubmit={e => { e.preventDefault(); void save(); }}><TrainingFields value={draft} onChange={setDraft} /><button className="button primary" type="submit">Let’s get started<ArrowRight size={18} /></button></form>}
    <button className="text-button onboarding-skip" onClick={() => run(() => putLocalChange('profile', { ...profile, onboardingDone: true }, db.profile))}>Skip for now</button><p className="field-hint centered">You can change these details anytime in Settings.</p>
  </Modal>;
}

export function Settings() {
  const { profile, run, notify, sessions } = useApp();
  const [draft, setDraft] = useState(profile);
  const [backup, setBackup] = useState<Backup | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const syncItems = useLiveQuery(async () => db.ownerId ? Promise.all([
    db.outbox.where('userId').equals(db.ownerId).toArray(),
    db.sync.where('userId').equals(db.ownerId).toArray(),
  ]) : [[], []], [db.name]);
  const pendingSync = syncItems?.[0] ?? [];
  const syncRecords = syncItems?.[1] ?? [];
  const conflicts = syncRecords.filter(item => item.kind === 'conflict');
  const failed = pendingSync.filter(item => item.status === 'failed');
  const reviewed = conflicts.find(item => item.id === reviewId);
  const resolutions = syncRecords.filter(item => item.kind === 'root' && item.resolvedAt)
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '')).slice(0, 5);
  const recoveries = syncRecords.filter(item => item.kind === 'recovery');
  const syncState = syncRecords.find(item => item.kind === 'state');
  const save = (e: FormEvent) => { e.preventDefault(); void run(() => putLocalChange('profile', { ...draft, onboardingDone: true }, db.profile), 'Profile saved'); };
  const exportFile = async () => {
    await run(async () => {
      const backup = await exportBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `fitcoach-backup-${backup.exportedAt.slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'Backup exported');
  };
  return <div className="page settings-page"><Link to="/" className="text-button"><ArrowLeft size={17} />Back to Today</Link><div className="page-heading compact-heading"><span className="eyebrow">MAKE IT YOURS</span><h1>Your space.</h1><p>A few details. A better starting point.</p></div>
    <form className="settings-card" onSubmit={save}><SectionTitle title="Training profile" /><TrainingFields value={draft} onChange={setDraft} /><button className="button primary" type="submit">Save profile<Check size={18} /></button></form>
    <section className="settings-card"><SectionTitle title="Synchronization"><HardDrive size={20} /></SectionTitle><div className="privacy-note"><ShieldCheck size={20} /><p>Every change saves on this device first. When you’re online and signed in, your plans and workouts sync to your account. Export a backup before changing phones or clearing browser data.</p></div>
      <p role="status">{failed.length ? `${failed.length} change${failed.length === 1 ? '' : 's'} failed to upload.` : conflicts.length ? `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} need your choice.` : pendingSync.length ? `${pendingSync.length} change${pendingSync.length === 1 ? '' : 's'} pending upload.` : 'All changes are synchronized.'}</p>
      <p className="field-hint">{syncState?.updatedAt ? `Last sync activity: ${new Date(syncState.updatedAt).toLocaleString()}` : 'This account has not synchronized on this device yet.'}</p>
      <button className="button secondary" onClick={() => window.dispatchEvent(new Event('fitcoach:sync-now'))}><RefreshCw size={16} />Sync now</button>
      {failed.length > 0 && <div className="sync-conflicts"><SectionTitle title="Failed uploads" />{failed.map(item => <article className="sync-conflict" key={item.id}><strong>{item.entity} · {item.entityId}</strong><p>{item.error ?? 'The server rejected this change.'}</p><button className="button secondary" onClick={() => run(async () => { await db.outbox.update(item.id, { status: 'pending', error: undefined }); window.dispatchEvent(new Event('fitcoach:sync-now')); }, 'Upload queued to retry')}>Retry upload</button></article>)}</div>}
      {conflicts.length > 0 && <div className="sync-conflicts"><SectionTitle title="Choose how to resolve" /><p className="field-hint">Both versions remain available until you choose. Review the changes before replacing either copy.</p>{conflicts.map(conflict => <article className="sync-conflict" key={conflict.id}><strong>{conflict.entity} · {conflict.entityId}</strong><p>{conflict.reason}</p><button className="button secondary" onClick={() => setReviewId(conflict.id)}>Review versions</button></article>)}</div>}
      {resolutions.length > 0 && <div className="sync-resolutions"><SectionTitle title="Recent resolutions" />{resolutions.map(item => {
        const queued = pendingSync.find(change => change.entity === item.entity && change.entityId === item.entityId);
        const conflicted = conflicts.some(conflict => conflict.entity === item.entity && conflict.entityId === item.entityId);
        return <p key={item.id}>{item.entity} · {item.entityId}: {conflicted ? 'New conflict needs review' : queued?.status === 'failed' ? 'Upload failed' : queued ? 'Pending upload' : 'Synchronized'}</p>;
      })}</div>}
      {recoveries.length > 0 && <details className="recovery-list"><summary>{recoveries.length} recovery cop{recoveries.length === 1 ? 'y' : 'ies'} saved</summary>{recoveries.map(item => <div className="recovery-row" key={item.id}><span>{item.entity} · {item.entityId} · {item.reason}</span><button className="text-button" onClick={() => {
        const blob = new Blob([JSON.stringify({ entity: item.entity, entityId: item.entityId, reason: item.reason, payload: item.payload }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `fitcoach-recovery-${item.entityId}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>Download copy</button></div>)}</details>}
      <div className="action-row"><button className="button secondary" onClick={exportFile}><Download size={17} />Export backup</button><label className="button secondary file-button"><Upload size={17} />Import backup<input type="file" accept="application/json,.json" aria-label="Import backup" onChange={async e => {
      const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
      await run(async () => {
        if (file.size > 20 * 1024 * 1024) throw new Error('Backup is too large. Choose a file under 20 MB.');
        const result = backupSchema.safeParse(JSON.parse(await file.text()));
        if (!result.success) throw new Error(`Invalid backup: ${result.error.issues[0]?.message ?? 'Unsupported format'}`);
        setBackup(result.data);
      });
    }} /></label></div><button className="text-button" onClick={() => run(async () => {
      const persistent = await navigator.storage?.persist?.(); notify(persistent ? 'Persistent storage enabled.' : 'Your browser manages storage. Keep regular exported backups.');
    })}>Request persistent storage</button></section>
    <ChatGPTConnection />
    <section className="settings-card"><SectionTitle title="Take it to the gym"><Smartphone size={20} /></SectionTitle><p>Install FitCoach on your home screen after opening it once online. Your plans, logs, timers, and history work offline.</p><div className="install-steps"><div><span>01</span><p><strong>iPhone / iPad</strong>Open in Safari, tap Share, then Add to Home Screen.</p></div><div><span>02</span><p><strong>Android</strong>Open in Chrome, then choose Install app or Add to Home screen in the browser menu.</p></div></div><p className="field-hint">Installation requires HTTPS on phones. ChatGPT Coach requires an online connection and granted plan usage.</p></section>
    <p className="settings-footnote">FITCOACH · YOUR TRAINING, IN MOTION</p>
    {backup && <Modal title="Replace local data?" onClose={() => setBackup(null)}><p>This backup contains {backup.plans.length} plans and {backup.sessions.length} sessions. Importing replaces the data currently stored on this device, including {sessions.length} sessions.</p><p className="field-hint">Export your current data first if you want to keep it.</p><div className="action-row"><button className="button secondary" onClick={exportFile}>Export current data</button><button className="button primary" disabled={busy} onClick={async () => {
      setBusy(true); if (await run(() => importBackup(backup), 'Backup imported')) { setDraft(backup.profile); setBackup(null); } setBusy(false);
    }}>{busy ? 'Importing…' : 'Replace & import'}</button></div></Modal>}
    {reviewed && <ConflictReview key={reviewed.id} conflict={reviewed} onClose={() => setReviewId(null)} onResolved={message => {
      if (reviewed.entity === 'profile') void db.profile.get('profile').then(current => { if (current) setDraft(current); });
      setReviewId(null); notify(message);
    }} />}
  </div>;
}
