import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { activateUserDatabase, cacheApprovedProposal, initialize, syncRootId, TrainingDB } from './db';
import { decidePlanProposal } from './planProposalDecision';
import type { backendRequest } from './chatgptVm';
import { starterPlan } from './catalog';
import { defaultProfile, uid, type Proposal } from './domain';

const draft = (): Proposal => ({ id: uid(), messageId: uid(), plan: starterPlan(defaultProfile),
  status: 'pending', baseRevision: null, serverProposalId: uid(), type: 'create', sourceEtag: null });

describe('account-scoped plan decisions', () => {
  it.each(['approve', 'reject', 'recovery'] as const)('keeps delayed %s writes in the originating account', async decision => {
    const accountA = activateUserDatabase(`approval-a-${uid()}`);
    let accountB: TrainingDB | undefined;
    try {
      await initialize(accountA);
      const proposal = draft();
      let started!: () => void, finish!: () => void;
      const requestStarted = new Promise<void>(resolve => { started = resolve; });
      const response = new Promise<void>(resolve => { finish = resolve; });
      const request: typeof backendRequest = async <T>(_userId: string, path: string) => {
        if (path.endsWith('/approve') || path.endsWith('/reject')) {
          started(); await response;
          if (decision === 'recovery') throw new Error('Lost response');
          return { plan: proposal.plan, etag: '"2"' } as T;
        }
        return { status: 'approved' } as T;
      };
      const outcome = decidePlanProposal(accountA, accountA.ownerId!, proposal, decision !== 'reject', true, request).catch(error => error);
      await requestStarted;
      accountB = activateUserDatabase(`approval-b-${uid()}`);
      await initialize(accountB);
      finish(); await outcome;
      expect((await accountA.proposals.get(proposal.id))?.status).toBe(decision === 'reject' ? 'rejected' : 'applied');
      expect(await accountB.proposals.count()).toBe(0);
      expect(await accountB.plans.count()).toBe(0);
    } finally { await accountA.delete(); if (accountB) await accountB.delete(); }
  });
  it('rejects a different account database before making a request', async () => {
    const database = new TrainingDB(`approval-${uid()}`, 'account-a');
    try { await expect(decidePlanProposal(database, 'account-b', draft(), true, true)).rejects.toThrow(/Sign in/); }
    finally { await database.delete(); }
  });
});

describe('approval response freshness', () => {
  it.each(['newer', 'deleted', 'different-source'] as const)('preserves a %s synchronized root', async situation => {
    const database = new TrainingDB(`approval-${uid()}`, 'account-a');
    try {
      await initialize(database);
      const proposal = draft();
      if (situation === 'different-source') proposal.sourceEtag = '"1"';
      const local = { ...proposal.plan, name: 'Keep synchronized plan' };
      if (situation !== 'deleted') await database.plans.put(local);
      const etag = situation === 'different-source' ? '"2"' : '"3"';
      await database.sync.put({ id: syncRootId('account-a', 'plans', local.id), userId: 'account-a', kind: 'root',
        entity: 'plans', entityId: local.id, etag, version: Number(etag.replaceAll('"', '')), remoteDeleted: situation === 'deleted' });
      await cacheApprovedProposal(proposal, proposal.plan, situation === 'different-source' ? '"4"' : '"2"', database);
      expect(await database.plans.get(local.id)).toEqual(situation === 'deleted' ? undefined : local);
      expect((await database.sync.get(syncRootId('account-a', 'plans', local.id)))?.etag).toBe(etag);
      expect((await database.proposals.get(proposal.id))?.status).toBe('applied');
      expect(await database.outbox.count()).toBe(0);
    } finally { await database.delete(); }
  });
});
