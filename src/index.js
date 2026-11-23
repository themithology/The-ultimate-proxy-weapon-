import cron from 'node-cron';
import { loadConfig } from './config.js';
import { ProxyPool } from './pool.js';
import { scrapeSources } from './scraper.js';
import { validateProxies } from './validator.js';
import { createProxyServer } from './proxyServer.js';
import { createApi } from './apiServer.js';

const config = loadConfig();
const pool = new ProxyPool({ rotation: config.rotation, healthBaselineRequests: config.healthBaselineRequests, healthWindow: config.healthWindow, healthRetentionRatio: config.healthRetentionRatio, maxSize: config.maxPoolSize, cooldownMs: config.proxyCooldownMs });
await pool.load();
let busy = false;
const cursorBySource = new Map();
const sourceCooldowns = new Map();
const cycleStatus = { busy: false, type: null, startedAt: null, lastCompletedAt: null, error: null };
function cycle(scrape) {
  if (busy) return false;
  busy = true;
  Object.assign(cycleStatus, { busy: true, type: scrape ? 'refresh' : 'revalidation', stage: scrape ? 'fetching' : 'validating', validationStartedAt: null, sourcesCompleted: 0, sourcesTotal: 0, sourcesSucceeded: 0, candidates: 0, checked: 0, found: 0, startedAt: new Date().toISOString(), error: null });
  (async () => {
    const revision = pool.revision;
    let candidates = pool.list();
    if (scrape) {
      const result = await scrapeSources({ timeout: config.scrapeTimeout, limit: config.maxCandidates, cursorBySource, sourceCooldowns,
        onProgress: ({ completed, total, successes }) => Object.assign(cycleStatus, { sourcesCompleted: completed, sourcesTotal: total, sourcesSucceeded: successes }) });
      pool.lastScrape = new Date().toISOString();
      // A feed outage must not erase a previously usable pool.
      if (!result.successes) throw new Error('All sources failed; preserving existing pool');
      // Always recheck the old pool as well as a diverse sample of fresh feeds.
      candidates = [...new Map([...pool.list(), ...result.proxies].map(proxy => [proxy.url, proxy])).values()];
      console.log(`Scraped ${candidates.length} unique proxies from ${result.successes}/${result.total} sources`);
    }
    Object.assign(cycleStatus, { stage: 'validating', candidates: candidates.length, validationStartedAt: new Date().toISOString() });
    // Publish successful batches early only when starting from an empty pool.
    // Existing pools stay available until the replacement has been fully checked.
    const publishEarly = pool.list().length === 0;
    const partial = [];
    const valid = await validateProxies(candidates, {
      concurrency: config.concurrency, timeout: config.timeout, echoUrl: config.echoUrl,
      onBatch: async (passed, checked) => {
        cycleStatus.checked += checked;
        cycleStatus.found += passed.length;
        if (publishEarly) {
          partial.push(...passed);
          if (passed.length) await pool.replace(partial.filter(p => (pool.evictions.get(p.url) ?? 0) <= revision));
        }
      },
    });
    const stillHealthy = valid.filter(p => (pool.evictions.get(p.url) ?? 0) <= revision);
    await pool.replace(stillHealthy);
    for (const [url, evictedAt] of pool.evictions) if (evictedAt <= revision) pool.evictions.delete(url);
    console.log(`Validated ${stillHealthy.length}/${candidates.length} proxies`);
  })().catch(error => { cycleStatus.error = error.message; console.error('Cycle failed:', error); }).finally(() => { busy = false; cycleStatus.busy = false; cycleStatus.stage = 'idle'; cycleStatus.lastCompletedAt = new Date().toISOString(); });
  return true;
}
const proxy = createProxyServer(pool, config);
await proxy.listen();
const api = createApi(pool, config, () => cycle(true), () => ({ ...cycleStatus })).listen(config.apiPort, config.host, () => console.log(`API listening on ${config.host}:${config.apiPort}`));
api.on('error', error => { console.error('API server failed:', error); proxy.close(true).finally(() => process.exit(1)); });
console.log(`Gateway listening on ${config.proxyHost}:${config.proxyPort}`);
// Interval ticks never overlap an active cycle; busy ticks are skipped.
const refreshTimer = setInterval(() => cycle(true), config.scrapeIntervalSeconds * 1000);
const revalidationJob = cron.schedule('1-59/5 * * * *', () => cycle(false));
cycle(true);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { clearInterval(refreshTimer); revalidationJob.stop(); api.close(); await proxy.close(true); process.exit(0); });
