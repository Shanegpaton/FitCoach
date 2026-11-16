import { beforeEach, expect, it, vi } from 'vitest';
import { diagnosticEvents, recordDiagnostic } from './diagnostics';

const values = new Map<string, string>();
beforeEach(() => { values.clear(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }); });
it('exports only allowlisted metadata even when storage contains private fields', () => {
  values.set('fitcoach:diagnostics:v1', JSON.stringify([{ code: 'api_error', at: '2026-01-01T00:00:00Z',
    status: 500, message: 'private workout', token: 'secret', requestId: 'unsafe\nlog' }]));
  expect(diagnosticEvents()).toEqual([{ code: 'api_error', at: '2026-01-01T00:00:00.000Z', status: 500 }]);
  for (let i = 0; i < 40; i++) recordDiagnostic('sync_error', { status: 503 });
  expect(diagnosticEvents()).toHaveLength(30);
  expect(JSON.stringify(diagnosticEvents())).not.toContain('private');
});
it('reporting never breaks a save when storage is unavailable', () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
  expect(() => recordDiagnostic('render_error')).not.toThrow();
});
