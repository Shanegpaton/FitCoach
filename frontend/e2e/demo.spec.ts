import { test, expect } from '@playwright/test';

test('demo stays local, survives reload, and resetting leaves account data intact', async ({ page, context }) => {
  const requests: string[] = [];
  context.on('request', request => { if (/api\.example\.com|supabase\.co/.test(request.url())) requests.push(request.url()); });
  await page.addInitScript(() => {
    // Sentinel in an account database; demo must never open or clear it.
    const request = indexedDB.open('fitcoach-user-sentinel');
    request.onupgradeneeded = () => request.result.createObjectStore('sentinel');
    request.onsuccess = () => { const db = request.result; const tx = db.transaction('sentinel', 'readwrite'); tx.objectStore('sentinel').put('keep', 'value'); tx.oncomplete = () => db.close(); };
  });
  await page.goto('/?demo=1');
  await expect(page.getByText(/Demo · synthetic data/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start workout', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View all 24 sessions' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'View all 24 sessions' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('What are you working toward?').fill('Changed demo goal');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.reload(); await expect(page.getByLabel('What are you working toward?')).toHaveValue('Changed demo goal');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await expect(page.getByText(/Demo · synthetic data/)).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('Build strength consistently');
  const sentinel = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('fitcoach-user-sentinel'); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result; const tx = db.transaction('sentinel'); const read = tx.objectStore('sentinel').get('value'); read.onsuccess = () => resolve(read.result); tx.oncomplete = () => db.close(); };
  }));
  expect(sentinel).toBe('keep'); expect(requests).toEqual([]);
});
