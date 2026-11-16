import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const user = '11111111-1111-4111-8111-111111111111';
const api = 'http://127.0.0.1:8001';
const headers = { Authorization: 'Bearer test-a' };
async function authenticate(context: BrowserContext, id = user, token = 'test-a') {
  // Only the external auth provider is stubbed; no training API requests are intercepted.
  await context.route('https://fitcoach-real.supabase.co/auth/v1/**', route => route.fulfill({ json: {
    access_token: token, refresh_token: 'unused', token_type: 'bearer', expires_in: 3600,
    user: { id, aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
  } }));
  await context.addInitScript(({ id, token }) => {
    localStorage.setItem('sb-fitcoach-real-auth-token', JSON.stringify({ access_token: token, refresh_token: 'unused',
      token_type: 'bearer', expires_in: 3600, expires_at: 4102444800,
      user: { id, aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.com',
        app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } }));
  }, { id, token });
}
async function synced(page: Page) {
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    return page.getByRole('link', { name: 'Synchronization: Synced', exact: true }).isVisible();
  }).toBe(true);
}

test('offline workout survives reload, syncs to another device, and competing edits require resolution', async ({ page, context, browser, request }) => {
  await authenticate(context); await page.goto('/');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('link', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'New plan', exact: true }).click();
  await page.getByLabel('Plan name', { exact: true }).fill('Real API routine');
  await page.getByLabel('Workout name', { exact: true }).fill('Real API squat day');
  await page.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('rotation');
  await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose an exercise' }).getByRole('button', { name: /Barbell squat/ }).click();
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await synced(page);
  // Wait for the production service worker to control the page before going offline.
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.getByRole('button', { name: 'Start workout', exact: true }).click();
  await context.setOffline(true);
  await page.getByRole('spinbutton', { name: 'Weight set 1 Barbell squat', exact: true }).fill('100');
  await page.getByRole('spinbutton', { name: 'Reps set 1 Barbell squat', exact: true }).fill('8');
  await page.getByRole('button', { name: 'Complete set 1 Barbell squat', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: 'Weight set 1 Barbell squat', exact: true })).toHaveValue('100');
  await page.getByRole('button', { name: 'Finish workout', exact: true }).click();
  await page.getByRole('button', { name: 'Save completed workout', exact: true }).click();
  await context.setOffline(false); await page.goto('/'); await synced(page);
  const sessions = await request.get(`${api}/v1/sessions`, { headers });
  expect(sessions.ok()).toBe(true);
  const stored = (await sessions.json()).items;
  expect(stored).toHaveLength(1);
  expect(stored[0].blocks[0].sets[0].reps).toBe(8);
  // Separate browser storage, same verified account: data must come from PostgreSQL.
  const second = await browser.newContext();
  try {
    await authenticate(second); const other = await second.newPage(); await other.goto('/');
    // A fresh local profile may display onboarding until the first download completes.
    await synced(other);
    await other.getByRole('link', { name: 'History', exact: true }).click();
    await expect(other.getByText('Real API squat day', { exact: true }).first()).toBeVisible();
    await other.getByRole('link', { name: 'Settings', exact: true }).click();
    await context.setOffline(true);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByLabel('What are you working toward?').fill('Device goal');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await other.getByLabel('What are you working toward?').fill('Cloud goal');
    await other.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(async () => {
      const response = await request.get(`${api}/v1/profile`, { headers });
      return response.ok() ? (await response.json()).goals : null;
    }).toBe('Cloud goal');
    await synced(other);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('fitcoach:sync-now')));
    await expect(page.getByRole('button', { name: 'Review versions' })).toBeVisible();
    await page.getByRole('button', { name: 'Review versions' }).click();
    const review = page.getByRole('dialog', { name: 'Resolve sync conflict' });
    await expect(review).toContainText('Device goal'); await expect(review).toContainText('Cloud goal');
    await review.getByRole('button', { name: 'Use cloud', exact: true }).click();
    await synced(page);
    await expect(page.getByLabel('What are you working toward?')).toHaveValue('Cloud goal');
    const after = await request.get(`${api}/v1/sessions`, { headers });
    expect((await after.json()).items).toHaveLength(1);
  } finally { await second.close(); }
  const outsider = await request.get(`${api}/v1/sessions/${stored[0].id}`, { headers: { Authorization: 'Bearer test-b' } });
  expect(outsider.status()).toBe(404);
});
