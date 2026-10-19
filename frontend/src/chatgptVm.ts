import { getSyncAccessToken } from './auth';
import type { ChatAdapter } from './coach';

export const chatgptVmUrl = (import.meta.env.VITE_CHATGPT_VM_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const apiUrl = (import.meta.env.VITE_FITCOACH_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export interface ChatGPTConnection {
  paired: boolean;
  connected: boolean;
  email: string | null;
  name: string | null;
  planUsageGranted: boolean | null;
  storedInBackend?: boolean;
}

export interface ChatGPTAttempt {
  id: string;
  state: 'pending' | 'connected' | 'declined' | 'failed' | 'expired';
  launchUrl?: string;
  viewerToken?: string;
  connection?: ChatGPTConnection;
}

export async function vmRequest<T>(userId: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!chatgptVmUrl) throw new Error('The ChatGPT VM is not configured.');
  const send = async (refresh: boolean) => {
    const token = await getSyncAccessToken(refresh, userId);
    if (!token) throw new Error('Sign in online to connect ChatGPT.');
    return fetch(`${chatgptVmUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  };
  let response = await send(false);
  if (response.status === 401) response = await send(true);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `VM request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function backendChatGPTRequest<T>(userId: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!apiUrl) throw new Error('The training API is not configured.');
  const send = async (refresh: boolean) => {
    const token = await getSyncAccessToken(refresh, userId);
    if (!token) throw new Error('Sign in online to connect ChatGPT.');
    return fetch(`${apiUrl}/v1/chatgpt/${path}`, {
      ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
  };
  let response = await send(false);
  if (response.status === 401) response = await send(true);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `ChatGPT storage request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function saveVmConnection(userId: string): Promise<ChatGPTConnection> {
  const { code } = await vmRequest<{ code: string }>(userId, '/v1/handoff', { method: 'POST' });
  return backendChatGPTRequest<ChatGPTConnection>(userId, 'handoff', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
}

export function liveCoach(userId: string): ChatAdapter {
  return { async respond({ messages, profile, plan, recentWorkouts }) {
    const context = JSON.stringify({ goals: profile.goals, experience: profile.experience,
      equipment: profile.equipment, trainingDays: profile.trainingDays, unit: profile.unit,
      plan: plan ? { name: plan.name, workouts: plan.workouts.map(workout => ({
        name: workout.name, blocks: workout.blocks.map(block => ({ exerciseId: block.exerciseId,
          sets: block.sets.map(set => ({ reps: set.targetReps, kg: set.targetKg })), restSeconds: block.restSeconds })) })) } : null,
      recentWorkouts: recentWorkouts.map(session => ({ name: session.name, date: session.date,
        exercises: session.blocks.map(block => ({ name: block.name,
          completedSets: block.sets.filter(set => set.done).map(set => ({ reps: set.reps, kg: set.kg })) })) })) });
    const reply = await backendChatGPTRequest<{ text: string }>(userId, 'coach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.slice(-16).map(message => ({ role: message.role, text: message.text.slice(0, 5000) })),
        context: context.slice(0, 4000) }),
    });
    return { text: reply.text };
  } };
}
