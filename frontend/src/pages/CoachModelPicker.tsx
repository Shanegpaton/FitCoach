import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useAuth } from '../auth';
import { backendChatGPTRequest } from '../chatgptVm';
import { ChevronDown } from 'lucide-react';
import { Modal } from '../ui';

const modelSettingsSchema = z.object({
  preferredModel: z.string().nullable(), defaultModel: z.string().nullable(), selectedModel: z.string().nullable(),
  available: z.boolean(), models: z.array(z.object({ id: z.string().min(1) })),
  catalogError: z.string().nullable(), etag: z.string().min(1),
});
type ModelSettings = z.infer<typeof modelSettingsSchema>;

const currentModel = (settings: ModelSettings | null) => settings?.preferredModel ?? settings?.selectedModel ?? settings?.defaultModel ?? '';

export function CoachModelPicker({ title, disabled }: { title: string; disabled: boolean }) {
  const { userId, offlineAccess } = useAuth();
  if (!userId || offlineAccess) return <h1 className="coach-toolbar-title">{title}</h1>;
  return <ModelChoice key={userId} userId={userId} title={title} disabled={disabled} />;
}

function ModelChoice({ userId, title, disabled }: { userId: string; title: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    void backendChatGPTRequest<unknown>(userId, 'models', { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      const parsed = modelSettingsSchema.safeParse(value);
      if (!parsed.success) throw new Error('Could not load Coach models. Refresh models to retry.');
      setSettings(parsed.data); setChoice(currentModel(parsed.data));
    }).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load models.');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [userId, revision]);

  const save = async () => {
    if (!settings || busy || disabled) return;
    setBusy(true); setError(''); setStatus('');
    try {
      await backendChatGPTRequest(userId, 'models', { method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': settings.etag },
        body: JSON.stringify({ preferredModel: choice || null }) });
      setStatus('Coach model saved.'); setRevision(value => value + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save model.'); setBusy(false);
    }
  };
  const effective = currentModel(settings);
  return <>
    <h1 className="sr-only">{title}</h1>
    <button className="coach-model-picker" aria-label={`Coach model: ${effective || (busy ? 'Checking models' : 'Choose a model')}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => { setChoice(currentModel(settings)); setStatus(''); setOpen(true); }}>
      <span className="coach-model-chat-title">{title}</span>
      <span className="coach-model-current"><span>{effective || (busy ? 'Checking models…' : 'Choose a model')}{settings && !settings.catalogError && !settings.available && effective ? ' · Unavailable' : ''}</span><ChevronDown size={14} aria-hidden="true" /></span>
    </button>
    {open && <Modal title="Coach model" onClose={() => setOpen(false)}><section id="coach-model" aria-busy={busy}>
    <p>Your choice applies to the next message and is saved across devices. Switching keeps your conversation. Coach never switches models automatically.</p>
    {settings && <>
      <p>Selected model: <strong>{effective || 'None selected'}</strong>{settings.preferredModel === null && settings.defaultModel ? ' (deployment default)' : ''}</p>
      {settings.selectedModel && <p>Verified available: {settings.selectedModel}</p>}
      {settings.catalogError ? <p role="alert">{settings.catalogError}</p>
        : !settings.available && <p role="alert">{effective ? 'Your selected model is unavailable. Choose an available model below to continue using Coach. Your saved choice has not changed.' : 'Choose an available model below before using live Coach.'}</p>}
      <label>Preferred Coach model<select value={choice} disabled={disabled || busy || !settings.models.length} onChange={event => { setChoice(event.target.value); setStatus(''); }}>
        {settings.defaultModel ? <option value="">Deployment default ({settings.defaultModel})</option> : !effective && <option value="" disabled>Choose a model</option>}
        {effective && !settings.models.some(item => item.id === effective) && <option value={effective} disabled>{effective} (unavailable)</option>}
        {settings.models.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
      </select></label>
      {!settings.catalogError && !settings.models.length && <p>No models are available for this ChatGPT account. Check your ChatGPT connection and plan access.</p>}
    </>}
    <div className="coach-model-actions">
      {settings && <button className="button primary" disabled={disabled || busy || !settings.models.some(item => item.id === (choice || settings.defaultModel)) || choice === currentModel(settings)} onClick={() => void save()}>Save Coach model</button>}
    <button className="text-button" disabled={disabled || busy} onClick={() => { setStatus(''); setRevision(value => value + 1); }}>{busy ? 'Checking models…' : 'Refresh models'}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
  </section></Modal>}
  </>;
}
