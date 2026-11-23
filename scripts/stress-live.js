// CI stress test against real feeds: no proxy has to pass, but no invalid proxy
// should be able to terminate the process. The test emits summary annotations.
import { scrapeSources } from '../src/scraper.js';
import { validateProxies } from '../src/validator.js';
function fail(error) {
  console.error(`::error::${String(error?.stack || error).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  process.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const timer = setTimeout(() => fail(new Error('Live stress test exceeded 3 minutes')), 180000);
try {
  const result = await scrapeSources({ limit: 20000, timeout: 10000 });
  if (!result.successes || !result.proxies.length) throw new Error('No sources were reachable');
  console.log(`::notice::Stress: fetched ${result.proxies.length} proxies from ${result.successes}/${result.total} feeds`);
  let count = 0; const started = Date.now();
  const valid = await validateProxies(result.proxies, { concurrency: 2000, timeout: 4000, onBatch: (_items, size) => { count += size; } });
  const rate = Math.round(count / Math.max(0.001, (Date.now() - started) / 1000));
  if (count !== result.proxies.length) throw new Error('Not all candidates were checked');
  console.log(`::notice::Stress completed: ${count} checked, ${valid.length} passed, ${rate} checks/sec average`);
} catch (error) { fail(error); }
finally { clearTimeout(timer); }
