import { useEffect, useState } from 'react';
import { profileSchema, type Profile } from './domain';

const canonical = (value: Profile) => JSON.stringify(profileSchema.parse(value));

type Draft = { base: Profile; value: Profile };
// Only unsaved form drafts live here. Training data still uses Dexie/outbox.
const memory = new Map<string, Draft>();
export function useProfileDraft(accountDatabase: string, profile: Profile) {
  const key = `fitcoach:${accountDatabase}:profile-draft`;
  const [edit, setEdit] = useState<Draft>(() => {
    try {
      const text = sessionStorage.getItem(key);
      if (text) {
        const raw = JSON.parse(text);
        return { base: profileSchema.parse(raw.base), value: profileSchema.parse(raw.value) };
      }
    } catch { /* Keep any unreadable stored draft; never delete it on load. */ }
    return memory.get(key) ?? { base: profile, value: profile };
  });
  const [durable, setDurable] = useState(true);
  const dirty = canonical(edit.value) !== canonical(edit.base);
  const changedElsewhere = dirty && canonical(profile) !== canonical(edit.base);
  const store = (next: Draft) => {
    memory.set(key, next);
    try { sessionStorage.setItem(key, JSON.stringify(next)); setDurable(true); }
    catch { setDurable(false); }
    setEdit(next);
  };
  const reset = (saved: Profile) => {
    memory.delete(key);
    try { sessionStorage.removeItem(key); } catch { /* In-memory reset still works. */ }
    setEdit({ base: saved, value: saved });
  };
  useEffect(() => {
    if (!dirty && canonical(edit.base) !== canonical(profile)) setEdit({ base: profile, value: profile });
  }, [profile, dirty, edit.base]);
  useEffect(() => {
    if (!dirty) return;
    memory.set(key, edit);
    try { sessionStorage.setItem(key, JSON.stringify(edit)); setDurable(true); }
    catch { setDurable(false); }
  }, [key, edit, dirty]);
  useEffect(() => {
    if (!dirty || durable) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, durable]);
  return { draft: edit.value, base: edit.base, dirty, durable, changedElsewhere,
    setDraft: (value: Profile) => store({ ...edit, value }), reset,
    keepDraft: () => store({ base: profile, value: edit.value }) };
}
