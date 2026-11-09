import { test, expect, type Page } from '@playwright/test';

function mockConversations(context: import('@playwright/test').BrowserContext, origin = 'http://localhost:4173') {
  const items: Array<{ id: string; title: string; createdAt: string; updatedAt: string }> = [];
  const messages = new Map<string, Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: string; metadata?: object }>>();
  context.route('https://api.example.com/v1/coach/conversations**', async route => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
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

async function openMainPage(page: Page, name: 'Plan' | 'History') {
  if (new URL(page.url()).pathname === '/coach' || new URL(page.url()).pathname.startsWith('/workout/')) await page.getByRole('link', { name: 'Today', exact: true }).click();
  await page.getByRole('link', { name, exact: true }).click();
}

async function openCoach(page: Page) {
  if (new URL(page.url()).pathname.startsWith('/workout/')) await page.getByRole('link', { name: 'Today', exact: true }).click();
  if (new URL(page.url()).pathname !== '/coach') await page.getByRole('link', { name: 'Coach', exact: true }).click();
}

async function waitForCoachSync(page: Page) {
  // Onboarding can finish while bootstrap is running. A foreground event asks
  // the coordinator to upload that local change once the current pass finishes.
  await expect.poll(async () => {
    if (await page.getByRole('link', { name: 'Settings. Synchronization: Synced', exact: true }).isVisible()) return true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    return false;
  }).toBe(true);
}

async function makePlan(page: Page) {
  await openMainPage(page, 'Plan');
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
  await openMainPage(page, 'History');
  await expect(page.getByText('No completed workouts yet')).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('Build strength and train consistently');
  const saveChanges = page.getByRole('button', { name: 'Save changes', exact: true });
  await expect(saveChanges).toHaveCount(0);
  const unit = page.getByRole('combobox', { name: 'Weight unit', exact: true });
  await unit.selectOption('kg');
  await expect(saveChanges).toBeVisible();
  await unit.selectOption('lb');
  await expect(saveChanges).toHaveCount(0);
  await unit.selectOption('kg');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Profile saved' })).toBeVisible();
  await expect(saveChanges).toHaveCount(0);
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
  await openApp(page); await openCoach(page);
  await expect(page.getByRole('heading', { name: 'Coach', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Build a sample plan/ }).click();
  await page.getByRole('button', { name: 'Review & edit', exact: true }).click();
  await page.getByLabel('Plan name', { exact: true }).fill('Reviewed routine');
  await page.getByRole('button', { name: 'Apply reviewed plan', exact: true }).click();
  await expect(page.getByText('Applied to your plan')).toBeVisible();
  await page.screenshot({ path: info.outputPath('coach.png'), fullPage: true });
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await openMainPage(page, 'Plan');
  await expect(page.getByRole('heading', { name: 'Reviewed routine', exact: true })).toBeVisible();
});

test.describe('persistent Coach conversations', () => {
test.use({ serviceWorkers: 'block' });

test('Coach renders rich replies safely on phones and preserves diagram source', async ({ page, context }, info) => {
  if (info.project.name.startsWith('phone')) await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  mockConversations(context);
  let imageRequests = 0;
  await context.route('https://images.example.com/**', route => { imageRequests++; return route.abort(); });
  const reply = [
    '## Training overview',
    'A simple progression with a recovery day.',
    '```mermaid\nflowchart LR\n  A[Train] --> B[Recover]\n  B --> C[Repeat]\n```',
    '```mermaid\nsequenceDiagram\n  Athlete->>Coach: Log workout\n  Coach-->>Athlete: Review progress\n```',
    '```mermaid\npie title Weekly sessions\n  "Strength" : 3\n  "Recovery" : 2\n```',
    '```mermaid\nxychart-beta\n  x-axis [Mon, Wed, Fri]\n  y-axis "Sets" 0 --> 20\n  bar [10, 12, 14]\n```',
    '```mermaid\nmindmap\n  root((Training))\n    Strength\n    Recovery\n```',
    '| Day | Goal |\n| --- | --- |\n| Monday | Strength |',
    '- [x] Warm up\n- [ ] Log sets',
    'Estimated volume: $V = sets \\times reps$.',
    '$$\nV = 3 \\times 8 = 24\n$$',
    '```python\nprint("training")\n```',
    '```unknown-language\nplain code survives\n```',
    'Reference[^1].\n\n[^1]: Your recorded training notes.',
    '[Training reference](https://example.com/training)',
    '[Unsafe link](javascript:alert(1))',
    '<script>window.coachUnsafe = true</script>',
    '![Exercise illustration](https://images.example.com/exercise.png)',
    '```mermaid\nthis is not a valid diagram\n```',
    '```mermaid\n%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\nA --> B\n```',
  ].join('\n\n');
  await context.route('https://api.example.com/v1/chatgpt/**', route => route.fulfill({
    json: route.request().url().endsWith('/coach') ? { text: reply, messageId: 'rich-reply', userMessageId: 'rich-user' }
      : { connected: true, planUsageGranted: true },
    headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' },
  }));
  await openApp(page); await openCoach(page);
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible();
  await page.getByLabel('Message Coach').fill('Show a diagram and common reply formats.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const replyElement = page.locator('.message.assistant').last();
  await expect(replyElement.getByRole('heading', { name: 'Training overview' })).toBeVisible();
  const preview = replyElement.locator('.coach-diagram-scroll img');
  await expect(preview).toHaveCount(5);
  for (const image of await preview.all()) {
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const labels = await image.evaluate((img: HTMLImageElement) => {
      const svg = new DOMParser().parseFromString(decodeURIComponent(img.src.split(',')[1]), 'image/svg+xml');
      return Array.from(svg.querySelectorAll('text')).map(text => text.textContent).join(' ');
    });
    expect(labels.trim().length).toBeGreaterThan(0);
  }
  await expect(replyElement.locator('.katex')).toHaveCount(2);
  await expect(replyElement.locator('.hljs-built_in')).toContainText('print');
  await expect(replyElement.getByRole('cell', { name: 'Strength', exact: true })).toHaveCount(1);
  await expect(replyElement.getByRole('checkbox')).toHaveCount(2);
  await expect(replyElement.locator('.footnotes')).toContainText('Your recorded training notes.');
  const footnote = replyElement.locator('a[data-footnote-ref]');
  const footnoteTarget = await footnote.getAttribute('href');
  expect(await page.locator(`[id="${footnoteTarget!.slice(1)}"]`).count()).toBe(1);
  await expect(replyElement.getByRole('link', { name: 'Training reference' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(replyElement.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => 'coachUnsafe' in window)).toBe(false);
  await expect(replyElement.getByText('This diagram could not be rendered. The source is preserved below.')).toHaveCount(2);
  await expect(replyElement.locator('pre').filter({ hasText: 'plain code survives' })).toHaveCount(1);
  expect(imageRequests).toBe(0);
  await expect(replyElement.getByRole('button', { name: 'Load image: Exercise illustration' })).toHaveCount(1);
  const diagram = replyElement.locator('.coach-diagram').first();
  await diagram.scrollIntoViewIfNeeded();
  await diagram.getByRole('button', { name: 'Zoom in diagram' }).click();
  await expect(diagram.getByText('150%')).toBeVisible();
  const download = page.waitForEvent('download');
  await diagram.getByRole('link', { name: 'Save SVG' }).click();
  expect((await download).suggestedFilename()).toBe('coach-diagram.svg');
  await diagram.getByText('Diagram source', { exact: true }).click();
  await expect(diagram.locator('pre')).toContainText('A[Train]');
  await replyElement.getByRole('button', { name: 'Copy reply', exact: true }).click();
  await expect(replyElement.getByRole('status').filter({ hasText: /Copied|Copy unavailable/ })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await diagram.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('coach-rich-content.png') });
  if (info.project.name.startsWith('phone')) {
    await page.setViewportSize({ width: 812, height: 375 });
    await diagram.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('coach-rich-content-landscape.png') });
  }
});

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
  await openCoach(page);
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible();
  await page.getByLabel('Message Coach').fill('How should I begin?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Start with two training days.')).toBeVisible();
  await expect(page.getByText('Coach · ChatGPT', { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ message: { role: 'user', text: 'How should I begin?' },
    trainingDataReady: false });
  expect(calls[0]).toHaveProperty('conversationId');
  expect(calls[0]).toHaveProperty('requestId');
  expect(calls[0]).toHaveProperty('localDate', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  expect(calls[0]).not.toHaveProperty('context');
  await page.reload();
  await openCoach(page);
  await expect(page.getByText('Start with two training days.')).toBeVisible();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.getByRole('heading', { name: 'What would help today?', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find a conversation' }).fill('How should');
  await page.locator('.coach-conversation-select').filter({ hasText: 'How should I begin?' }).click();
  await expect(page.getByText('Start with two training days.')).toBeVisible();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: /Rename How should I begin/ }).click();
  await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill('Bench notes');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find a conversation' }).fill('');
  await expect(page.locator('.coach-conversation-select').filter({ hasText: 'Bench notes' })).toBeVisible();
  await page.getByRole('button', { name: /Delete Bench notes/ }).click();
  await page.getByRole('button', { name: 'Keep conversation', exact: true }).click();
  await expect(page.locator('.coach-conversation-select').filter({ hasText: 'Bench notes' })).toBeVisible();
  await page.getByRole('button', { name: /Delete Bench notes/ }).click();
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
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
  await openCoach(page);
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible();
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
  const origin = test.info().project.use.baseURL!;
  mockConversations(context, origin);
  const proposal = { id: '81d560ac-5ef1-4e55-a6b9-6f393bf45547', type: 'create', targetPlanId: null,
    sourceEtag: null, beforePlan: null, operations: [], assumptions: [], summary: 'New plan: Upper day.',
    createdAt: '2026-10-21T12:00:00Z', expiresAt: '2026-10-22T12:00:00Z', status: 'pending',
    plan: { id: 'approved-coach-plan', name: 'Upper day', description: 'A focused strength day.',
      schedule: 'week', cursor: 0, revision: 0, active: true, workouts: [{ id: 'approved-upper', name: 'Upper A', days: [1],
        blocks: [{ id: 'approved-bench', exerciseId: 'ex-bench', restSeconds: 120, supersetId: null,
          sets: [{ id: 'approved-set', kind: 'working', targetReps: 5, targetKg: null, chainId: null }] }] }] } };
  let approved = false;
  await context.route(/^https:\/\/api\.example\.com\/v1\/sync\/changes/, route => route.fulfill({ json: { items: [], cursor: 0, highWater: 0, hasMore: false },
    headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } }));
  await context.route(/^https:\/\/api\.example\.com\/v1\/sync\/mutations/, async route => {
    const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization,content-type',
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
    return route.fulfill({ json: body, headers: { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
  });
  await context.route('https://api.example.com/v1/coach/proposals/**', async route => {
    if (route.request().url().endsWith('/approve')) {
      approved = true;
      return route.fulfill({ json: { proposal: { ...proposal, status: 'approved' }, plan: proposal.plan,
        etag: '"1"', replayed: false }, headers: { 'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
    }
    return route.fulfill({ json: { ...proposal, status: approved ? 'approved' : 'pending' },
      headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization,content-type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
  });
  await openApp(page);
  await openCoach(page);
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible();
  await waitForCoachSync(page);
  await page.getByLabel('Message Coach').fill('Build a strength plan.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const approve = page.getByRole('button', { name: 'Approve changes' });
  await expect(approve).toBeEnabled({ timeout: 10000 });
  await approve.click();
  await expect(page.getByText('Applied to your plan')).toBeVisible();
  expect(approved).toBe(true);
  await openMainPage(page, 'Plan');
  await expect(page.getByRole('heading', { name: 'Upper day', exact: true })).toBeVisible();
});

test('custom exercise, superset flow and durable rest timer', async ({ page }) => {
  await openApp(page); await makePlan(page);
  await openMainPage(page, 'Plan');
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
  await page.getByRole('button', { name: 'Create custom exercise', exact: true }).click();
  const custom = page.getByRole('dialog', { name: 'Custom exercise' });
  await custom.getByLabel('Name', { exact: true }).fill('Cable chest press');
  await custom.getByLabel('Muscle group', { exact: true }).fill('Chest');
  await custom.getByRole('button', { name: 'Save exercise', exact: true }).click();
  await expect(custom).toHaveCount(0);
  await expect(page.locator('.editor-block')).toHaveCount(2);
  for (const options of await page.locator('.advanced-prescription > summary').all()) await options.click();
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
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
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
  await openMainPage(page, 'Plan');
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
  await expect(review.getByRole('heading', { name: 'This device', exact: true })).toBeVisible();
  await expect(review.getByRole('heading', { name: 'Cloud', exact: true })).toBeVisible();
  await expect(review.locator('.conflict-version').first()).toContainText('Device goal');
  await expect(review.locator('.conflict-version').last()).toContainText('Cloud goal');
  await review.getByRole('button', { name: 'Edit and merge' }).click();
  await review.getByRole('button', { name: 'Use cloud value' }).first().click();
  await review.getByRole('textbox', { name: 'What are you working toward?', exact: true }).fill('Combined goal');
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

test.describe('Coach interrupted requests', () => {
  test.use({ serviceWorkers: 'block' });

  test('keeps an interrupted message across reload and retries with the original ID', async ({ page, context }) => {
    const store = mockConversations(context);
    const requests: Array<{ conversationId: string; requestId: string; message: { text: string } }> = [];
    let status = 'started';
    const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173',
      'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    await context.route('https://api.example.com/v1/coach/conversations/*/turns/*', route =>
      route.fulfill({ json: { status }, headers }));
    await context.route('https://api.example.com/v1/chatgpt/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (!route.request().url().endsWith('/coach')) return route.fulfill({ json: { connected: true, planUsageGranted: true }, headers });
      const body = route.request().postDataJSON(); requests.push(body);
      if (requests.length === 1) return route.fulfill({ status: 503, json: { detail: 'Connection interrupted' }, headers });
      const now = new Date().toISOString();
      store.messages.get(body.conversationId)!.push(
        { id: 'recovered-user', role: 'user', text: body.message.text, createdAt: now },
        { id: 'recovered-assistant', role: 'assistant', text: 'Recovered safely.', createdAt: now });
      status = 'completed';
      return route.fulfill({ json: { text: 'Recovered safely.', messageId: 'recovered-assistant', userMessageId: 'recovered-user' }, headers });
    });
    await openApp(page);
    await openCoach(page);
    await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible();
    await page.getByLabel('Message Coach').fill('Keep my question');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText(/Coach is still processing your saved message/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await page.reload();
    await expect(page.getByLabel('Message Coach')).toHaveValue('Keep my question');
    await expect(page.getByText(/Coach is still processing your saved message/)).toBeVisible();
    status = 'failed';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText(/Retry it with Send/)).toBeVisible();
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Recovered safely.')).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1].requestId).toBe(requests[0].requestId);
    await expect(page.getByLabel('Message Coach')).toHaveValue('');
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.includes('coach-pending-turn:')).length)).toBe(0);
  });

  test('loads a completed reply after the response was lost without sending again', async ({ page, context }) => {
    const store = mockConversations(context);
    let sends = 0;
    const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173',
      'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    await context.route('https://api.example.com/v1/coach/conversations/*/turns/*', route =>
      route.fulfill({ json: { status: 'completed' }, headers }));
    await context.route('https://api.example.com/v1/chatgpt/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (!route.request().url().endsWith('/coach')) return route.fulfill({ json: { connected: true, planUsageGranted: true }, headers });
      sends++;
      const body = route.request().postDataJSON(); const now = new Date().toISOString();
      store.messages.get(body.conversationId)!.push(
        { id: 'saved-user', role: 'user', text: body.message.text, createdAt: now },
        { id: 'saved-assistant', role: 'assistant', text: 'Already saved on the server.', createdAt: now });
      return route.fulfill({ status: 503, json: { detail: 'Response lost' }, headers });
    });
    await openApp(page);
    await openCoach(page);
    await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible();
    await page.getByLabel('Message Coach').fill('Answer once');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Already saved on the server.')).toBeVisible();
    await expect(page.getByLabel('Message Coach')).toHaveValue('');
    expect(sends).toBe(1);
  });
});

test.describe('Coach workout corrections', () => {
  // Mock API routes must stay visible to Playwright after reload. The separate
  // offline logging test above exercises the real service worker.
  test.use({ serviceWorkers: 'block' });
for (const decision of ['accept', 'reject', 'stale'] as const) {
  test(`Coach workout edit preview survives reload and handles ${decision}`, async ({ page, context }) => {
    const origin = test.info().project.use.baseURL!;
    const conversations = mockConversations(context, origin);
    const headers = { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    const original = { id: 'history-edit', planId: 'old-plan', workoutId: 'old-workout', name: 'Recorded squat workout',
      date: '2026-10-11', startedAt: '2026-10-11T13:00:00.000Z', completedAt: '2026-10-11T14:00:00.000Z',
      status: 'completed', notes: 'Original workout notes', timer: null,
      blocks: [{ id: 'squat-block', exerciseId: 'ex-squat', name: 'Recorded squat', loadMode: 'external', restSeconds: 120,
        supersetId: null, notes: '', sets: [{ id: 'recorded-set', kind: 'working', targetReps: 8, targetKg: null,
          chainId: null, kg: 40, reps: 8, effort: 7, done: true }] }] };
    const edited = structuredClone(original);
    edited.blocks[0].sets[0].reps = 5;
    edited.notes = 'Corrected recorded reps';
    const proposal = { id: 'workout-proposal', type: 'session_modify', targetSessionId: original.id,
      sourceEtag: '"1"', beforeSession: original, session: edited, summary: 'Correct last workout reps.',
      createdAt: '2026-11-06T12:00:00Z', expiresAt: '2099-11-07T12:00:00Z', status: 'pending' };
    let stored = original;
    let approved = false;
    let rejected = false;
    let stale = false;
    await context.route(/^https:\/\/api\.example\.com\/v1\/sync\/changes/, route => route.fulfill({ headers,
      json: { items: [{ resource: 'sessions', id: original.id, sequence: approved ? 2 : 1, version: approved ? 2 : 1,
        etag: approved ? '"2"' : '"1"', deleted: false, document: stored }], cursor: approved ? 2 : 1,
        highWater: approved ? 2 : 1, hasMore: false } }));
    await context.route(/^https:\/\/api\.example\.com\/v1\/sync\/mutations/, async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const mutations = route.request().postDataJSON().mutations as Array<{ mutationId: string; resource: string; id: string; payload: unknown }>;
      return route.fulfill({ headers, json: { results: mutations.map(item => ({ ...item, status: 201,
        etag: '"1"', document: item.payload, error: null })) } });
    });
    await context.route('https://api.example.com/v1/chatgpt/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const path = new URL(route.request().url()).pathname;
      if (!path.endsWith('/coach')) return route.fulfill({ headers, json: { connected: true, planUsageGranted: true } });
      const conversationId = route.request().postDataJSON().conversationId as string;
      conversations.messages.set(conversationId, [
        { id: 'edit-user', role: 'user', text: 'Change my last squat set to 5 reps.', createdAt: proposal.createdAt },
        { id: 'edit-assistant', role: 'assistant', text: 'Review this workout correction.', createdAt: proposal.createdAt,
          metadata: { artifacts: [{ id: proposal.id, type: 'workout_edit_proposal' }] } },
      ]);
      return route.fulfill({ headers, json: { text: 'Review this workout correction.', proposal,
        messageId: 'edit-assistant', userMessageId: 'edit-user' } });
    });
    await context.route('https://api.example.com/v1/coach/proposals/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/approve')) {
        if (decision === 'stale') {
          stale = true;
          return route.fulfill({ status: 409, headers, json: { detail: 'Workout changed. Create a fresh proposal.' } });
        }
        approved = true; stored = edited;
        return route.fulfill({ headers, json: { proposal: { ...proposal, status: 'approved' }, session: edited, etag: '"2"', replayed: false } });
      }
      if (path.endsWith('/reject')) rejected = true;
      return route.fulfill({ headers, json: { ...proposal, status: approved ? 'approved' : rejected ? 'rejected' : stale ? 'invalidated' : 'pending' } });
    });
    await openApp(page);
    await openCoach(page);
    await waitForCoachSync(page);
    await page.getByLabel('Message Coach').fill('Change my last squat set to 5 reps.');
    await page.getByRole('button', { name: 'Send message' }).click();
    const card = page.getByLabel('Workout edit proposal');
    await expect(card).toBeVisible();
    await expect(card.getByRole('cell', { name: '5', exact: true })).toBeVisible();
    expect(stored.blocks[0].sets[0].reps).toBe(8);
    await page.reload();
    await expect(card).toBeVisible();
    await card.getByText('Original workout', { exact: true }).click();
    await expect(card.getByRole('cell', { name: '8', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('workout-edit-review.png'), fullPage: true });
    if (decision === 'reject') {
      await card.getByRole('button', { name: 'Reject changes' }).click();
      await expect(card.getByText('Workout edit rejected', { exact: true })).toBeVisible();
      expect(rejected).toBe(true); expect(approved).toBe(false);
    } else {
      await expect(card.getByRole('button', { name: 'Accept changes' })).toBeEnabled();
      await card.getByRole('button', { name: 'Accept changes' }).click();
      await expect(card.getByText(decision === 'accept' ? 'Applied to workout history' : 'Workout edit invalidated', { exact: true })).toBeVisible();
      expect(approved).toBe(decision === 'accept');
    }
    expect(stored.blocks[0].sets[0].reps).toBe(decision === 'accept' ? 5 : 8);
    if (decision === 'accept') {
      await openMainPage(page, 'History');
      await expect(page.getByRole('heading', { name: 'Session journal', exact: true })).toBeVisible();
      await expect(page.getByText('Recorded squat workout', { exact: true })).toBeVisible();
    }
  });
}

});

test.describe('Coach active workout tools', () => {
  test.use({ serviceWorkers: 'block' });
  for (const operation of ['start', 'edit', 'stale'] as const) {
    test(`Coach can ${operation} an active workout through a reviewable proposal`, async ({ page, context }) => {
      const origin = test.info().project.use.baseURL!;
      const conversations = mockConversations(context, origin);
      const headers = { 'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
      const original = { id: 'current-workout', planId: 'source-plan', workoutId: 'workout-a', name: 'Current squat workout',
        date: '2026-11-06', startedAt: '2026-11-06T13:00:00.000Z', completedAt: null, status: 'active', notes: '',
        timer: operation === 'start' ? null : { endAt: Date.now() + 90000, remaining: 0, duration: 90 },
        blocks: [{ id: 'block-a', exerciseId: 'ex-squat', name: 'Barbell squat', loadMode: 'external', restSeconds: 90,
          supersetId: null, notes: '', sets: [{ id: 'set-a', kind: 'working', targetReps: 8, targetKg: null,
            chainId: null, kg: operation === 'start' ? null : 40, reps: operation === 'start' ? null : 8,
            effort: null, done: operation !== 'start' }] }] };
      const proposed = structuredClone(original);
      if (operation !== 'start') proposed.blocks[0].sets.push({ ...proposed.blocks[0].sets[0], id: 'added-set',
        targetReps: 5, kg: null, reps: null, done: false });
      const proposal = { id: 'active-proposal', type: operation === 'start' ? 'session_create' : 'session_modify',
        targetSessionId: original.id, sourceEtag: operation === 'start' ? null : '"1"',
        targetPlanId: operation === 'start' ? 'source-plan' : null, sourcePlanEtag: operation === 'start' ? '"1"' : null,
        beforeSession: operation === 'start' ? null : original, session: proposed, summary: 'Review this workout.',
        createdAt: '2026-11-06T13:00:00Z', expiresAt: '2099-11-07T12:00:00Z', status: 'pending' };
      let stored = operation === 'start' ? null : original;
      let approved = false;
      let invalidated = false;
      await context.route(/^https:\/\/api\.example\.com\/v1\/sync\/changes/, route => route.fulfill({ headers, json: {
        items: stored ? [{ resource: 'sessions', id: stored.id, sequence: approved ? 2 : 1, version: approved ? 2 : 1,
          etag: approved ? '"2"' : '"1"', deleted: false, document: stored }] : [], cursor: approved ? 2 : 1,
        highWater: approved ? 2 : 1, hasMore: false } }));
      await context.route(/^https:\/\/api\.example\.com\/v1\/sync\/mutations/, async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const mutations = route.request().postDataJSON().mutations as Array<{ mutationId: string; resource: string; id: string; payload: unknown }>;
        return route.fulfill({ headers, json: { results: mutations.map(item => ({ ...item, status: 201,
          etag: '"1"', document: item.payload, error: null })) } });
      });
      await context.route('https://api.example.com/v1/chatgpt/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (!new URL(route.request().url()).pathname.endsWith('/coach'))
          return route.fulfill({ headers, json: { connected: true, planUsageGranted: true } });
        const conversationId = route.request().postDataJSON().conversationId as string;
        conversations.messages.set(conversationId, [
          { id: 'active-user', role: 'user', text: 'Help with my current workout.', createdAt: proposal.createdAt },
          { id: 'active-assistant', role: 'assistant', text: 'Review this workout.', createdAt: proposal.createdAt,
            metadata: { artifacts: [{ id: proposal.id, type: 'workout_edit_proposal' }] } },
        ]);
        return route.fulfill({ headers, json: { text: 'Review this workout.', proposal, messageId: 'active-assistant', userMessageId: 'active-user' } });
      });
      await context.route('https://api.example.com/v1/coach/proposals/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (new URL(route.request().url()).pathname.endsWith('/approve')) {
          if (operation === 'stale') {
            invalidated = true;
            return route.fulfill({ status: 409, headers, json: { detail: 'New sets were logged. Ask for a fresh proposal.' } });
          }
          approved = true; stored = proposed;
          return route.fulfill({ headers, json: { proposal: { ...proposal, status: 'approved' }, session: stored, etag: '"2"', replayed: false } });
        }
        return route.fulfill({ headers, json: { ...proposal, status: approved ? 'approved' : invalidated ? 'invalidated' : 'pending' } });
      });
      await openApp(page);
      await openCoach(page);
      await waitForCoachSync(page);
      await page.getByLabel('Message Coach').fill(operation === 'start' ? 'Start workout A.' : 'Add a set of five to my current workout.');
      await page.getByRole('button', { name: 'Send message' }).click();
      const card = page.getByLabel(operation === 'start' ? 'Workout start proposal' : 'Workout edit proposal');
      await expect(card).toBeVisible();
      expect(stored).toEqual(operation === 'start' ? null : original);
      await page.reload();
      await expect(card).toBeVisible();
      await waitForCoachSync(page);
      await card.getByRole('button', { name: operation === 'start' ? 'Start workout' : 'Accept changes', exact: true }).click();
      await expect(card.getByText(operation === 'stale' ? 'Workout edit invalidated' : operation === 'start' ? 'Workout started' : 'Applied to active workout', { exact: true })).toBeVisible();
      expect(approved).toBe(operation !== 'stale');
      expect(stored?.timer).toEqual(original.timer);
      if (operation !== 'stale') {
        if (operation === 'edit') expect(stored?.blocks[0].sets[0]).toEqual(original.blocks[0].sets[0]);
        await card.getByRole('link', { name: 'Open workout' }).click();
        await expect(page).toHaveURL(/\/workout\/current-workout$/);
        await expect(page.getByRole('heading', { name: 'Current squat workout', exact: true })).toBeVisible();
      }
    });
  }
});

