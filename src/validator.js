import axios from 'axios';
import { BoundedHttpProxyAgent } from './httpProxyAgent.js';
import { SafeSocksProxyAgent } from './safeSocksProxyAgent.js';
import pLimit from 'p-limit';

export async function validateProxy(proxy, { echoUrl = 'https://api.ipify.org?format=json', timeout = 4000 } = {}) {
  const started = performance.now(); let agent;
  try {
    agent = proxy.protocol.startsWith('socks') ? new SafeSocksProxyAgent(proxy.url, { timeout }) : new BoundedHttpProxyAgent(proxy.url, { timeout });
    const response = await axios.get(echoUrl, { httpAgent: agent, httpsAgent: agent, proxy: false, timeout, signal: AbortSignal.timeout(timeout), maxRedirects: 0, maxContentLength: 65536 });
    const ip = typeof response.data === 'string' ? response.data.trim() : (response.data.ip ?? response.data.origin);
    // This checks the observed exit address, not all possible header leaks or identity linkage.
    if (typeof ip !== 'string' || !ip.split(',').map(s => s.trim()).includes(proxy.host) || ip.includes(',')) return null;
    return { ...proxy, latencyMs: Math.round(performance.now() - started), anonymity: 'exit-ip-match', lastChecked: new Date().toISOString() };
  } catch { return null; } finally { agent?.destroy(); }
}
export async function validateProxies(proxies, options = {}) {
  const concurrency = options.concurrency ?? 500, limit = pLimit(concurrency), valid = [];
  const check = options.checkProxy ?? validateProxy;
  const batchSize = options.progressBatchSize ?? 100;
  let next = 0, pendingCount = 0, pending = [], flushChain = Promise.resolve();
  function flush() {
    if (!pendingCount) return flushChain;
    const batch = pending, checked = pendingCount; pending = []; pendingCount = 0;
    if (options.onBatch) flushChain = flushChain.then(() => options.onBatch(batch, checked));
    return flushChain;
  }
  // Each worker immediately takes another item when its check finishes; a single
  // slow proxy no longer holds an entire batch hostage. Only O(concurrency)
  // promises are active, even for very large lists.
  const workers = Array.from({ length: Math.min(concurrency, proxies.length) }, async () => {
    while (next < proxies.length) {
      const proxy = proxies[next++];
      const result = await limit(() => check(proxy, options)).catch(() => null);
      if (result) { valid.push(result); pending.push(result); }
      pendingCount++;
      if (pendingCount >= batchSize) await flush();
    }
  });
  await Promise.all(workers);
  await flush();
  return valid.sort((a, b) => a.latencyMs - b.latencyMs);
}
