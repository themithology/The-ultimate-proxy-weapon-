import axios from 'axios';
import { BoundedHttpProxyAgent } from './httpProxyAgent.js';
import { SafeSocksProxyAgent } from './safeSocksProxyAgent.js';
import { pipeline } from 'node:stream/promises';

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const requestHeaders = ['user-agent', 'referer', 'origin', 'accept', 'range', 'if-range', 'if-none-match', 'if-modified-since', 'content-type', 'content-length'];
const responseHeaders = ['content-type', 'content-length', 'content-range', 'content-encoding', 'accept-ranges', 'etag', 'last-modified'];

// A path-based HTTP fetch API, not a standard CONNECT forward proxy.
export function createFetchHandler(pool, { timeout = 20000, maxConcurrent = 100 } = {}) {
  let inFlight = 0;
  return async (req, res) => {
    if (!methods.has(req.method)) return res.status(405).json({ error: 'Unsupported method' });
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
    // Bound connection and response headers, not the length of a media stream.
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    let clientGone = false, upstreamFailed = false;
    const abortOnClose = () => { if (!res.writableFinished && !upstreamFailed) { clientGone = true; controller.abort(); } };
    res.once('close', abortOnClose);
    let agent;
    try {
      const headers = { 'accept-encoding': 'identity' };
      for (const name of requestHeaders) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      if (hasBody && !headers['content-type']) headers['content-type'] = 'application/octet-stream';
      agent = upstream.protocol.startsWith('socks')
        ? new SafeSocksProxyAgent(upstream.url, { timeout, disableConnectedTimeout: true })
        : new BoundedHttpProxyAgent(upstream.url, { timeout });
      const response = await axios({ method: req.method, url: target.href, headers, data: hasBody ? req : undefined,
        httpAgent: agent, httpsAgent: agent, proxy: false, responseType: 'stream', decompress: false,
        signal: controller.signal, timeout: 0, maxRedirects: 0, validateStatus: () => true });
      clearTimeout(timeoutId);
      // Preserve target statuses, even 403/404/429: they do not prove a proxy is bad.
      res.status(response.status);
      for (const name of responseHeaders) if (response.headers[name] !== undefined) res.set(name, response.headers[name]);
      res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
        'Access-Control-Expose-Headers': 'X-Upstream-Location, Content-Range, Accept-Ranges, Content-Length, ETag, Last-Modified' });
      if (response.headers.location) res.set('X-Upstream-Location', response.headers.location);
      response.data.once('error', () => { upstreamFailed = true; });
      response.data.once('aborted', () => { upstreamFailed = true; });
      await pipeline(response.data, res);
      pool.recordOutcome(upstream.url, true);
    } catch (error) {
      // Don't punish a proxy when the calling client abandons its stream.
      if (!clientGone) pool.remove(upstream.url).catch(e => console.error('Failed to persist pool:', e));
      if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Proxy connection or response timed out' });
      else if (!res.writableFinished) res.destroy();
      console.warn(`Fetch failed through ${upstream.protocol}: ${error.message}`);
    } finally {
      clearTimeout(timeoutId); res.off('close', abortOnClose); agent?.destroy(); inFlight--;
    }
  };
}
