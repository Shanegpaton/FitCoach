import { getSyncAccessToken } from './auth';
import type { ChatAdapter } from './coach';
import { db, syncStateId } from './db';
import { errorMessage } from './errors';

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
  return backendRequest<T>(userId, `chatgpt/${path}`, init);
}

export class BackendError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function backendRequest<T>(userId: string, path: string, init: RequestInit = {}, onText?: (text: string) => void): Promise<T> {
  if (!apiUrl) throw new Error('The training API is not configured.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) abort();
  const timeout = setTimeout(abort, path === 'chatgpt/coach' ? 250_000 : path === 'coach/maintenance' ? 75_000 : 20_000);
  try {
    return await new Promise<T>((resolve, reject) => {
      const interrupted = () => reject(new Error('Request aborted'));
      controller.signal.addEventListener('abort', interrupted, { once: true });
      if (controller.signal.aborted) { interrupted(); return; }
      const request = async (): Promise<T> => {
        const send = async (refresh: boolean) => {
          const token = await getSyncAccessToken(refresh, userId);
          if (!token) throw new Error('Sign in online to connect ChatGPT.');
          return fetch(`${apiUrl}/v1/${path}`, {
            ...init, signal: controller.signal,
            headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }, cache: 'no-store',
          });
        };
        let response = await send(false);
        if (response.status === 401) response = await send(true);
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => ({}));
          throw new BackendError(errorMessage(body, `ChatGPT storage request failed (${response.status}).`), response.status);
        }
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          return await readCoachStream<T>(response, onText ?? (() => {}));
        }
        return response.status === 204 ? undefined as T : await response.json() as T;
      };
      void request().then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', interrupted));
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The connection timed out. Your pending Coach message is kept; check its status before retrying.');
    throw error;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

export async function readCoachStream<T>(response: Response, onText: (text: string) => void): Promise<T> {
  if (!response.body) throw new Error('Coach response stream is missing.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === 'reset') { text = ''; onText(text); }
        else if (event.type === 'delta' && typeof event.text === 'string') { text += event.text; onText(text); }
        else if (event.type === 'completed') return event.reply as T;
        else if (event.type === 'error') throw new BackendError(errorMessage(event, 'Coach could not finish this reply.'), event.status ?? 503);
      }
      if (done) throw new Error('Coach response was interrupted. Your pending message is kept; check its status before retrying.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function saveVmConnection(userId: string): Promise<ChatGPTConnection> {
  return backendChatGPTRequest<ChatGPTConnection>(userId, 'vm/save', { method: 'POST' });
}

export function liveCoach(userId: string, syncReady: boolean): ChatAdapter {
  return { async respond({ messages, conversationId, requestId }, onText) {
    if (!conversationId || !requestId) throw new Error('Choose a Coach conversation before sending a message.');
    const [state, pending, conflicts] = await Promise.all([
      db.sync.get(syncStateId(userId)), db.outbox.where('userId').equals(userId).count(),
      db.sync.where('userId').equals(userId).filter(item => item.kind === 'conflict').count(),
    ]);
    const trainingDataReady = syncReady && state?.bootstrapComplete === true && pending === 0 && conflicts === 0;
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const reply = await backendRequest<{ text: string; proposal?: import('./coach').ServerProposal | null; messageId: string; userMessageId?: string; replayed?: boolean }>(userId, 'chatgpt/coach', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ conversationId, requestId, message: { role: 'user', text: messages.at(-1)?.text.slice(0, 5000) },
        localDate, trainingDataReady }),
    }, onText);
    window.dispatchEvent(new CustomEvent('fitcoach:coach-maintenance', { detail: { conversationId } }));
    return { text: reply.text, serverProposal: reply.proposal ?? null, persistedMessageId: reply.messageId,
      persistedUserMessageId: reply.userMessageId, replayed: reply.replayed };
  } };
}
