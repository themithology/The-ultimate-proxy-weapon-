import axios from 'axios';
import { BoundedHttpProxyAgent } from './httpProxyAgent.js';
import { SafeSocksProxyAgent } from './safeSocksProxyAgent.js';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// A path-based HTTP fetch API, not a standard CONNECT forward proxy.
export function createFetchHandler(pool, { timeout = 20000, maxBytes = 10 * 1024 * 1024, maxConcurrent = 50 } = {}) {
  let inFlight = 0;
  return async (req, res) => {
    if (typeof req.query.url !== 'string') return res.status(400).json({ error: 'Provide a target with ?url=https%3A%2F%2Fexample.com' });
    let target;
    try { target = new URL(req.query.url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      return res.status(400).json({ error: 'Only HTTP(S) URLs without embedded credentials are supported' });
    if (inFlight >= maxConcurrent) return res.status(503).json({ error: 'Too many fetch requests; retry later' });
    const upstream = pool.select();
    if (!upstream) return res.status(503).json({ error: 'No working proxies in the pool' });
    inFlight++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    let clientGone = false;
    const abortOnClose = () => { if (!res.writableFinished) { clientGone = true; controller.abort(); } };
    res.once('close', abortOnClose);
    let agent, observed = false;
    try {
      agent = upstream.protocol.startsWith('socks') ? new SafeSocksProxyAgent(upstream.url, { timeout }) : new BoundedHttpProxyAgent(upstream.url, { timeout });
      const response = await axios.get(target.href, { httpAgent: agent, httpsAgent: agent, proxy: false, responseType: 'stream',
        signal: controller.signal, timeout, maxRedirects: 0, validateStatus: () => true });
      if (response.status < 200 || response.status >= 300)
        pool.remove(upstream.url).catch(error => console.error('Failed to persist pool:', error));
      res.status(response.status);
      // Do not forward cookies, redirects, or arbitrary origin headers onto the dashboard domain.
      if (response.headers['content-type']) res.set('Content-Type', response.headers['content-type']);
      res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' });
      if (response.headers.location) res.set('X-Upstream-Location', response.headers.location);
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) callback(new Error('Response exceeds size limit')); else callback(null, chunk);
      }});
      await pipeline(response.data, limiter, res);
      observed = true;
      if (response.status >= 200 && response.status < 300) pool.recordOutcome(upstream.url, true);
    } catch (error) {
      if (!observed && !clientGone && !res.writableFinished) pool.remove(upstream.url).catch(e => console.error('Failed to persist pool:', e));
      if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Proxy fetch failed or timed out' });
      else if (!res.writableFinished) res.destroy();
      console.warn(`Fetch failed through ${upstream.protocol}: ${error.message}`);
    } finally {
      clearTimeout(timeoutId); res.off('close', abortOnClose); agent?.destroy(); inFlight--;
    }
  };
}
