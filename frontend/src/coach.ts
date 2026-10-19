import { starterPlan } from './catalog';
import { uid } from './domain';
import type { Message, Plan, Profile, Session } from './domain';

export interface ChatRequest { messages: Message[]; profile: Profile; plan?: Plan; recentWorkouts: Session[] }
export interface ChatReply { text: string; proposal?: Plan; baseRevision?: number | null }
export interface ChatAdapter { respond(request: ChatRequest): Promise<ChatReply> }

export const sampleCoach: ChatAdapter = {
  async respond({ messages, profile, plan }) {
    const text = messages.at(-1)?.text.toLowerCase() ?? '';
    await new Promise(resolve => setTimeout(resolve, 450));
    if (/plan|routine|build|create|start/.test(text) && !/explain|why/.test(text)) {
      const proposed = starterPlan(profile);
      return { text: 'Here’s a sample full-body routine to explore. Review the exercises, training days, rep targets, and rest periods before applying it. Starting weights are intentionally left for you to choose. This is a template preview, not a personalized AI recommendation.',
        proposal: proposed, baseRevision: null };
    }
    if (/change|edit|adjust|rest|shorter|longer/.test(text) && plan) {
      const proposal = structuredClone(plan);
      const seconds = /longer|more/.test(text) ? 120 : 60;
      proposal.workouts.forEach(w => w.blocks.forEach(b => { b.restSeconds = seconds; }));
      return { text: `This sample edit changes rest periods to ${seconds} seconds. Everything remains a draft until you apply it. You can make other changes in the plan editor.`, proposal, baseRevision: plan.revision };
    }
    if (/why|explain|learn/.test(text)) return { text: plan
      ? `Your “${plan.name}” plan has ${plan.workouts.length} workouts. Each exercise lists the sets, rep targets, and rest time you chose. Previous results are shown during logging so you can decide what to do next. Use Plan to change targets; those edits won’t rewrite past workouts.`
      : 'A plan contains workouts, and each workout contains exercises with set and rep targets. You can schedule workouts on weekdays or rotate through them. Start with “Build a sample plan” to explore the workflow.' };
    return { text: 'This Coach is currently a UI demo with sample responses. Try building a sample plan, explaining your plan, or changing rest periods. Freeform AI conversation will be available when a live model is connected.' };
  },
};

export const assistantMessage = (text: string, source: 'sample' | 'chatgpt' = 'sample'): Message =>
  ({ id: uid(), role: 'assistant', text, createdAt: new Date().toISOString(), source });
