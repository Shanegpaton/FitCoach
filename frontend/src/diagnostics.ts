/** Metadata only: never persist exception messages, stacks, URLs, tokens or user text. */
export type DiagnosticCode = 'render_error' | 'unhandled_error' | 'unhandled_rejection' | 'api_error' | 'sync_error';
export interface DiagnosticEvent { code: DiagnosticCode; at: string; requestId?: string; status?: number }
const key = 'fitcoach:diagnostics:v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codes: DiagnosticCode[] = ['render_error', 'unhandled_error', 'unhandled_rejection', 'api_error', 'sync_error'];
let reporter: ((event: DiagnosticEvent) => Promise<void>) | undefined;
let sent = 0;
function sanitized(value: unknown): DiagnosticEvent | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (!codes.includes(input.code as DiagnosticCode) || typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at))) return null;
  return { code: input.code as DiagnosticCode, at: new Date(input.at).toISOString(),
    ...(typeof input.requestId === 'string' && uuid.test(input.requestId) ? { requestId: input.requestId } : {}),
    ...(typeof input.status === 'number' && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? { status: input.status } : {}) };
}
export function diagnosticEvents(): DiagnosticEvent[] {
  try { const data: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(data) ? data.map(sanitized).filter((item): item is DiagnosticEvent => item !== null).slice(-30) : [];
  } catch { return []; }
}
export function recordDiagnostic(code: DiagnosticCode, metadata: { requestId?: string | null; status?: number } = {}) {
  const event = sanitized({ code, at: new Date().toISOString(), ...metadata });
  if (!event) return;
  try { localStorage.setItem(key, JSON.stringify([...diagnosticEvents(), event].slice(-30))); } catch { /* Storage failure must not break logging. */ }
  // Bounded, best effort reporting. Never delay workout entry or recurse on failures.
  if (reporter && sent < 10) { sent++; void reporter(event).catch(() => {}); }
}
export function installDiagnostics(report?: (event: DiagnosticEvent) => Promise<void>) {
  reporter = report;
  const onError = () => recordDiagnostic('unhandled_error');
  const onRejection = () => recordDiagnostic('unhandled_rejection');
  window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onRejection);
  return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); reporter = undefined; };
}
export function exportDiagnostics() {
  const blob = new Blob([JSON.stringify({ version: 1, events: diagnosticEvents() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = 'fitcoach-diagnostics.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
