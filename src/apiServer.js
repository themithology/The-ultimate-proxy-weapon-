import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEqual } from './proxyServer.js';
import { createFetchHandler } from './fetchEndpoint.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

export function createApi(pool, config, refresh, getCycleStatus = () => ({ busy: false })) {
  const app = express(); app.disable('x-powered-by'); app.use(helmet({ frameguard: false, contentSecurityPolicy: { directives: { frameAncestors: null, upgradeInsecureRequests: null } } })); app.use(cors());
  app.get('/health', (_req, res) => {
    const items = pool.list(), counts = { http: 0, https: 0, socks4: 0, socks5: 0 };
    for (const item of items) if (item.protocol in counts) counts[item.protocol]++;
    res.json({ uptime: process.uptime(), activeProxyCount: items.length, protocols: counts, averageLatencyMs: items.length ? items.reduce((sum, p) => sum + p.latencyMs, 0) / items.length : null, lastScrape: pool.lastScrape });
  });
  // The personal dashboard intentionally requires no login. Mount it before API-key middleware.
  app.use(express.static(publicDir, { index: 'index.html' }));
  app.get('/dashboard/data', (_req, res) => {
    const proxies = pool.list();
    res.set('Cache-Control', 'no-store').json({
      proxies: proxies.map(proxy => ({ ...proxy, health: pool.getHealth(proxy.url) })),
      lastScrape: pool.lastScrape, rotation: pool.rotation,
      cycle: getCycleStatus(), uptime: process.uptime(),
      proxyPort: config.proxyPort,
    });
  });
  app.get('/dashboard/proxies.txt', (_req, res) => {
    res.type('text/plain').attachment('proxies.txt').send(pool.list().map(p => p.url).join('\n') + (pool.list().length ? '\n' : ''));
  });
  app.post('/dashboard/refresh', (_req, res) => {
    if (!refresh()) return res.status(409).json({ error: 'A cycle is already running' });
    res.status(202).json({ status: 'started' });
  });
  app.use((req, res, next) => safeEqual(req.get('x-api-key'), config.apiKey) ? next() : res.status(401).json({ error: 'Invalid API key' }));
  app.all('/fetch', createFetchHandler(pool, { timeout: config.fetchHeaderTimeoutMs ?? 20000, maxConcurrent: config.fetchMaxConcurrency ?? 100 }));
  app.get('/proxy/random', (req, res) => {
    const protocol = req.query.protocol;
    if (protocol && !['http', 'https', 'socks4', 'socks5'].includes(protocol)) return res.status(400).json({ error: 'Invalid protocol' });
    if (req.query.format && !['text', 'json'].includes(req.query.format)) return res.status(400).json({ error: 'Invalid format' });
    const proxy = pool.select(protocol, 'random');
    if (!proxy) return res.status(503).json({ error: 'No healthy upstream proxies available' });
    return req.query.format === 'text' ? res.type('text').send(proxy.url) : res.json(proxy);
  });
  app.get('/proxy/stats', (_req, res) => res.json(pool.list().map(proxy => ({ url: proxy.url, ...pool.getHealth(proxy.url) }))));
  app.get('/proxies.json', (_req, res) => res.json(pool.list()));
  app.get('/proxies.txt', (_req, res, next) => res.sendFile(path.resolve(pool.directory, 'proxies.txt'), err => { if (err) next(err); }));
  app.post('/refresh', (_req, res) => { if (!refresh()) return res.status(409).json({ error: 'A cycle is already running' }); res.status(202).json({ status: 'started' }); });
  return app;
}
