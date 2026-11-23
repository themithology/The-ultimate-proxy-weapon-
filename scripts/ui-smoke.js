// Run in CI after installing Playwright and Chromium. Use a non-localhost HTTP
// origin so the browser actually enforces mixed-content upgrade policies.
import { chromium } from 'playwright';
import http from 'node:http';
import { createApi } from '../src/apiServer.js';
import { ProxyPool } from '../src/pool.js';
import assert from 'node:assert/strict';

const pool = new ProxyPool();
pool.proxies = [{ url: 'http://1.2.3.4:8080', protocol: 'http', host: '1.2.3.4', port: 8080, latencyMs: 42, lastChecked: new Date().toISOString() }];
let refreshes = 0;
const server = http.createServer(createApi(pool, { apiKey: 'test', proxyPort: 8080 }, () => { refreshes++; return true; }));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP dashboard.test 127.0.0.1'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const failures = [];
  page.on('pageerror', err => failures.push(err.message));
  await page.goto(`http://dashboard.test:${server.address().port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#active-count').textContent === '1');
  assert.equal(await page.locator('#connection-status').textContent(), 'SYSTEM ONLINE');
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(11, 15, 14)', 'stylesheet should apply over HTTP');
  assert.equal(await page.locator('#proxy-rows tr').count(), 1);
  assert.equal(await page.locator('#developer-title').textContent(), 'Endpoint integration guide');
  assert.ok((await page.locator('#node-example').textContent()).includes(`http://dashboard.test:${server.address().port}`));
  await page.locator('[data-filter="socks5"]').click();
  assert.equal(await page.locator('#proxy-rows tr').count(), 0);
  await page.locator('[data-filter="all"]').click();
  await page.locator('#refresh').click();
  assert.equal(refreshes, 1);
  assert.deepEqual(failures, []);
  console.log('Mobile browser dashboard loaded with CSS, data, filters and refresh over HTTP.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
