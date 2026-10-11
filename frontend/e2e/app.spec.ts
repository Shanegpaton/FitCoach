import { test, expect, type Page } from '@playwright/test';

async function openApp(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function makePlan(page: Page) {
  await page.getByRole('link', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'New plan', exact: true }).click();
  await page.getByLabel('Plan name', { exact: true }).fill('My strength plan');
  await page.getByLabel('Workout name', { exact: true }).fill('Strength A');
  await page.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('rotation');
  await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose an exercise' });
  await picker.getByRole('button', { name: /Barbell squat/ }).click();
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: 'Today', exact: true }).click();
}

async function logSet(page: Page, number: number, weight: string, reps: string, exercise = 'Barbell squat') {
  const progress = page.getByRole('progressbar', { name: 'Workout sets completed' });
  const completedBefore = Number(await progress.getAttribute('aria-valuenow'));
  await page.getByRole('spinbutton', { name: `Weight set ${number} ${exercise}`, exact: true }).fill(weight);
  await page.getByRole('spinbutton', { name: `Reps set ${number} ${exercise}`, exact: true }).fill(reps);
  await page.getByRole('button', { name: `Complete set ${number} ${exercise}`, exact: true }).click();
  await expect(progress).toHaveAttribute('aria-valuenow', String(completedBefore + 1));
}

test('empty history, onboarding editing, responsive layout and navigation', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByRole('button', { name: 'Set up my profile' }).click();
  await page.getByLabel('What are you working toward?').fill('Build strength and train consistently');
  await page.getByRole('button', { name: 'Let’s get started' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.getByText('Your first chapter is ahead.')).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('Build strength and train consistently');
  await page.getByRole('combobox', { name: 'Weight unit', exact: true }).selectOption('kg');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('status')).toContainText('Profile saved');
  await page.reload(); await expect(page.getByRole('combobox', { name: 'Weight unit', exact: true })).toHaveValue('kg');
  await page.getByRole('link', { name: 'FitCoach home' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('today.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('manual plan, advanced set tools, offline logging, reload recovery and real history', async ({ page, context }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page); await makePlan(page);
  await page.getByRole('button', { name: 'Start workout', exact: true }).click();
  await expect(page).toHaveURL(/\/workout\//);
  await expect(page.getByRole('heading', { name: 'Strength A', exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: 'Weight set 1 Barbell squat' })).toBeVisible();
  await context.setOffline(true);
  await logSet(page, 1, '100', '8');
  await page.getByRole('button', { name: 'Drop set', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Weight set 4 Barbell squat', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Warm-up', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Weight set 5 Barbell squat', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Uncomplete set 2 Barbell squat', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Weight set 2 Barbell squat', exact: true })).toHaveValue('100');
  await page.screenshot({ path: info.outputPath('workout.png'), fullPage: true });
  await page.getByRole('button', { name: 'Finish workout', exact: true }).click();
  await page.getByRole('button', { name: 'Save completed workout', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session journal', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Strength A/ })).toBeVisible();
  await page.getByLabel('Exercise trend').selectOption('ex-squat');
  await expect(page.getByText('100 lb best external load')).toBeVisible();
  await page.screenshot({ path: info.outputPath('history.png'), fullPage: true });
  await page.reload(); await expect(page.getByRole('link', { name: /Strength A/ })).toBeVisible();
  await context.setOffline(false);
  expect(errors).toEqual([]);
});

test('sample Coach proposal is editable and only saved after Apply', async ({ page }, info) => {
  await openApp(page); await page.getByRole('link', { name: 'Coach', exact: true }).click();
  await expect(page.getByText('Sample Coach', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Build a sample plan/ }).click();
  await page.getByRole('button', { name: 'Review & edit', exact: true }).click();
  await page.getByLabel('Plan name', { exact: true }).fill('Reviewed routine');
  await page.getByRole('button', { name: 'Apply reviewed plan', exact: true }).click();
  await expect(page.getByText('Applied to your plan')).toBeVisible();
  await page.screenshot({ path: info.outputPath('coach.png'), fullPage: true });
  await page.getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reviewed routine', exact: true })).toBeVisible();
});

test('custom exercise, superset flow and durable rest timer', async ({ page }) => {
  await openApp(page); await makePlan(page);
  await page.getByRole('link', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
  await page.getByRole('button', { name: 'Create custom exercise', exact: true }).click();
  const custom = page.getByRole('dialog', { name: 'Custom exercise' });
  await custom.getByLabel('Name', { exact: true }).fill('Cable chest press');
  await custom.getByLabel('Muscle group', { exact: true }).fill('Chest');
  await custom.getByRole('button', { name: 'Save exercise', exact: true }).click();
  const groups = page.getByRole('combobox', { name: 'Superset group', exact: true });
  await groups.nth(0).selectOption('superset-A'); await groups.nth(1).selectOption('superset-A');
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Start workout', exact: true }).click();
  await expect(page).toHaveURL(/\/workout\//);
  await logSet(page, 1, '100', '8');
  await expect(page.getByRole('spinbutton', { name: 'Weight set 1 Cable chest press', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Rest timer', exact: true })).toHaveCount(0);
  await logSet(page, 1, '50', '8', 'Cable chest press');
  await expect(page.getByRole('complementary', { name: 'Rest timer', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
  await expect(page.getByText('REST PAUSED')).toBeVisible();
  await page.reload();
  await expect(page.getByText('REST PAUSED')).toBeVisible();
  await page.getByRole('button', { name: 'Resume timer', exact: true }).click();
  await page.getByRole('button', { name: 'Skip timer', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Rest timer', exact: true })).toHaveCount(0);
});

test('backup export/import round trip and invalid import preserves plans', async ({ page }, info) => {
  await openApp(page); await makePlan(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  const file = await downloaded; const backupPath = info.outputPath('backup.json'); await file.saveAs(backupPath);
  await page.getByLabel('Import backup', { exact: true }).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"version":99}') });
  await expect(page.getByRole('alert')).toContainText('Invalid backup');
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.getByLabel('Import backup', { exact: true }).setInputFiles(backupPath);
  await expect(page.getByRole('dialog', { name: 'Replace local data?' })).toBeVisible();
  await page.getByRole('button', { name: 'Replace & import', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My strength plan', exact: true })).toBeVisible();
});