test.describe('Coach context and account memory', () => {
  test.use({ serviceWorkers: 'block' });

  test('shows background summaries and keeps maintenance running on Today', async ({ page, context }) => {
    mockConversations(context);
    const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173', 'Access-Control-Allow-Headers': 'authorization,content-type,if-match', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
    let maintenanceCalls = 0;
    await context.route('https://api.example.com/v1/chatgpt/connection', route => route.fulfill({ headers, json: { connected: true, planUsageGranted: true } }));
    await context.route('https://api.example.com/v1/coach/maintenance', route => {
      if (route.request().method() !== 'OPTIONS') maintenanceCalls++;
      return route.fulfill({ headers, json: { processed: true, memoryChanged: false } });
    });
    await context.route('https://api.example.com/v1/coach/conversations/*/context', route => route.fulfill({ headers,
      json: { enabled: true, summaryAvailable: true, summary: 'Earlier decision: train two days each week.', maintenancePending: false, compactionWaiting: false } }));
    await openApp(page);
    await openCoach(page);
    await expect(page.getByText('Using earlier-chat summary.')).toBeVisible();
    await page.getByText('View earlier-chat summary', { exact: true }).click();
    await expect(page.getByText('Earlier decision: train two days each week.')).toBeVisible();
    await page.getByRole('link', { name: 'Today', exact: true }).click();
    const previous = maintenanceCalls;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => maintenanceCalls).toBeGreaterThan(previous);
  });

  test('edits and forgets memory using versions and disables automatic saving', async ({ page, context }) => {
    const headers = { 'Access-Control-Allow-Origin': 'http://localhost:4173', 'Access-Control-Allow-Headers': 'authorization,content-type,if-match', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
    let content = 'I prefer dumbbells.'; let automatic = true; let deleted = false; let version = 1;
    await context.route('https://api.example.com/v1/coach/memor**', async route => {
      const method = route.request().method();
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (method !== 'GET') {
        expect(route.request().headers()['if-match']).toBe(`"${version}"`);
        if (route.request().url().endsWith('/memory-settings')) automatic = route.request().postDataJSON().automatic;
        else if (method === 'PATCH') content = route.request().postDataJSON().content;
        else deleted = true;
        version++;
        return route.fulfill({ headers, status: method === 'DELETE' ? 204 : 200, json: method === 'DELETE' ? undefined : { saved: true } });
      }
      return route.fulfill({ headers, json: { enabled: true, automatic, etag: `"${version}"`, capacityReached: false,
        items: deleted ? [] : [{ id: 'memory-1', content, category: 'preference', edited: version > 1, updatedAt: new Date().toISOString(), etag: `"${version}"`, sources: [] }] } });
    });
    await openApp(page);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('I prefer dumbbells.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit memory', exact: true }).click();
    await page.getByLabel('Edit remembered fact').fill('I prefer barbells.');
    await page.getByRole('button', { name: 'Save memory', exact: true }).click();
    await expect(page.getByText('I prefer barbells.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Forget memory', exact: true }).click();
    await expect(page.getByText('No saved memories yet.')).toBeVisible();
    await page.getByLabel('Automatically save useful training facts').uncheck();
    await expect(page.getByLabel('Automatically save useful training facts')).not.toBeChecked();
    await expect.poll(() => automatic).toBe(false);
  });
});

