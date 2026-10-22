import { test, expect, type Page } from '@playwright/test';

function mockConversations(context: import('@playwright/test').BrowserContext) {
  const items: Array<{ id: string; title: string; createdAt: string; updatedAt: string }> = [];
  const messages = new Map<string, Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: string; metadata?: object }>>();
  context.route('https://api.example.com/v1/coach/conversations**', async route => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (method === 'POST') {
      const now = new Date().toISOString(); const item = { id: `conversation-${items.length + 1}`, title: 'New conversation', createdAt: now, updatedAt: now };
      items.unshift(item); messages.set(item.id, []); return route.fulfill({ status: 201, json: item, headers });
    }
    const id = path.split('/').at(-1)!;
    if (method === 'GET' && path.endsWith('/conversations')) return route.fulfill({ json: { items }, headers });
    const item = items.find(value => value.id === id);
    if (method === 'DELETE') { const index = items.findIndex(value => value.id === id); if (index >= 0) items.splice(index, 1); messages.delete(id); return route.fulfill({ status: 204, headers }); }
    if (method === 'PATCH' && item) { item.title = route.request().postDataJSON().title; item.updatedAt = new Date().toISOString(); return route.fulfill({ json: item, headers }); }
    return route.fulfill({ json: { ...item, messages: messages.get(id) ?? [], nextBefore: null }, headers });
  });
  return { items, messages };
}

test.beforeEach(async ({ page, context }) => {
  const unavailable = async (route: import('@playwright/test').Route) => {
    const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173',
      'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' };
    await route.fulfill({ status: route.request().method() === 'OPTIONS' ? 204 : 503,
      headers, json: route.request().method() === 'OPTIONS' ? undefined : { detail: 'Test service unavailable' } });
  };
  await context.route('https://api.example.com/**', unavailable);
  await context.route('https://vm.example.com/**', unavailable);
  await page.addInitScript(() => {
    localStorage.setItem('sb-fitcoach-e2e-auth-token', JSON.stringify({
      access_token: 'offline-test-access-token', refresh_token: 'offline-test-refresh-token', token_type: 'bearer',
      expires_in: 3600, expires_at: 4102444800,
      user: { id: 'e2e-user', aud: 'authenticated', role: 'authenticated', email: 'tester@example.com', app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' },
    }));
  });
});

