import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { starterPlan } from '../src/catalog';
import { defaultProfile, type Proposal } from '../src/domain';

test('live proposal caches do not block backup export, replacement, or recovery', async ({ page, context }, info) => {
  await context.route('https://api.example.com/**', route => route.fulfill({ status: 503,
    headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173' }, json: { detail: 'Offline test' } }));
  await page.addInitScript(() => {
    localStorage.setItem('sb-fitcoach-e2e-auth-token', JSON.stringify({
      access_token: 'offline-test-access-token', refresh_token: 'offline-test-refresh-token', token_type: 'bearer',
      expires_in: 3600, expires_at: 4102444800,
      user: { id: 'e2e-user', aud: 'authenticated', role: 'authenticated', email: 'tester@example.com',
        app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' },
    }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  const plan = starterPlan(defaultProfile);
  plan.workouts[0].blocks[0].exerciseId = 'deleted-server-exercise';
  const proposal: Proposal = { id: 'live-cache', serverProposalId: 'server-proposal', messageId: 'server-message',
    plan, status: 'rejected', baseRevision: null };
  await page.evaluate(value => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('fitcoach-user-e2e-user');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('proposals', 'readwrite');
      transaction.objectStore('proposals').put(value);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }), proposal);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  const file = await download;
  const backupPath = info.outputPath('live-proposal-backup.json');
  await file.saveAs(backupPath);
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(backup.messages).toEqual([]);
  expect(backup.proposals).toEqual([proposal]);
  await page.getByLabel('Import backup', { exact: true }).setInputFiles({ name: 'replacement.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...backup, proposals: [] })) });
  await page.getByRole('button', { name: 'Replace & import', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByText(/recovery cop.* saved/).click();
  const recoveryDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download copy', exact: true }).click();
  const recoveryFile = await recoveryDownload;
  const recoveryPath = info.outputPath('recovery.json');
  await recoveryFile.saveAs(recoveryPath);
  expect(JSON.parse(await readFile(recoveryPath, 'utf8')).payload.proposals).toEqual([proposal]);
  await page.getByLabel('Import backup', { exact: true }).setInputFiles(backupPath);
  await page.getByRole('button', { name: 'Replace & import', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
