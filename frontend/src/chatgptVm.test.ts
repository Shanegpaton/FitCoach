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

it('renders streamed text before completion, resets tool-turn text, and returns persisted reply metadata', async () => {
  const { readCoachStream } = await requests();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
  const updates: string[] = [];
  const result = readCoachStream<{ text: string; messageId: string }>(response, text => updates.push(text));
  const encoder = new TextEncoder();
  stream.enqueue(encoder.encode('data: {"type":"delta","text":"Looking up your plan"}\n\ndata: {"type":"reset"}\n\n'));
  await vi.waitFor(() => expect(updates).toEqual(['Looking up your plan', '']));
  const frame = encoder.encode('data: {"type":"delta","text":"Let’s train"}\n\n');
  const split = frame.indexOf(0xe2) + 1;
  stream.enqueue(frame.slice(0, split));
  stream.enqueue(frame.slice(split));
  await vi.waitFor(() => expect(updates.at(-1)).toBe('Let’s train'));
  stream.enqueue(encoder.encode('data: {"type":"completed","reply":{"text":"Let’s train today.","messageId":"saved"}}\n\n'));
  await expect(result).resolves.toEqual({ text: 'Let’s train today.', messageId: 'saved' });
});

it('rejects interrupted and failed streams rather than treating partial text as a saved reply', async () => {
  const { readCoachStream, BackendError } = await requests();
  await expect(readCoachStream(new Response('data: {"type":"delta","text":"Partial"}\n\n'), () => {})).rejects.toThrow('interrupted');
  await expect(readCoachStream(new Response('data: {"type":"error","status":429,"detail":"Usage limit"}\n\n'), () => {})).rejects.toEqual(new BackendError('Usage limit', 429));
});