test('VM connection opens the in-app browser and reports verified scope', async ({ page, context }) => {
  let connected = false;
  let stored = false;
  const connection = () => ({ paired: connected, busy: false, connected, email: connected ? 'coach@example.com' : null,
    name: connected ? 'Coach' : null, planUsageGranted: connected ? true : null });
  await context.route('https://api.example.com/v1/chatgpt/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/chatgpt/vm/save') stored = true;
    if (path.startsWith('/v1/chatgpt/vm/attempts/')) connected = true;
    const body = path === '/v1/chatgpt/vm/attempts' ? { id: '00000000-0000-0000-0000-000000000001', state: 'pending', viewerToken: 'test-viewer' }
      : path.startsWith('/v1/chatgpt/vm/attempts/') ? { id: '00000000-0000-0000-0000-000000000001', state: 'connected', connection: connection() }
      : stored ? { ...connection(), storedInBackend: true, vmCleanupPending: false }
      : path === '/v1/chatgpt/vm/connection' ? connection()
      : { connected: false, email: null, name: null, planUsageGranted: null, storedInBackend: false };
    return route.fulfill({ json: body,
      headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173',
        'Access-Control-Allow-Headers': 'authorization,content-type',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' } });
  });
  await openApp(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ChatGPT connection' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect ChatGPT' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect ChatGPT' }).click();
  await expect(page.getByRole('dialog', { name: 'ChatGPT sign-in' })).toBeVisible();
  await expect(page.getByLabel('Interactive OpenAI sign-in browser')).toBeVisible();
  await expect(page.getByLabel('Tap a field on OpenAI’s page, then type here with your phone keyboard.')).toBeVisible();
  await expect(page.getByText('Connected to Coach.')).toBeVisible();
  await expect(page.getByText('ChatGPT plan usage: Granted at sign-in')).toBeVisible();
  await expect(page.getByText('Connection saved in the backend. The VM session has been cleared.')).toBeVisible();
});

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
  await expect(page.getByRole('status').filter({ hasText: 'Profile saved' })).toBeVisible();
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

test.describe('persistent Coach conversations', () => {
test.use({ serviceWorkers: 'block' });

test('connected Coach sends through the API and labels the saved reply', async ({ page, context }) => {
  const calls: unknown[] = [];
  const store = mockConversations(context);
  await context.route('https://api.example.com/v1/chatgpt/**', async route => {
    const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173',
      'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (route.request().url().endsWith('/coach')) {
      const body = route.request().postDataJSON(); calls.push(body);
      const now = new Date().toISOString(); const history = store.messages.get(body.conversationId)!;
      const conversation = store.items.find(item => item.id === body.conversationId);
      if (conversation?.title === 'New conversation') conversation.title = body.message.text.slice(0, 160);
      history.push({ id: 'user-turn', role: 'user', text: body.message.text, createdAt: now });
      history.push({ id: 'assistant-turn', role: 'assistant', text: 'Start with two training days.', createdAt: now });
      return route.fulfill({ json: { text: 'Start with two training days.', messageId: 'assistant-turn', userMessageId: 'user-turn' }, headers });
    }
    return route.fulfill({ json: { connected: true, planUsageGranted: true, storedInBackend: true }, headers });
  });
  await openApp(page);
  await page.getByRole('link', { name: 'Coach', exact: true }).click();
  await expect(page.getByText('ChatGPT Coach', { exact: true })).toBeVisible();
  await page.getByLabel('Message Coach').fill('How should I begin?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Start with two training days.')).toBeVisible();
  await expect(page.getByText('COACH · CHATGPT')).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ message: { role: 'user', text: 'How should I begin?' },
    trainingDataReady: false });
  expect(calls[0]).toHaveProperty('conversationId');
  expect(calls[0]).toHaveProperty('requestId');
  expect(calls[0]).toHaveProperty('localDate', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  expect(calls[0]).not.toHaveProperty('context');
  await page.reload();
  await page.getByRole('link', { name: 'Coach', exact: true }).click();
  await expect(page.getByText('Start with two training days.')).toBeVisible();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.getByText('Training with', { exact: false })).toBeVisible();
  await page.locator('.coach-conversation-select').filter({ hasText: 'How should I begin?' }).click();
  await expect(page.getByText('Start with two training days.')).toBeVisible();
  page.once('dialog', dialog => dialog.accept('Bench notes'));
  await page.getByRole('button', { name: /Rename How should I begin/ }).click();
  await expect(page.locator('.coach-conversation-select').filter({ hasText: 'Bench notes' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /Delete Bench notes/ }).click();
  await expect(page.locator('.coach-conversation-select').filter({ hasText: 'New conversation' })).toBeVisible();
});
});

