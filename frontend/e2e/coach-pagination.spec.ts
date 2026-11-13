import { test, expect } from '@playwright/test';
const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
test('live Coach loads earlier pages, retains them on refresh, and fences conversation switches', async ({ page, context }) => {
  await page.addInitScript(() => localStorage.setItem('sb-fitcoach-e2e-auth-token', JSON.stringify({
    access_token: 'offline-test-access-token', refresh_token: 'offline-test-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800,
    user: { id: 'e2e-user', aud: 'authenticated', role: 'authenticated', email: 'tester@example.com', app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' },
  })));
  const messages = Array.from({ length: 205 }, (_, index) => ({ id: `m-${index + 1}`, role: 'user', text: `Recorded message ${index + 1}`, sequence: index + 1, createdAt: new Date(1700000000000 + index * 1000).toISOString() }));
  let hold = false; let release!: () => void; let requested!: () => void;
  const requestedPage = new Promise<void>(resolve => { requested = resolve; });
  const delayedPage = new Promise<void>(resolve => { release = resolve; });
  await context.route('https://api.example.com/**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname.endsWith('/chatgpt/connection')) return route.fulfill({ headers, json: { connected: true, planUsageGranted: true, storedInBackend: true } });
    if (url.pathname.endsWith('/coach/conversations')) return route.fulfill({ headers, json: { items: [
      { id: 'long-chat', title: 'Long history', updatedAt: '2026-01-02T00:00:00Z' }, { id: 'other-chat', title: 'Other history', updatedAt: '2026-01-01T00:00:00Z' },
    ] } });
    if (url.pathname.endsWith('/conversations/other-chat')) return route.fulfill({ headers, json: { messages: [{ ...messages[0], id: 'other-message', text: 'Other conversation only' }], nextBefore: null } });
    if (url.pathname.endsWith('/conversations/long-chat')) {
      const before = Number(url.searchParams.get('before') ?? 206);
      if (hold && url.searchParams.has('before')) { requested(); await delayedPage; }
      const batch = messages.filter(message => message.sequence < before).slice(-100);
      return route.fulfill({ headers, json: { messages: batch, nextBefore: batch.length === 100 ? batch[0].sequence : null } });
    }
    return route.fulfill({ status: 503, headers, json: { detail: 'Test service unavailable' } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Skip for now' }).click(); await page.getByRole('link', { name: 'Coach', exact: true }).click();
  await expect(page.getByText('Recorded message 205', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Recorded message 1', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await expect(page.getByText('Recorded message 6', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await expect(page.getByText('Recorded message 1', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
  const refreshed = page.waitForResponse(response => response.url().endsWith('/conversations/long-chat?limit=100'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await refreshed;
  await expect(page.getByText('Recorded message 1', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Recorded message 205', { exact: true })).toHaveCount(1);
  await page.reload(); await expect(page.getByRole('button', { name: 'Load earlier messages' })).toBeVisible();
  hold = true; await page.getByRole('button', { name: 'Load earlier messages' }).click(); await requestedPage;
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: /Other history/ }).first().click();
  await expect(page.getByText('Other conversation only', { exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse(response => response.url().includes('/conversations/long-chat?limit=100&before='));
  release(); await oldResponse;
  await expect(page.getByText('Recorded message 6', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Other conversation only', { exact: true })).toHaveCount(1);
});
