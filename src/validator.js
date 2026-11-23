import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import pLimit from 'p-limit';

export async function validateProxy(proxy, { echoUrl = 'https://api.ipify.org?format=json', timeout = 4000 } = {}) {
  const started = performance.now(); let agent;
  try {
    agent = proxy.protocol.startsWith('socks') ? new SocksProxyAgent(proxy.url) : new HttpsProxyAgent(proxy.url);
    const response = await axios.get(echoUrl, { httpAgent: agent, httpsAgent: agent, proxy: false, timeout, signal: AbortSignal.timeout(timeout), maxRedirects: 0, maxContentLength: 65536 });
    const ip = typeof response.data === 'string' ? response.data.trim() : (response.data.ip ?? response.data.origin);
    // This checks the observed exit address, not all possible header leaks or identity linkage.
    if (typeof ip !== 'string' || !ip.split(',').map(s => s.trim()).includes(proxy.host) || ip.includes(',')) return null;
    return { ...proxy, latencyMs: Math.round(performance.now() - started), anonymity: 'exit-ip-match', lastChecked: new Date().toISOString() };
  } catch { return null; } finally { agent?.destroy(); }
}
export async function validateProxies(proxies, options = {}) {
  const concurrency = options.concurrency ?? 300, limit = pLimit(concurrency), valid = [];
  // Only create one batch of promises at a time rather than queueing every endpoint.
  for (let i = 0; i < proxies.length; i += concurrency) {
    const batch = await Promise.all(proxies.slice(i, i + concurrency).map(proxy => limit(() => validateProxy(proxy, options))));
    const passed = batch.filter(Boolean);
    valid.push(...passed);
    if (options.onBatch) await options.onBatch(passed);
  }
  return valid.sort((a, b) => a.latencyMs - b.latencyMs);
}
