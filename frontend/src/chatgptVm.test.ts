import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ getSyncAccessToken: vi.fn(async () => 'test-token') }));

async function requests() {
  vi.stubEnv('VITE_FITCOACH_API_URL', 'https://api.example.com');
  vi.resetModules();
  return import('./chatgptVm');
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('aborts a hanging generation request so the composer can recover its saved turn', async () => {
  const { backendRequest } = await requests();
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
    signal = init.signal;
    signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  })));
  const result = expect(backendRequest('user', 'chatgpt/coach', { method: 'POST' })).rejects.toThrow('pending Coach message is kept');
  await vi.advanceTimersByTimeAsync(250_000);
  await result;
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps HTTP status available to distinguish an unsent turn from an unavailable status check', async () => {
  const { backendRequest, BackendError } = await requests();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Turn not found' }), { status: 404 })));
  const error = await backendRequest('user', 'coach/conversations/id/turns/id').catch(error => error);
  expect(error).toBeInstanceOf(BackendError);
  if (!(error instanceof BackendError)) throw error;
  expect(error.status).toBe(404);
});

it('also times out if authentication never finishes', async () => {
  const { backendRequest } = await requests();
  const { getSyncAccessToken } = await import('./auth');
  vi.mocked(getSyncAccessToken).mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const result = expect(backendRequest('user', 'chatgpt/coach')).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(250_000);
  await result;
  expect(fetch).not.toHaveBeenCalled();
});
