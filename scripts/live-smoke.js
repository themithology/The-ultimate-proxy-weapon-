// Opt-in integration test: downloads public lists and sends traffic through public proxies.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scrapeSources } from '../src/scraper.js';
import { validateProxies } from '../src/validator.js';
import { ProxyPool } from '../src/pool.js';
import { createProxyServer } from '../src/proxyServer.js';
import { createApi } from '../src/apiServer.js';
import http from 'node:http';

const curl = promisify(execFile);
const report = message => { console.log(message); if (process.env.GITHUB_ACTIONS) console.log(`::notice::${message}`); };
let phase = 'starting';
const deadline = setTimeout(() => { console.error(`::error::Live test exceeded 4 minutes during ${phase}`); process.exit(1); }, 240_000);
deadline.unref();
const limit = Number(process.env.LIVE_SAMPLE_SIZE || 1200);
if (!Number.isInteger(limit) || limit < 1 || limit > 20000) throw new Error('Invalid LIVE_SAMPLE_SIZE');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'live-proxies-'));
let gateway, api;
try {
  phase = 'fetching feeds'; report(`Live test: ${phase}`);
  const result = await scrapeSources();
  report(`Feed fetches: ${result.successes}/${result.total}; unique endpoints: ${result.proxies.length}`);
  if (result.successes < 1 || !result.proxies.length) throw new Error('No usable feed data');
  // Distribute the sample across protocols and across the whole feed, not just
  // the first (often stale or homogeneous) entries of one source.
  const groups = ['http', 'https', 'socks4', 'socks5'].map(protocol => result.proxies.filter(p => p.protocol === protocol));
  const perGroup = Math.ceil(limit / groups.length);
  const candidates = groups.flatMap(group => {
    const count = Math.min(group.length, perGroup);
    return Array.from({ length: count }, (_, i) => group[Math.floor(i * group.length / count)]);
  }).slice(0, limit);
  phase = 'validating proxies';
  report(`Testing ${candidates.length} sampled proxies: ${groups.map((g, i) => `${['http','https','socks4','socks5'][i]}=${g.length}`).join(', ')}`);
  let batches = 0;
  const verified = await validateProxies(candidates, { concurrency: 300, timeout: 4000, onBatch: batch => report(`Validation batch ${++batches}: ${batch.length} passed`) });
  report(`Validated: ${verified.length} (${['http', 'https', 'socks4', 'socks5'].map(p => `${p}=${verified.filter(v => v.protocol === p).length}`).join(', ')})`);
  if (!verified.length) throw new Error('No sampled public proxies passed validation; this may be transient, but the live test cannot pass');
  phase = 'starting gateway and API';
  const pool = new ProxyPool({ directory }); await pool.load(); await pool.replace(verified);
  const config = { host: '127.0.0.1', proxyPort: 0, proxyUser: 'live-test', proxyPass: 'live-test', apiKey: 'live-test', timeout: 4000 };
  gateway = createProxyServer(pool, config); await gateway.listen();
  api = http.createServer(createApi(pool, config, () => true));
  await new Promise((resolve, reject) => { api.once('error', reject); api.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${api.address().port}`;
  const health = await (await fetch(`${base}/health`)).json();
  const file = await (await fetch(`${base}/proxies.txt`, { headers: { 'x-api-key': 'live-test' } })).text();
  if (health.activeProxyCount !== verified.length || file.trim().split('\n').length !== verified.length) throw new Error('API and file counts did not match validated pool');
  const json = await (await fetch(`${base}/proxies.json`, { headers: { 'x-api-key': 'live-test' } })).json();
  if (json.length !== verified.length) throw new Error('JSON API count mismatch');
  const proxyUrl = `http://live-test:live-test@127.0.0.1:${gateway.server.address().port}`;
  phase = 'testing gateway CONNECT'; report(`Live test: ${phase}`);
  let succeeded = false;
  // Public endpoints can die between validation and this request; try several.
  for (const candidate of verified.slice(0, 20)) {
    await pool.replace([candidate]);
    try {
      const { stdout } = await curl('curl', ['--silent', '--show-error', '--fail', '--max-time', '12', '--noproxy', '', '-x', proxyUrl, 'https://api.ipify.org?format=json'], { timeout: 15000 });
      const ip = JSON.parse(stdout).ip;
      if (ip !== candidate.host) throw new Error('Gateway returned an unexpected exit IP');
      report(`Live gateway CONNECT succeeded through ${candidate.protocol} proxy; exit IP matched.`);
      succeeded = true; break;
    } catch (error) { console.warn(`Gateway attempt via ${candidate.protocol} failed: ${error.message.split('\n')[0]}`); }
  }
  if (!succeeded) throw new Error('No validated proxy completed a real gateway CONNECT');
} finally {
  clearTimeout(deadline);
  if (api) await new Promise(resolve => api.close(resolve));
  if (gateway) await gateway.close(true);
  await fs.rm(directory, { recursive: true, force: true });
}