test('phone task hierarchy keeps workout actions reachable and optional set tools available', async ({ page }) => {
  await openApp(page);
  await makePlan(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  const start = page.getByRole('button', { name: 'Start workout', exact: true });
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  const startBox = await start.boundingBox();
  const navBox = await navigation.boundingBox();
  expect(startBox).not.toBeNull(); expect(navBox).not.toBeNull();
  expect(startBox!.y + startBox!.height).toBeLessThan(navBox!.y);
  await start.click();
  await expect(navigation).toHaveCount(0);
  await expect(page.locator('.app-header')).toHaveCount(0);
  await expectUsable(page, page.getByRole('link', { name: 'Today', exact: true }));
  await expectUsable(page, page.locator('.workout-sync-link'));
  await expect(page.getByRole('spinbutton', { name: 'RPE set 1 Barbell squat', exact: true })).toBeHidden();
  await page.getByLabel('Set 1 options for Barbell squat', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'RPE set 1 Barbell squat', exact: true }).fill('8');
  await logSet(page, 1, '100', '8');
  await expect(page.getByRole('spinbutton', { name: 'RPE set 1 Barbell squat', exact: true })).toHaveValue('8');
  await expect(page.getByRole('button', { name: 'Delete set 1 Barbell squat', exact: true })).toBeVisible();
  await page.reload();
  await page.getByLabel('Set 1 options for Barbell squat', { exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'RPE set 1 Barbell squat', exact: true })).toHaveValue('8');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Finish workout', exact: true }).click();
  await page.getByRole('button', { name: 'Save completed workout', exact: true }).click();
  await page.getByRole('link', { name: /Strength A/ }).click();
  await expect(navigation).toBeVisible();
  await expect(page.locator('.app-header')).toBeVisible();
  await page.getByLabel('Set 1 options for Barbell squat', { exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'RPE set 1 Barbell squat', exact: true })).toHaveValue('8');
  await expect(page.getByRole('spinbutton', { name: 'RPE set 1 Barbell squat', exact: true })).toBeDisabled();
});

