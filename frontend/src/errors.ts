/** Turn thrown values and API error payloads into readable, user-facing text. */
export function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Error && value.message.trim() && value.message !== '[object Object]') return value.message;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['detail', 'message', 'msg', 'error']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim() && candidate !== '[object Object]') return candidate.trim();
      if (Array.isArray(candidate)) {
        const messages = candidate.map(item => errorMessage(item, '')).filter(Boolean);
        if (messages.length) return messages.join(' ');
      }
      if (candidate && typeof candidate === 'object') {
        const message = errorMessage(candidate, '');
        if (message) return message;
      }
    }
  }
  return fallback;
}
