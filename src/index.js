import cron from 'node-cron';
import { loadConfig } from './config.js';
import { ProxyPool } from './pool.js';
import { scrapeSources } from './scraper.js';
import { validateProxies } from './validator.js';
import { createProxyServer } from './proxyServer.js';
import { createApi } from './apiServer.js';

const config = loadConfig();
const pool = new ProxyPool({ rotation: config.rotation, healthBaselineRequests: config.healthBaselineRequests, healthWindow: config.healthWindow, healthRetentionRatio: config.healthRetentionRatio });
await pool.load();
let busy = false;
const cycleStatus = { busy: false, type: null, startedAt: null, lastCompletedAt: null, error: null };
function cycle(scrape) {
  if (busy) return false;
  busy = true;
  Object.assign(cycleStatus, { busy: true, type: scrape ? 'refresh' : 'revalidation', startedAt: new Date().toISOString(), error: null });
  (async () => {
    const revision = pool.revision;
    let candidates = pool.list();
    if (scrape) {
      const result = await scrapeSources({ timeout: config.scrapeTimeout });
      pool.lastScrape = new Date().toISOString();
      // A feed outage must not erase a previously usable pool.
      if (!result.successes) throw new Error('All sources failed; preserving existing pool');
      candidates = result.proxies;
      console.log(`Scraped ${candidates.length} unique proxies from ${result.successes}/${result.total} sources`);
    }
    // Publish successful batches early only when starting from an empty pool.
    // Existing pools stay available until the replacement has been fully checked.
    const publishEarly = pool.list().length === 0;
    const partial = [];
    const valid = await validateProxies(candidates, {
      concurrency: config.concurrency, timeout: config.timeout, echoUrl: config.echoUrl,
      onBatch: publishEarly ? async passed => {
        partial.push(...passed);
        if (passed.length) await pool.replace(partial.filter(p => (pool.evictions.get(p.url) ?? 0) <= revision));
      } : undefined,
    });
    const stillHealthy = valid.filter(p => (pool.evictions.get(p.url) ?? 0) <= revision);
    await pool.replace(stillHealthy);
    pool.evictions.clear();
    console.log(`Validated ${stillHealthy.length}/${candidates.length} proxies`);
  })().catch(error => { cycleStatus.error = error.message; console.error('Cycle failed:', error); }).finally(() => { busy = false; cycleStatus.busy = false; cycleStatus.lastCompletedAt = new Date().toISOString(); });
  return true;
}
const proxy = createProxyServer(pool, config);
await proxy.listen();
const api = createApi(pool, config, () => cycle(true), () => ({ ...cycleStatus })).listen(config.apiPort, config.host, () => console.log(`API listening on ${config.host}:${config.apiPort}`));
api.on('error', error => { console.error('API server failed:', error); proxy.close(true).finally(() => process.exit(1)); });
console.log(`Gateway listening on ${config.proxyHost}:${config.proxyPort}`);
const jobs = [cron.schedule('*/15 * * * *', () => cycle(true)), cron.schedule('*/5 * * * *', () => cycle(false))];
cycle(true);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { jobs.forEach(job => job.stop()); api.close(); await proxy.close(true); process.exit(0); });