test('plan editor keeps Save reachable and protects unsaved changes', async ({ page }) => {
  await openApp(page);
  await makePlan(page);
  await openMainPage(page, 'Plan');
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Plan editor', exact: true });
  await dialog.getByLabel('Plan name', { exact: true }).fill('Unsaved plan title');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const saveBox = await dialog.getByRole('button', { name: 'Save plan', exact: true }).boundingBox();
  expect(saveBox).not.toBeNull();
  expect(saveBox!.y).toBeGreaterThan(0);
  expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  page.once('dialog', prompt => prompt.dismiss());
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(dialog.getByLabel('Plan name', { exact: true })).toHaveValue('Unsaved plan title');
  await dialog.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Unsaved plan title', exact: true })).toBeVisible();
});

async function expectUsable(page: Page, control: import('@playwright/test').Locator) {
  await expect.poll(async () => {
    await control.scrollIntoViewIfNeeded();
    return control.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return box.y >= 0 && box.bottom <= innerHeight && (element === hit || element.contains(hit));
    });
  }).toBe(true);
}

test('modal validation stays visible and weekday reassignment requires a choice', async ({ page }) => {
  await openApp(page);
  await openMainPage(page, 'Plan');
  await page.getByRole('button', { name: 'New plan', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Plan editor', exact: true });
  await editor.getByLabel('Plan name', { exact: true }).fill('');
  await editor.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Enter a plan name.');
  await expect(editor.getByRole('alert')).toBeFocused();
  await expect(editor.getByLabel('Plan name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await editor.getByLabel('Plan name', { exact: true }).fill('Schedule review');
  await editor.getByLabel('Workout name', { exact: true }).fill('Monday A');
  await editor.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Add at least one exercise');
  const monday = editor.getByRole('button', { name: 'Monday', exact: true });
  if (await monday.getAttribute('aria-pressed') !== 'true') await monday.click();
  await editor.getByRole('button', { name: 'Add workout', exact: true }).click();
  await editor.getByLabel('Workout name', { exact: true }).fill('Monday B');
  await editor.getByRole('button', { name: 'Monday', exact: true }).click();
  const move = page.getByRole('dialog', { name: 'Move training day?', exact: true });
  await expect(move).toContainText('Monday A');
  await move.getByRole('button', { name: 'Keep current schedule' }).click();
  await expect(editor.getByRole('button', { name: 'Monday', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await editor.getByRole('button', { name: 'Monday', exact: true }).click();
  await move.getByRole('button', { name: 'Move day', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Monday', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await editor.getByRole('button', { name: 'Monday A', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Monday', exact: true })).toHaveAttribute('aria-pressed', 'false');
  // Errors from nested forms must also stay inside their native dialog.
  await editor.getByRole('button', { name: 'Add exercise', exact: true }).click();
  await page.getByRole('button', { name: 'Create custom exercise', exact: true }).click();
  const exercise = page.getByRole('dialog', { name: 'Custom exercise', exact: true });
  await exercise.getByRole('button', { name: 'Save exercise', exact: true }).click();
  await expect(exercise.getByRole('alert')).toBeVisible();
  await expectUsable(page, exercise.getByRole('button', { name: 'Dismiss notification' }));
});

test('profile drafts survive navigation and reload without overwriting a changed profile', async ({ page }) => {
  await openApp(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('What are you working toward?').fill('Retained draft goal');
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('Retained draft goal');
  await page.reload();
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('Retained draft goal');
  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('fitcoach-user-e2e-user');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('profile', 'readwrite'), table = tx.objectStore('profile');
      const read = table.get('profile');
      read.onsuccess = () => table.put({ ...read.result, goals: 'Changed saved goal' });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('Retained draft goal');
  await page.getByRole('button', { name: 'Keep draft values', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Profile saved on this device' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('Retained draft goal');
});

test('workout and Coach controls stay unobscured, and repeat set requires confirmation', async ({ page }) => {
  await openApp(page); await makePlan(page);
  await page.getByRole('button', { name: 'Start workout', exact: true }).click();
  for (const size of [{ width: 320, height: 740 }, { width: 390, height: 480 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await expectUsable(page, page.getByRole('spinbutton', { name: 'Reps set 3 Barbell squat', exact: true }));
    await expectUsable(page, page.getByRole('button', { name: 'Finish workout', exact: true }));
    const back = page.getByRole('link', { name: 'Today', exact: true });
    const before = await back.boundingBox();
    await page.locator('.workout-page').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expectUsable(page, back);
    expect((await back.boundingBox())!.y).toBeCloseTo(before!.y, 0);
    await expectUsable(page, page.getByRole('button', { name: 'Finish workout', exact: true }));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await logSet(page, 1, '100', '8');
  const weight = page.getByRole('spinbutton', { name: 'Weight set 2 Barbell squat', exact: true });
  await expect(weight).toHaveValue('');
  await page.getByRole('button', { name: 'Repeat last set into set 2 Barbell squat', exact: true }).click();
  await expect(weight).toHaveValue('100');
  await expect(page.getByRole('spinbutton', { name: 'Reps set 2 Barbell squat', exact: true })).toHaveValue('8');
  await expect(page.getByRole('button', { name: 'Complete set 2 Barbell squat', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.reload(); await expect(weight).toHaveValue('100');
  await openCoach(page);
  await expectUsable(page, page.getByRole('button', { name: /Change my rest periods/ }));
  const input = page.getByLabel('Message Coach');
  await input.fill('First line'); await input.press('Enter'); await input.pressSequentially('Second line');
  await expect(input).toHaveValue('First line\nSecond line');
  await expectUsable(page, input);
  await expectUsable(page, page.getByRole('button', { name: 'Send message' }));
  const initialHeight = await input.evaluate(element => element.clientHeight);
  await input.fill(Array(8).fill('A longer training question').join('\n'));
  await expect.poll(() => input.evaluate(element => element.clientHeight)).toBeGreaterThan(initialHeight);
  for (const size of [{ width: 320, height: 740 }, { width: 390, height: 480 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await expectUsable(page, input);
    await expectUsable(page, page.getByRole('button', { name: 'Send message' }));
    await expectUsable(page, page.getByRole('link', { name: 'Today', exact: true }));
    await expectUsable(page, page.locator('.coach-sync-link'));
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    const pane = await page.locator('.coach-scroll').boundingBox();
    expect(pane!.height).toBeGreaterThan(size.height * .4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const composer = await page.locator('.chat-composer').boundingBox();
  const resume = await page.locator('.coach-resume').boundingBox();
  expect(resume!.y + resume!.height).toBeLessThanOrEqual(composer!.y);
});

test('selecting another workout explains the active session instead of redirecting', async ({ page }) => {
  await openApp(page); await makePlan(page);
  await page.getByRole('button', { name: 'Start workout', exact: true }).click();
  await logSet(page, 1, '100', '8');
  await openMainPage(page, 'Plan');
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  await page.getByRole('button', { name: 'Add workout', exact: true }).click();
  await page.getByLabel('Workout name', { exact: true }).fill('Strength B');
  await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose an exercise' }).getByRole('button', { name: /Barbell squat/ }).click();
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: /Strength B/ }).click();
  const blocked = page.getByRole('dialog', { name: 'Workout already in progress' });
  await expect(blocked).toContainText('Strength A is still in progress');
  await blocked.getByRole('button', { name: 'Review Strength B' }).click();
  await expect(page.getByRole('dialog', { name: 'Strength B', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('link', { name: /Resume/ }).last().click();
  await expect(page.getByRole('spinbutton', { name: 'Weight set 1 Barbell squat', exact: true })).toHaveValue('100');
});

test('large history keeps trends reachable and offers a searchable paginated journal', async ({ page }) => {
  await openApp(page); await makePlan(page);
  await page.getByRole('button', { name: 'Start workout', exact: true }).click(); await logSet(page, 1, '100', '8');
  await page.getByRole('button', { name: 'Finish workout', exact: true }).click();
  await page.getByRole('button', { name: 'Save completed workout', exact: true }).click();
  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('fitcoach-user-e2e-user'); request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('sessions', 'readwrite'), table = tx.objectStore('sessions');
      const read = table.getAll();
      read.onsuccess = () => { const original = read.result[0]; for (let i = 1; i <= 60; i++) { const date = new Date(); date.setDate(date.getDate() - i); table.put({ ...original, id: `history-fixture-${i}`, name: `Archive ${i}`, date: date.toISOString().slice(0, 10) }); } };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await expect(page.locator('.history-row')).toHaveCount(3);
  expect((await page.locator('.chart-card').boundingBox())!.y).toBeLessThan(1200);
  await page.getByRole('button', { name: 'View all 61 sessions' }).click();
  const journal = page.getByRole('dialog', { name: 'All sessions', exact: true });
  await expect(journal.locator('.history-row')).toHaveCount(20);
  await journal.getByRole('button', { name: 'Show more sessions' }).click();
  await expect(journal.locator('.history-row')).toHaveCount(40);
  await journal.getByLabel('Search sessions').fill('Archive 60');
  await expect(journal.locator('.history-row')).toHaveCount(1);
  await journal.getByRole('link', { name: /Archive 60/ }).click();
  await expect(page.getByRole('heading', { name: 'Archive 60', exact: true })).toBeVisible();
});

test('profile drafts stay isolated when switching accounts and remain recoverable', async ({ page }) => {
  await openApp(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('What are you working toward?').fill('Private account A draft');
  const switchAccount = async (id: string) => {
    await page.addInitScript(({ userId }) => {
      const key = 'sb-fitcoach-e2e-auth-token';
      const session = JSON.parse(localStorage.getItem(key)!);
      session.user.id = userId; session.user.email = `${userId}@example.com`;
      localStorage.setItem(key, JSON.stringify(session));
    }, { userId: id });
    await page.reload();
  };
  await switchAccount('e2e-other-user');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('');
  await page.getByLabel('What are you working toward?').fill('Private account B draft');
  await switchAccount('e2e-user');
  await expect(page.getByLabel('What are you working toward?')).toHaveValue('Private account A draft');
});


test('phone day choices preserve touch targets without horizontal page overflow', async ({ page }) => {
  await openApp(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  for (const day of await page.locator('#training-profile .day-picker button').all()) {
    const box = await day.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  for (const day of await page.locator('.week-strip button').all()) {
    const box = await day.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.locator('#main-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

async function readPlans(page: Page) {
  return page.evaluate(async () => new Promise<string>((resolve, reject) => {
    const request = indexedDB.open('fitcoach-user-e2e-user');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('plans', 'readonly');
      const read = transaction.objectStore('plans').getAll();
      transaction.oncomplete = () => { database.close(); resolve(JSON.stringify(read.result)); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  }));
}

async function waitForOfflineInstall(page: Page) {
  // A fresh browser context must finish precaching before an offline reload.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

test('workout choice starts Upper offline out of rotation and offers another session', async ({ page, context }) => {
  await openApp(page); await makePlan(page);
  await openMainPage(page, 'Plan');
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  await page.getByLabel('Workout name', { exact: true }).fill('Push');
  for (const name of ['Pull', 'Upper']) {
    await page.getByRole('button', { name: 'Duplicate workout', exact: true }).click();
    await page.getByLabel('Workout name', { exact: true }).fill(name);
  }
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Push', exact: true })).toBeVisible();
  const before = await readPlans(page);
  await waitForOfflineInstall(page);
  await context.setOffline(true);
  const library = page.getByRole('region', { name: 'Your routines', exact: true });
  await expectUsable(page, library.getByRole('button', { name: 'Start Upper from My strength plan', exact: true }));
  await library.getByRole('button', { name: 'Start Upper from My strength plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Upper', exact: true })).toBeVisible();
  await logSet(page, 1, '80', '8');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Upper', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Weight set 1 Barbell squat', exact: true })).toHaveValue('80');
  await page.getByRole('button', { name: 'Finish workout', exact: true }).click();
  await page.getByRole('button', { name: 'Save completed workout', exact: true }).click();
  expect(await readPlans(page)).toBe(before);
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Start another session', exact: true }).click();
  await page.getByRole('button', { name: 'Start Pull from My strength plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pull', exact: true })).toBeVisible();
  await context.setOffline(false);
});

test('workout choice starts an unscheduled workout on a rest day without rescheduling', async ({ page }) => {
  await openApp(page); await makePlan(page);
  await openMainPage(page, 'Plan');
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  await page.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('week');
  await page.getByLabel('Workout name', { exact: true }).fill('Push');
  await page.getByRole('button', { name: 'Duplicate workout', exact: true }).click();
  await page.getByLabel('Workout name', { exact: true }).fill('Upper');
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await page.locator('.week-strip').getByRole('button', { name: /^Sunday/ }).click();
  await expect(page.locator('.rest-card').getByRole('heading', { name: 'Choose what you want to train', exact: true })).toBeVisible();
  const before = await readPlans(page);
  await page.getByRole('button', { name: 'Start Upper from My strength plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Upper', exact: true })).toBeVisible();
  await logSet(page, 1, '80', '8');
  await page.getByRole('button', { name: 'Finish workout', exact: true }).click();
  await page.getByRole('button', { name: 'Save completed workout', exact: true }).click();
  expect(await readPlans(page)).toBe(before);
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await page.locator('.week-strip').getByRole('button', { name: /^Sunday/ }).click();
  await expect(page.getByRole('heading', { name: 'Upper', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start another session', exact: true }).click();
  await expectUsable(page, page.getByRole('button', { name: 'Start Push from My strength plan', exact: true }));
});

test('Today lists current-plan routines first and starts saved-plan blueprints without activating them', async ({ page, context }) => {
  await openApp(page); await makePlan(page);
  await openMainPage(page, 'Plan');
  await page.getByRole('button', { name: 'New plan', exact: true }).click();
  await page.getByLabel('Plan name', { exact: true }).fill('Other routines');
  await page.getByLabel('Workout name', { exact: true }).fill('Full upper');
  await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose an exercise' }).getByRole('button', { name: /Barbell squat/ }).click();
  await page.getByRole('button', { name: 'Duplicate workout', exact: true }).click();
  await page.getByLabel('Workout name', { exact: true }).fill('Travel');
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.locator('.routine-group-heading h3')).toHaveText(['My strength plan', 'Other routines']);
  await expect(page.locator('.routine-group').first()).toContainText('Current plan');
  await expect(page.locator('.routine-group').last().getByRole('button')).toHaveCount(2);
  expect(await page.locator('#today-workouts').evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('.calendar-section')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  const before = await readPlans(page);
  const source = JSON.parse(before).find((plan: { name: string }) => plan.name === 'Other routines');
  expect(source.active).toBe(false);
  await waitForOfflineInstall(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Start Full upper from Other routines', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Full upper', exact: true })).toBeVisible();
  await logSet(page, 1, '80', '8');
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Start Strength A from My strength plan', exact: true }).click();
  const blocked = page.getByRole('dialog', { name: 'Workout already in progress', exact: true });
  await expect(blocked).toContainText('Full upper is still in progress');
  await blocked.getByRole('link', { name: 'Resume Full upper', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: 'Weight set 1 Barbell squat', exact: true })).toHaveValue('80');
  const saved = await page.evaluate(async () => new Promise<{ planId: string; workoutId: string }>((resolve, reject) => {
    const request = indexedDB.open('fitcoach-user-e2e-user');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction('sessions', 'readonly');
      const read = transaction.objectStore('sessions').getAll();
      transaction.oncomplete = () => { database.close(); resolve(read.result[0]); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  }));
  expect(saved.planId).toBe(source.id);
  expect(saved.workoutId).toBe(source.workouts[0].id);
  await page.getByRole('button', { name: 'Finish workout', exact: true }).click();
  await page.getByRole('button', { name: 'Save completed workout', exact: true }).click();
  expect(await readPlans(page)).toBe(before);
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.locator('.routine-group-heading h3')).toHaveText(['My strength plan', 'Other routines']);
  await context.setOffline(false);
});

test('finishing an accidental workout offers discard and retains an uncompleted draft until confirmed', async ({ page, context }) => {
  await openApp(page); await makePlan(page);
  const before = await readPlans(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Start workout', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Weight set 1 Barbell squat', exact: true }).fill('60');
  await page.getByRole('spinbutton', { name: 'Reps set 1 Barbell squat', exact: true }).fill('8');
  await page.getByRole('button', { name: 'Finish workout', exact: true }).click();
  let discard = page.getByRole('dialog', { name: 'Discard this workout?', exact: true });
  await expect(discard).toContainText('No sets have been logged');
  await expect(discard).toContainText('Any entered weights, reps, and notes');
  await expect(discard.getByRole('button', { name: 'Save completed workout', exact: true })).toHaveCount(0);
  await discard.getByRole('button', { name: 'Keep workout', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: 'Weight set 1 Barbell squat', exact: true })).toHaveValue('60');
  await expect(page.getByRole('spinbutton', { name: 'Reps set 1 Barbell squat', exact: true })).toHaveValue('8');
  await page.getByRole('button', { name: 'Finish workout', exact: true }).click();
  discard = page.getByRole('dialog', { name: 'Discard this workout?', exact: true });
  await discard.getByRole('button', { name: 'Discard workout', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Start workout', exact: true })).toBeVisible();
  expect(await readPlans(page)).toBe(before);
  const remaining = await page.evaluate(async () => new Promise<{ sessions: number; recoveries: number; mutations: number }>((resolve, reject) => {
    const request = indexedDB.open('fitcoach-user-e2e-user');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction(['sessions', 'sync', 'outbox'], 'readonly');
      const sessions = transaction.objectStore('sessions').getAll();
      const sync = transaction.objectStore('sync').getAll();
      const outbox = transaction.objectStore('outbox').getAll();
      transaction.oncomplete = () => {
        database.close();
        resolve({ sessions: sessions.result.length,
          recoveries: sync.result.filter(item => item.kind === 'recovery' && item.entity === 'sessions' && item.payload.blocks[0].sets[0].reps === 8).length,
          mutations: outbox.result.filter(item => item.entity === 'sessions').length });
      };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  }));
  expect(remaining).toEqual({ sessions: 0, recoveries: 1, mutations: 0 });
  await context.setOffline(false);
});

test('training preferences persist offline and each workout owns its duration target', async ({ page, context }, info) => {
  await openApp(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Session length', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Training background (optional)', exact: true }).fill('Returning after a year away');
  await page.getByRole('combobox', { name: 'Usual training days per week (optional)', exact: true }).selectOption('4');
  await page.getByText('Exercise preferences & limitations (optional)', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Exercise preferences', exact: true }).fill('Prefer dumbbells and cables');
  await page.getByRole('textbox', { name: 'Limitations or alternatives needed', exact: true }).fill('Prefer alternatives to overhead pressing');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#training-profile .save-status')).toHaveText('Profile saved on this device');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Training background (optional)', exact: true })).toHaveValue('Returning after a year away');
  await expect(page.getByRole('combobox', { name: 'Usual training days per week (optional)', exact: true })).toHaveValue('4');
  await page.getByText('Exercise preferences & limitations (optional)', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Exercise preferences', exact: true })).toHaveValue('Prefer dumbbells and cables');
  await expect(page.getByRole('textbox', { name: 'Limitations or alternatives needed', exact: true })).toHaveValue('Prefer alternatives to overhead pressing');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const originalViewport = page.viewportSize()!;
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport);
    expect(await page.locator('#main-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.setViewportSize(originalViewport);
  await page.screenshot({ path: info.outputPath('training-profile.png'), fullPage: true });

  await makePlan(page);
  await expect(page.getByText(/45 min target/)).toHaveCount(0);
  await openMainPage(page, 'Plan');
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  const duration = page.getByLabel('Workout duration target (minutes, optional)', { exact: true });
  await duration.fill('35');
  await page.getByRole('button', { name: 'Duplicate workout', exact: true }).click();
  await page.getByLabel('Workout name', { exact: true }).fill('Upper body');
  await duration.fill('70');
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(page.getByText('1 exercises · 35 min target', { exact: true })).toBeVisible();
  await expect(page.getByText('1 exercises · 70 min target', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.locator('.hero-meta').getByText('35 min target', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.hero-meta').getByText('35 min target', { exact: true })).toBeVisible();
  await openMainPage(page, 'Plan');
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  await expect(duration).toHaveValue('35');
  await duration.fill('');
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.locator('.hero-meta')).not.toContainText('min target');
  await page.screenshot({ path: info.outputPath('workout-duration.png'), fullPage: true });
  await context.setOffline(false);
});

test('Coach shows the sent message immediately and streams the reply before completion', async ({ page, context }) => {
  mockConversations(context);
  await context.route('https://api.example.com/v1/chatgpt/**', route => route.fulfill({
    json: { connected: true, planUsageGranted: true },
    headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173' },
  }));
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      if (String(args[0]).endsWith('/v1/chatgpt/coach')) {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({ start(controller) {
          document.documentElement.dataset.coachStreamReady = 'true';
          const emit = (event: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          window.addEventListener('coach-test-delta', () => emit({ type: 'delta', text: 'Start with two' }), { once: true });
          window.addEventListener('coach-test-complete', () => {
            emit({ type: 'completed', reply: { text: 'Start with two training days.', messageId: 'saved-assistant', userMessageId: 'saved-user' } });
            controller.close();
          }, { once: true });
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return original(...args);
    };
  });
  await openApp(page); await openCoach(page);
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible();
  await page.getByLabel('Message Coach').fill('How should I begin?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message.user')).toHaveText('How should I begin?');
  await expect(page.getByLabel('Message Coach')).toHaveValue('');
  await expect(page.getByLabel('Preparing Coach response')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-coach-stream-ready', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('coach-test-delta')));
  await expect(page.locator('.message.assistant .message-markdown')).toHaveText('Start with two');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('coach-test-complete')));
  await expect(page.locator('.message.assistant .message-markdown')).toHaveText('Start with two training days.');
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await expect(page.locator('.messages')).toHaveAttribute('aria-busy', 'false');
});
