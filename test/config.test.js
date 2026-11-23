import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('refresh interval defaults to 20 seconds and supports existing minute settings', () => {
  const names = ['PROXY_USER', 'PROXY_PASS', 'API_KEY', 'SCRAPE_INTERVAL_SECONDS', 'SCRAPE_INTERVAL_MINUTES'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.PROXY_USER = 'user'; process.env.PROXY_PASS = 'pass'; process.env.API_KEY = 'key';
    delete process.env.SCRAPE_INTERVAL_SECONDS; delete process.env.SCRAPE_INTERVAL_MINUTES;
    assert.equal(loadConfig().scrapeIntervalSeconds, 20);
    process.env.SCRAPE_INTERVAL_MINUTES = '1'; assert.equal(loadConfig().scrapeIntervalSeconds, 60);
    process.env.SCRAPE_INTERVAL_SECONDS = '20'; assert.equal(loadConfig().scrapeIntervalSeconds, 20);
    process.env.SCRAPE_INTERVAL_SECONDS = '0'; assert.throws(() => loadConfig(), /Invalid SCRAPE_INTERVAL_SECONDS/);
  } finally { for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]; }
});