test('live Coach renders a durable structured proposal and requires sync before approval', async ({ page, context }) => {
  mockConversations(context);
  const proposal = { id: 'a936e1b0-e49a-4cdb-9fc8-7ea2303aefa1', type: 'create', targetPlanId: null,
    sourceEtag: null, operations: [], assumptions: ['Starting load is left for you to choose.'],
    summary: 'New plan: Upper Lower (Upper A).', createdAt: '2026-10-21T12:00:00Z',
    expiresAt: '2026-10-22T12:00:00Z', status: 'pending', plan: { id: 'coach-plan', name: 'Upper Lower',
      schedule: 'week', cursor: 0, revision: 0, active: true, workouts: [{ id: 'upper-a', name: 'Upper A', days: [1],
        blocks: [{ id: 'bench', exerciseId: 'ex-squat', restSeconds: 120, supersetId: null,
          sets: [{ id: 'set-1', kind: 'working', targetReps: 8, targetKg: null, chainId: null }] }] }] } };
  await context.route('https://api.example.com/v1/chatgpt/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/connection') ? { connected: true, planUsageGranted: true }
      : path.endsWith('/coach') ? { text: 'I drafted an upper-body day for review.', proposal, messageId: 'assistant-proposal', userMessageId: 'user-proposal' }
      : { connected: true, planUsageGranted: true };
    return route.fulfill({ json: body, headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173',
      'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
  });
  let rejected = false;
  await context.route('https://api.example.com/v1/coach/proposals/**', async route => {
    if (route.request().url().endsWith('/reject')) rejected = true;
    return route.fulfill({ json: { ...proposal, status: rejected ? 'rejected' : 'pending' },
      headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173',
        'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
  });
  await openApp(page);
  await page.getByRole('link', { name: 'Coach', exact: true }).click();
  await expect(page.getByText('ChatGPT Coach', { exact: true })).toBeVisible();
  await page.getByLabel('Message Coach').fill('Build me an upper lower plan.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('NEW PLAN PROPOSAL')).toBeVisible();
  await expect(page.getByText('Upper A', { exact: true })).toBeVisible();
  await expect(page.getByText(/Starting load is left for you/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve changes' })).toBeDisabled();
  await page.getByRole('button', { name: 'Reject changes' }).click();
  await expect(page.getByText('Proposal dismissed or no longer valid')).toBeVisible();
  expect(rejected).toBe(true);
});

test('live Coach approval commits through the API and refreshes the local plan cache', async ({ page, context }) => {
  mockConversations(context);
  const proposal = { id: '81d560ac-5ef1-4e55-a6b9-6f393bf45547', type: 'create', targetPlanId: null,
    sourceEtag: null, beforePlan: null, operations: [], assumptions: [], summary: 'New plan: Upper day.',
    createdAt: '2026-10-21T12:00:00Z', expiresAt: '2026-10-22T12:00:00Z', status: 'pending',
    plan: { id: 'approved-coach-plan', name: 'Upper day', description: 'A focused strength day.',
      schedule: 'week', cursor: 0, revision: 0, active: true, workouts: [{ id: 'approved-upper', name: 'Upper A', days: [1],
        blocks: [{ id: 'approved-bench', exerciseId: 'ex-bench', restSeconds: 120, supersetId: null,
          sets: [{ id: 'approved-set', kind: 'working', targetReps: 5, targetKg: null, chainId: null }] }] }] } };
  let approved = false;
  await context.route(/^https:\/\/api\.example\.com\/v1\/sync\/changes/, route => route.fulfill({ json: { items: [], cursor: 0, highWater: 0, hasMore: false },
    headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173', 'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } }));
  await context.route(/^https:\/\/api\.example\.com\/v1\/sync\/mutations/, async route => {
    const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173', 'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const mutations = route.request().postDataJSON().mutations as Array<{ mutationId: string; resource: string; id: string; expectedEtag?: string; payload: unknown }>;
    return route.fulfill({ json: { results: mutations.map(mutation => ({ mutationId: mutation.mutationId,
      status: mutation.expectedEtag ? 200 : 201, resource: mutation.resource, id: mutation.id,
      etag: mutation.expectedEtag ?? '"1"', document: mutation.payload, error: null })) }, headers });
  });
  await context.route('https://api.example.com/v1/chatgpt/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/connection') ? { connected: true, planUsageGranted: true }
      : path.endsWith('/coach') ? { text: 'Review this plan before saving.', proposal, messageId: 'assistant-proposal', userMessageId: 'user-proposal' }
      : { connected: true, planUsageGranted: true };
    return route.fulfill({ json: body, headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173',
      'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
  });
  await context.route('https://api.example.com/v1/coach/proposals/**', async route => {
    if (route.request().url().endsWith('/approve')) {
      approved = true;
      return route.fulfill({ json: { proposal: { ...proposal, status: 'approved' }, plan: proposal.plan,
        etag: '"1"', replayed: false }, headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173',
          'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
    }
    return route.fulfill({ json: { ...proposal, status: approved ? 'approved' : 'pending' },
      headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173', 'Access-Control-Allow-Headers': 'authorization,content-type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
  });
  await openApp(page);
  await page.getByRole('link', { name: 'Coach', exact: true }).click();
  await expect(page.getByText('ChatGPT Coach', { exact: true })).toBeVisible();
  await page.getByLabel('Message Coach').fill('Build a strength plan.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const approve = page.getByRole('button', { name: 'Approve changes' });
  await expect(approve).toBeEnabled({ timeout: 10000 });
  await approve.click();
  await expect(page.getByText('Applied to your plan')).toBeVisible();
  expect(approved).toBe(true);
  await page.getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Upper day', exact: true })).toBeVisible();
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
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid backup' })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.getByLabel('Import backup', { exact: true }).setInputFiles(backupPath);
  await expect(page.getByRole('dialog', { name: 'Replace local data?' })).toBeVisible();
  await page.getByRole('button', { name: 'Replace & import', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My strength plan', exact: true })).toBeVisible();
});

test('legacy import closes with feedback and is offered only once', async ({ page }) => {
  await openApp(page);
  const prompt = page.getByRole('dialog', { name: 'Import this device’s training data?' });
  await expect(prompt).toHaveCount(0);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('fitcoach-v1');
      request.onupgradeneeded = () => {
        for (const name of ['profile', 'exercises', 'plans', 'sessions', 'overrides', 'messages', 'proposals'])
          request.result.createObjectStore(name, { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('profile', 'readwrite');
        transaction.objectStore('profile').put({ id: 'profile', goals: 'Legacy strength goal',
          experience: 'Beginner', equipment: [], trainingDays: [], sessionMinutes: 45, unit: 'lb', onboardingDone: true });
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    localStorage.removeItem('fitcoach:e2e-user:legacy-reviewed');
  });
  await page.reload();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Import data' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.locator('.toast[role="status"]')).toContainText('Training data imported on this device');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('Legacy strength goal');
  await page.reload();
  await expect(prompt).toHaveCount(0);
});

test('conflict review shows both versions and queues a manual result', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('fitcoach-user-e2e-user');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(['profile', 'sync'], 'readwrite');
        const profile = transaction.objectStore('profile');
        const read = profile.get('profile');
        read.onsuccess = () => {
          const local = { ...read.result, goals: 'Device goal' };
          const cloud = { ...read.result, goals: 'Cloud goal' };
          profile.put(local);
          transaction.objectStore('sync').put({ id: 'conflict:e2e-user:profile:profile',
            userId: 'e2e-user', kind: 'conflict', entity: 'profile', entityId: 'profile',
            payload: local, remotePayload: cloud, remoteDeleted: false, remoteEtag: '"3"',
            reason: 'This record changed on another device.' });
        };
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Review versions' }).click();
  const review = page.getByRole('dialog', { name: 'Resolve sync conflict' });
  await expect(review.locator('summary', { hasText: 'This device' })).toBeVisible();
  await expect(review.locator('summary', { hasText: 'Cloud' })).toBeVisible();
  await review.getByRole('button', { name: 'Edit and merge' }).click();
  await review.getByRole('button', { name: 'Use cloud value' }).first().click();
  await review.getByRole('textbox', { name: 'Goals', exact: true }).fill('Combined goal');
  await review.getByRole('button', { name: 'Save and upload final version' }).click();
  await expect(review).toHaveCount(0);
  await expect(page.locator('.sync-resolutions')).toContainText('Pending upload');
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('Combined goal');
});

test('failed uploads stay visible instead of showing synchronized', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('fitcoach-user-e2e-user');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('outbox', 'readwrite');
        transaction.objectStore('outbox').put({ id: crypto.randomUUID(), userId: 'e2e-user',
          createdAt: new Date().toISOString(), entity: 'profile', entityId: 'profile',
          operation: 'upsert', payload: null, expectedEtag: '"3"', localRevision: 1,
          status: 'failed', error: 'Invalid profile data', sentAt: new Date().toISOString() });
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Failed uploads' })).toBeVisible();
  await expect(page.getByText('Invalid profile data')).toBeVisible();
  await expect(page.getByText('All changes are synchronized.')).toHaveCount(0);
});
