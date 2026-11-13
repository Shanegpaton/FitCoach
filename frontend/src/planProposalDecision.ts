import { backendRequest } from './chatgptVm';
import { cacheApprovedProposal, syncRootId, type TrainingDB } from './db';
import type { Plan, Proposal } from './domain';

type Request = typeof backendRequest;

/** Keep the originating account's database across every network await. */
export async function decidePlanProposal(database: TrainingDB, userId: string, proposal: Proposal,
  accept: boolean, ready: boolean, request: Request = backendRequest) {
  if (database.ownerId !== userId || !proposal.serverProposalId) throw new Error('Sign in to review this proposal.');
  if (accept) {
    if (!ready) throw new Error('Connect and finish syncing before approving a plan proposal.');
    const [pending, conflicts, root] = await Promise.all([
      database.outbox.where('userId').equals(userId).count(),
      database.sync.where('userId').equals(userId).filter(item => item.kind === 'conflict').count(),
      proposal.targetPlanId ? database.sync.get(syncRootId(userId, 'plans', proposal.targetPlanId)) : undefined,
    ]);
    if (pending || conflicts || (proposal.sourceEtag && root?.etag !== proposal.sourceEtag))
      throw new Error('Sync all training changes and resolve conflicts before approving. If the plan changed, ask Coach for a fresh proposal.');
  }
  try {
    if (accept) {
      const applied = await request<{ plan: Plan; etag: string }>(userId, `coach/proposals/${proposal.serverProposalId}/approve`, { method: 'POST' });
      await cacheApprovedProposal(proposal, applied.plan, applied.etag, database);
      return 'applied' as const;
    }
    await request(userId, `coach/proposals/${proposal.serverProposalId}/reject`, { method: 'POST' });
    await database.proposals.put({ ...proposal, status: 'rejected' });
    return 'rejected' as const;
  } catch (error) {
    const latest = await request<{ status: 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated' }>(userId,
      `coach/proposals/${proposal.serverProposalId}`).catch(() => undefined);
    if (latest && latest.status !== 'pending') await database.proposals.put({ ...proposal,
      status: latest.status === 'approved' ? 'applied' : latest.status });
    throw error;
  }
}
