import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'node:path';
import { safeEqual } from './proxyServer.js';

export function createApi(pool, config, refresh) {
  const app = express(); app.disable('x-powered-by'); app.use(helmet()); app.use(cors());
  app.get('/health', (_req, res) => {
    const items = pool.list(), counts = { http: 0, https: 0, socks4: 0, socks5: 0 };
    for (const item of items) if (item.protocol in counts) counts[item.protocol]++;
    res.json({ uptime: process.uptime(), activeProxyCount: items.length, protocols: counts, averageLatencyMs: items.length ? items.reduce((sum, p) => sum + p.latencyMs, 0) / items.length : null, lastScrape: pool.lastScrape });
  });
  app.use((req, res, next) => safeEqual(req.get('x-api-key'), config.apiKey) ? next() : res.status(401).json({ error: 'Invalid API key' }));
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
