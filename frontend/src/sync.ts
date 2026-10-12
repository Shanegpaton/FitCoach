import type { SyncEntity } from './db';
import { db, enqueueChange, saveRecovery, syncRootId, syncStateId, type PendingChange, type TrainingDB } from './db';
import { catalog } from './catalog';
import { defaultProfile, type Exercise } from './domain';

const apiUrl = (import.meta.env.VITE_FITCOACH_API_URL as string | undefined)?.replace(/\/$/, '');
const priority: Record<SyncEntity, number> = {
  profile: 0, exercises: 1, plans: 2, 'schedule-overrides': 3, sessions: 4,
};

export interface SyncStatus {
  state: 'offline' | 'idle' | 'syncing' | 'error';
  pending: number;
  conflicts: number;
  lastSuccessAt: string | null;
  message: string;
}

export type TokenProvider = (forceRefresh?: boolean, expectedUserId?: string) => Promise<string | null>;
type Change = { resource: SyncEntity; id: string; sequence: number; version: number; etag: string; deleted: boolean; document: unknown | null };

function etagVersion(etag: string | null | undefined) {
  const version = Number(etag?.replaceAll('"', ''));
  return Number.isSafeInteger(version) && version > 0 ? version : 0;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function syncRoot(database: TrainingDB, resource: SyncEntity) {
  if (resource === 'profile') return database.profile;
  if (resource === 'exercises') return database.exercises;
  if (resource === 'plans') return database.plans;
  if (resource === 'sessions') return database.sessions;
  return database.overrides;
}

function isDefaultExercise(exercise: Exercise) {
  const original = catalog.find(item => item.id === exercise.id);
  return Boolean(original && stable(original) === stable(exercise));
}

async function authenticatedFetch(path: string, init: RequestInit, tokenProvider: TokenProvider, userId: string) {
  if (!apiUrl) throw new Error('Synchronization API is not configured. Local training remains available.');
  let token = await tokenProvider(false, userId);
  if (!token) throw new Error('Sign in online to synchronize. Your local changes are safe.');
  const send = (accessToken: string) => fetch(`${apiUrl}${path}`, {
    ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${accessToken}` },
  });
  let response = await send(token);
  if (response.status === 401) {
    token = await tokenProvider(true, userId);
    if (token) response = await send(token);
  }
  return response;
}

async function accountState(database: TrainingDB, userId: string) {
  const id = syncStateId(userId);
  let state = await database.sync.get(id);
  if (!state) {
    state = { id, userId, kind: 'state', cursor: 0, bootstrapComplete: false, updatedAt: new Date().toISOString() };
    await database.sync.put(state);
  }
  return state;
}

async function queueInitialAccountData(database: TrainingDB, userId: string) {
  const state = await accountState(database, userId);
  if (state.bootstrapComplete) return;
  await database.transaction('rw', [database.profile, database.exercises, database.plans,
    database.sessions, database.overrides, database.outbox, database.sync], async () => {
    const candidates: Array<{ entity: SyncEntity; id: string; payload: unknown }> = [];
    const profile = await database.profile.get('profile');
    if (profile && stable(profile) !== stable(defaultProfile)) candidates.push({ entity: 'profile', id: profile.id, payload: profile });
    for (const exercise of await database.exercises.toArray())
      if (exercise.custom || !isDefaultExercise(exercise)) candidates.push({ entity: 'exercises', id: exercise.id, payload: exercise });
    for (const plan of await database.plans.toArray()) candidates.push({ entity: 'plans', id: plan.id, payload: plan });
    for (const override of await database.overrides.toArray()) candidates.push({ entity: 'schedule-overrides', id: override.id, payload: override });
    for (const session of await database.sessions.toArray()) candidates.push({ entity: 'sessions', id: session.id, payload: session });
    for (const candidate of candidates) {
      const meta = await database.sync.get(syncRootId(userId, candidate.entity, candidate.id));
      const pending = await database.outbox.where('[userId+entity+entityId]')
        .equals([userId, candidate.entity, candidate.id]).count();
      if (!meta?.etag && pending === 0)
        await enqueueChange(candidate.entity, candidate.id, 'upsert', candidate.payload, database);
    }
    await database.sync.put({ ...((await database.sync.get(syncStateId(userId))) ?? state),
      bootstrapComplete: true, updatedAt: new Date().toISOString() });
  });
}

async function getNextMutations(database: TrainingDB, userId: string, limit = 50) {
  const changes = await database.outbox.where('userId').equals(userId).toArray();
  const blocked = new Set(changes.filter(item => item.status === 'conflict' || item.status === 'awaiting-remote')
    .map(item => `${item.entity}:${item.entityId}`));
  const earliest = changes.filter(item => item.status === 'pending' && !blocked.has(`${item.entity}:${item.entityId}`)).sort((a, b) =>
    priority[a.entity] - priority[b.entity] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const selected: PendingChange[] = [];
  const roots = new Set<string>();
  for (const item of earliest) {
    const root = `${item.entity}:${item.entityId}`;
    if (roots.has(root)) continue;
    roots.add(root); selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function upload(database: TrainingDB, userId: string, tokenProvider: TokenProvider) {
  const changes = await getNextMutations(database, userId);
  if (!changes.length) return { uploaded: 0, awaiting: 0 };
  // Freeze each request before the network call. A retry after a crash reuses its exact key and body.
  const prepared: PendingChange[] = [];
  await database.transaction('rw', [database.outbox, database.sync], async () => {
    for (const change of changes) {
      const current = await database.outbox.get(change.id);
      if (!current || current.status !== 'pending') continue;
      if (!current.sentAt) {
        const metadata = await database.sync.get(syncRootId(userId, current.entity, current.entityId));
        current.expectedEtag = metadata?.etag ?? null;
        current.sentAt = new Date().toISOString();
        await database.outbox.put(current);
      }
      prepared.push(current);
    }
  });
  if (!prepared.length) return { uploaded: 0, awaiting: 0 };
  const response = await authenticatedFetch('/v1/sync/mutations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutations: prepared.map(change => ({
      mutationId: change.id, resource: change.entity, id: change.entityId,
      operation: change.operation, expectedEtag: change.expectedEtag, payload: change.payload,
    })) }),
  }, tokenProvider, userId);
  if (!response.ok && response.status >= 500) throw new Error(`Training API unavailable (${response.status})`);
  if (!response.ok) throw new Error(`Sync upload failed (${response.status})`);
  const body = await response.json() as { results: Array<{ mutationId: string; status: number; resource: SyncEntity;
    id: string; etag: string | null; document: unknown | null; error: string | null }> };
  let uploaded = 0, awaiting = 0;
  for (const result of body.results) {
    const mutation = prepared.find(item => item.id === result.mutationId);
    if (!mutation) continue;
    if (result.status >= 200 && result.status < 300) {
      await database.transaction('rw', [database.outbox, database.sync], async () => {
        const rootId = syncRootId(userId, result.resource, result.id);
        const previous = await database.sync.get(rootId);
        // An idempotent retry can return its original receipt after another tab has
        // already recorded a newer ETag. Never move the local base version backward.
        const etag = (previous?.version ?? etagVersion(previous?.etag)) > etagVersion(result.etag)
          ? previous?.etag ?? null : result.etag;
        await database.sync.put({ id: syncRootId(userId, result.resource, result.id), userId, kind: 'root',
          entity: result.resource, entityId: result.id, etag, version: etagVersion(etag),
          remoteDeleted: mutation.operation === 'delete',
          updatedAt: new Date().toISOString() });
        await database.outbox.delete(mutation.id);
        const later = await database.outbox.where('[userId+entity+entityId]')
          .equals([userId, result.resource, result.id]).toArray();
        for (const queued of later) if (!queued.sentAt && queued.status === 'pending')
          await database.outbox.update(queued.id, { expectedEtag: etag });
      });
      uploaded++;
    } else if ([404, 409, 412, 428].includes(result.status)) {
      await database.outbox.update(mutation.id, { status: 'awaiting-remote' });
      awaiting++;
    } else {
      await database.outbox.update(mutation.id, { status: 'failed' as PendingChange['status'] });
      throw new Error(result.error || `Sync mutation rejected (${result.status})`);
    }
  }
  return { uploaded, awaiting };
}

async function applyChanges(database: TrainingDB, userId: string, changes: Change[], nextCursor: number) {
  await database.transaction('rw', [database.profile, database.exercises, database.plans,
    database.sessions, database.overrides, database.outbox, database.sync], async () => {
    for (const change of changes) {
      const rootTable = syncRoot(database, change.resource);
      const local = await rootTable.get(change.id as never) as unknown;
      const stateId = syncRootId(userId, change.resource, change.id);
      const known = await database.sync.get(stateId);
      // Duplicate work is possible in browsers without Web Locks. Feed pages may
      // then arrive out of order; ignore older server snapshots but still advance
      // the account cursor transactionally below.
      if (change.version > 0 && Math.max(known?.version ?? 0, etagVersion(known?.etag)) > change.version) continue;
      const pending = await database.outbox.where('[userId+entity+entityId]')
        .equals([userId, change.resource, change.id]).toArray();
      pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      let localSnapshot = local;
      if (!localSnapshot && pending.some(item => item.operation === 'delete')) {
        const priorCopies = (await database.sync.where('userId').equals(userId).toArray())
          .filter(item => item.kind === 'recovery' && item.entity === change.resource && item.entityId === change.id)
          .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
        localSnapshot = priorCopies[0]?.payload;
      }
      if (pending.length) {
        if (!change.deleted && localSnapshot && stable(localSnapshot) === stable(change.document)) {
          await database.outbox.bulkDelete(pending.map(item => item.id));
          await database.sync.put({ id: stateId, userId, kind: 'root', entity: change.resource,
            entityId: change.id, etag: change.etag, version: change.version, remoteDeleted: false, updatedAt: new Date().toISOString() });
          await database.sync.delete(`conflict:${userId}:${change.resource}:${change.id}`);
          continue;
        }
        if (!change.deleted && pending[0].sentAt && pending[0].operation === 'upsert' &&
            stable(pending[0].payload) === stable(change.document)) {
          await database.outbox.delete(pending[0].id);
          for (const queued of pending.slice(1)) if (!queued.sentAt && queued.status !== 'conflict')
            await database.outbox.update(queued.id, { expectedEtag: change.etag, status: 'pending' });
          await database.sync.put({ id: stateId, userId, kind: 'root', entity: change.resource,
            entityId: change.id, etag: change.etag, version: change.version, remoteDeleted: false, updatedAt: new Date().toISOString() });
          continue;
        }
        if (change.deleted && pending.length === 1 && pending[0].sentAt && pending[0].operation === 'delete') {
          await database.outbox.delete(pending[0].id);
          await database.sync.put({ id: stateId, userId, kind: 'root', entity: change.resource,
            entityId: change.id, etag: change.etag, version: change.version, remoteDeleted: true, updatedAt: new Date().toISOString() });
          continue;
        }
        if (!change.deleted && pending[0].status === 'pending' && !pending[0].sentAt &&
            pending[0].expectedEtag === change.etag) {
          // The remote version is the acknowledged base for a newer local edit.
          await database.sync.put({ id: stateId, userId, kind: 'root', entity: change.resource,
            entityId: change.id, etag: change.etag, version: change.version, remoteDeleted: false, updatedAt: new Date().toISOString() });
          continue;
        }
        const existingConflict = await database.sync.get(`conflict:${userId}:${change.resource}:${change.id}`);
        await database.sync.put({ id: `conflict:${userId}:${change.resource}:${change.id}`, userId,
          kind: 'conflict', entity: change.resource, entityId: change.id,
          payload: structuredClone(localSnapshot), remotePayload: change.deleted ? null : structuredClone(change.document),
          remoteDeleted: change.deleted, remoteEtag: change.etag, reason: change.deleted
            ? 'This record was deleted on another device.' : 'This record changed on another device.',
          createdAt: existingConflict?.createdAt ?? new Date().toISOString() });
        for (const item of pending) await database.outbox.update(item.id, { status: 'conflict' });
        await database.sync.put({ id: stateId, userId, kind: 'root', entity: change.resource,
          entityId: change.id, etag: change.etag, version: change.version,
          remoteDeleted: change.deleted, updatedAt: new Date().toISOString() });
        continue;
      }
      if (change.deleted) {
        if (local) {
          await saveRecovery(database, change.resource, change.id, local, 'deleted on another device');
          await rootTable.delete(change.id as never);
        }
      } else if (local && ((change.resource === 'exercises' && isDefaultExercise(local as Exercise)) ||
          (change.resource === 'profile' && stable(local) === stable(defaultProfile)))) {
        await rootTable.put(change.document as never);
      } else if (local && !await database.sync.get(stateId) && stable(local) !== stable(change.document)) {
        // Existing untracked account data is never overwritten during bootstrap.
        await database.sync.put({ id: `conflict:${userId}:${change.resource}:${change.id}`, userId,
          kind: 'conflict', entity: change.resource, entityId: change.id, payload: structuredClone(local),
          remotePayload: structuredClone(change.document), remoteDeleted: false, remoteEtag: change.etag,
          reason: 'Local and cloud copies differ.', createdAt: new Date().toISOString() });
        continue;
      } else {
        await rootTable.put(change.document as never);
      }
      await database.sync.put({ id: stateId, userId, kind: 'root', entity: change.resource,
        entityId: change.id, etag: change.etag, version: change.version,
        remoteDeleted: change.deleted, updatedAt: new Date().toISOString() });
    }
    const state = await accountState(database, userId);
    await database.sync.put({ ...state, cursor: Math.max(state.cursor ?? 0, nextCursor), updatedAt: new Date().toISOString() });
  });
}

async function download(database: TrainingDB, userId: string, tokenProvider: TokenProvider) {
  const state = await accountState(database, userId);
  const response = await authenticatedFetch(`/v1/sync/changes?cursor=${state.cursor ?? 0}&limit=100`, { method: 'GET' }, tokenProvider, userId);
  if (response.status === 409) {
    // A reset is safe: local records are retained and reconciled through explicit conflicts.
    await database.sync.put({ ...state, cursor: 0, bootstrapComplete: false, updatedAt: new Date().toISOString() });
    return { downloaded: 0, reset: true };
  }
  if (!response.ok) throw new Error(`Sync download failed (${response.status})`);
  const page = await response.json() as { items: Change[]; cursor: number; highWater: number; hasMore: boolean };
  await applyChanges(database, userId, page.items, page.cursor);
  return { downloaded: page.items.length, hasMore: page.hasMore, reset: false };
}

async function resolveAwaitingMutations(database: TrainingDB, userId: string, tokenProvider: TokenProvider) {
  const waiting = await database.outbox.where('userId').equals(userId).filter(item => item.status === 'awaiting-remote').toArray();
  const roots = new Set<string>();
  for (const item of waiting) {
    const key = `${item.entity}:${item.entityId}`;
    if (roots.has(key)) continue;
    roots.add(key);
    const response = await authenticatedFetch(`/v1/sync/records/${item.entity}/${encodeURIComponent(item.entityId)}`,
      { method: 'GET' }, tokenProvider, userId);
    if (!response.ok) throw new Error(`Could not check sync conflict (${response.status})`);
    const record = await response.json() as Change;
    const state = await accountState(database, userId);
    await applyChanges(database, userId, [record], state.cursor ?? 0);
  }
}

export async function resolveConflict(database: TrainingDB, conflictId: string, choice: 'keep-both' | 'use-cloud') {
  const conflict = await database.sync.get(conflictId);
  if (!conflict || conflict.kind !== 'conflict' || !conflict.entity || !conflict.entityId || !database.ownerId)
    throw new Error('Conflict is no longer available.');
  const userId = database.ownerId;
  const entity = conflict.entity as SyncEntity;
  const entityId = conflict.entityId;
  const table = syncRoot(database, entity);
  await database.transaction('rw', [database.profile, database.exercises, database.plans,
    database.sessions, database.overrides, database.outbox, database.sync], async () => {
    const local = (await table.get(entityId as never) ?? conflict.payload) as Record<string, unknown> | undefined;
    if (local) await saveRecovery(database, entity, entityId, local, 'before conflict resolution');
    const queued = await database.outbox.where('[userId+entity+entityId]')
      .equals([userId, entity, entityId]).toArray();
    await database.outbox.bulkDelete(queued.map(item => item.id));
    if (choice === 'use-cloud') {
      if (conflict.remoteDeleted) await table.delete(entityId as never);
      else if (conflict.remotePayload) await table.put(conflict.remotePayload as never);
      await database.sync.put({ id: syncRootId(userId, entity, entityId), userId, kind: 'root',
        entity, entityId, etag: conflict.remoteEtag ?? null, version: etagVersion(conflict.remoteEtag),
        remoteDeleted: Boolean(conflict.remoteDeleted), updatedAt: new Date().toISOString() });
    } else if (local) {
      if (entity === 'profile') {
        if (!conflict.remoteDeleted && conflict.remotePayload) await table.put(conflict.remotePayload as never);
        await enqueueChange(entity, entityId, 'upsert', local, database);
      } else {
        const copy = { ...local, id: crypto.randomUUID() };
        if (!conflict.remoteDeleted && conflict.remotePayload) await table.put(conflict.remotePayload as never);
        else await table.delete(entityId as never);
        await table.put(copy as never);
        await database.sync.delete(syncRootId(userId, entity, copy.id as string));
        await enqueueChange(entity, copy.id as string, 'upsert', copy, database);
        if (entity === 'plans') {
          const overrides = await database.overrides.where('planId').equals(entityId).toArray();
          for (const override of overrides) {
            const overrideCopy = { ...override, id: crypto.randomUUID(), planId: copy.id as string };
            await database.overrides.put(overrideCopy);
            await enqueueChange('schedule-overrides', overrideCopy.id, 'upsert', overrideCopy, database);
          }
        }
        await database.sync.put({ id: syncRootId(userId, entity, entityId), userId, kind: 'root',
          entity, entityId, etag: conflict.remoteEtag ?? null, version: etagVersion(conflict.remoteEtag),
          remoteDeleted: Boolean(conflict.remoteDeleted), updatedAt: new Date().toISOString() });
      }
    }
    await database.sync.delete(conflictId);
  });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('fitcoach:local-change'));
}

export function startSyncCoordinator(userId: string, tokenProvider: TokenProvider,
  onStatus: (status: SyncStatus) => void, database: TrainingDB = db) {
  let stopped = false;
  let running: Promise<void> | null = null;
  let failures = 0;
  let retryAt = 0;
  let lastSuccessAt: string | null = null;
  const status: SyncStatus = { state: navigator.onLine ? 'idle' : 'offline', pending: 0, conflicts: 0,
    lastSuccessAt, message: navigator.onLine ? '' : 'Offline; changes stay on this device.' };
  const publish = async (state = status.state, message = status.message) => {
    if (stopped) return;
    status.state = navigator.onLine ? state : 'offline'; status.message = navigator.onLine ? message : 'Offline; changes stay on this device.';
    const [pending, conflicts, saved] = await Promise.all([
      database.outbox.where('userId').equals(userId).count(),
      database.sync.where('userId').equals(userId).filter(item => item.kind === 'conflict').count(),
      database.sync.get(syncStateId(userId)),
    ]);
    status.pending = pending; status.conflicts = conflicts; status.lastSuccessAt = saved?.updatedAt ?? lastSuccessAt;
    onStatus({ ...status });
  };
  const run = async () => {
    if (stopped || !navigator.onLine || running || Date.now() < retryAt) return;
    running = (async () => {
      const execute = async () => {
        await publish('syncing', 'Checking for changes…');
        await queueInitialAccountData(database, userId);
        for (let batch = 0; batch < 20; batch++) {
          const pending = await database.outbox.where('userId').equals(userId).filter(item => item.status === 'pending').count();
          if (!pending) break;
          await publish('syncing', `Uploading up to ${Math.min(50, pending)} change${pending === 1 ? '' : 's'}…`);
          const result = await upload(database, userId, tokenProvider);
          if (!result.uploaded) break;
        }
        let pages = 0;
        let page;
        do {
          page = await download(database, userId, tokenProvider);
          if (page.downloaded) await publish('syncing', `Downloaded ${page.downloaded} change${page.downloaded === 1 ? '' : 's'}…`);
          if (page.reset) await queueInitialAccountData(database, userId);
          pages++;
        } while (page.hasMore && pages < 20);
        // One catch-up after paging closes the window for changes made during a long bootstrap.
        if (pages > 0 && page?.hasMore !== true) {
          await download(database, userId, tokenProvider);
        }
        await resolveAwaitingMutations(database, userId, tokenProvider);
        lastSuccessAt = new Date().toISOString(); failures = 0; retryAt = 0;
        const pending = await database.outbox.where('userId').equals(userId).count();
        await database.sync.update(syncStateId(userId), { updatedAt: lastSuccessAt });
        await publish(pending ? 'idle' : 'idle', pending ? `${pending} change${pending === 1 ? '' : 's'} waiting to sync.` : 'All changes are synchronized.');
      };
      if (navigator.locks) {
        await navigator.locks.request(`fitcoach-sync:${userId}`, { ifAvailable: true }, async lock => {
          if (lock) await execute();
        });
      } else {
        // Idempotency keys and transactional cursor commits make duplicate work safe on older browsers.
        await execute();
      }
    })().catch(async error => {
      failures++;
      retryAt = Date.now() + Math.min(300_000, 2_000 * 2 ** Math.min(failures, 7)) * (0.8 + Math.random() * 0.4);
      await publish('error', error instanceof Error ? error.message : 'Synchronization failed. Local changes are safe.');
    }).finally(() => { running = null; });
    await running;
  };
  const trigger = () => { void run(); };
  const offline = () => { void publish('offline', 'Offline; changes stay on this device.'); };
  const visible = () => { if (document.visibilityState === 'visible') trigger(); };
  window.addEventListener('online', trigger);
  window.addEventListener('offline', offline);
  window.addEventListener('pageshow', trigger);
  window.addEventListener('focus', trigger);
  window.addEventListener('fitcoach:sync-now', trigger);
  window.addEventListener('fitcoach:local-change', trigger);
  document.addEventListener('visibilitychange', visible);
  const timer = window.setInterval(() => { if (document.visibilityState === 'visible') trigger(); }, 45_000);
  void publish(); void run();
  return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('online', trigger);
    window.removeEventListener('offline', offline);
    window.removeEventListener('pageshow', trigger); window.removeEventListener('focus', trigger);
    window.removeEventListener('fitcoach:sync-now', trigger);
    window.removeEventListener('fitcoach:local-change', trigger); document.removeEventListener('visibilitychange', visible); };
}
