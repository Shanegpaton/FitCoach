import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('record IndexedDB query and transactional save timings at increasing history sizes', async ({ page, browser }) => {
  const cpuRate = Number(process.env.FITCOACH_BENCHMARK_CPU_RATE ?? 1);
  if (!Number.isFinite(cpuRate) || cpuRate < 1) throw new Error('CPU rate must be at least 1');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  await page.goto('/benchmarks/runner.html');
  await page.waitForFunction(() => typeof window.runBenchmark === 'function');
  const results = [];
  for (const size of [100, 1000, 5000]) results.push(await page.evaluate(size => window.runBenchmark(size), size));
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    browser: browser.version(), platform: process.platform, cpuRate, warmups: 1, samples: 20,
    scope: 'Warm IndexedDB queries and transactional local saves; excludes rendering, cold startup, networking and fixture creation. Timings are observations, not universal budgets.', results };
  mkdirSync('benchmark-results', { recursive: true });
  writeFileSync('benchmark-results/history.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
