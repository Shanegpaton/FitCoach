import { getSyncAccessToken } from './auth';
import type { ChatAdapter } from './coach';
import { db, syncStateId } from './db';

export const chatgptVmUrl = (import.meta.env.VITE_CHATGPT_VM_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const apiUrl = (import.meta.env.VITE_FITCOACH_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export interface ChatGPTConnection {
  paired: boolean;
  busy?: boolean;
  connected: boolean;
  email: string | null;
  name: string | null;
  planUsageGranted: boolean | null;
  storedInBackend?: boolean;
  vmCleanupPending?: boolean;
}

export interface ChatGPTAttempt {
  id: string;
  state: 'pending' | 'connected' | 'declined' | 'failed' | 'expired';
  viewerToken?: string;
  connection?: ChatGPTConnection;
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
  return backendChatGPTRequest<ChatGPTConnection>(userId, 'vm/save', { method: 'POST' });
}

export function liveCoach(userId: string, syncReady: boolean): ChatAdapter {
  return { async respond({ messages }) {
    const [state, pending, conflicts] = await Promise.all([
      db.sync.get(syncStateId(userId)), db.outbox.where('userId').equals(userId).count(),
      db.sync.where('userId').equals(userId).filter(item => item.kind === 'conflict').count(),
    ]);
    const trainingDataReady = syncReady && state?.bootstrapComplete === true && pending === 0 && conflicts === 0;
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const reply = await backendChatGPTRequest<{ text: string }>(userId, 'coach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.slice(-16).map(message => ({ role: message.role, text: message.text.slice(0, 5000) })),
        localDate, trainingDataReady }),
    });
    return { text: reply.text };
  } };
}
