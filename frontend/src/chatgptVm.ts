import { getSyncAccessToken } from './auth';

export const chatgptVmUrl = (import.meta.env.VITE_CHATGPT_VM_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export interface ChatGPTConnection {
  paired: boolean;
  connected: boolean;
  email: string | null;
  name: string | null;
  planUsageGranted: boolean | null;
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
