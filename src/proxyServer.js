import { Server, RequestError } from 'proxy-chain';
import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';

export function safeEqual(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}
export function createProxyServer(pool, config) {
  const selected = new WeakMap();
  const server = new Server({ host: config.host, port: config.proxyPort, prepareRequestFunction: ({ username, password, request }) => {
    if (!safeEqual(username, config.proxyUser) || !safeEqual(password, config.proxyPass)) return { requestAuthentication: true, failMsg: 'Authentication required' };
    const upstream = pool.select();
    // Returning a falsy upstream would accidentally make this an open direct proxy.
    if (!upstream) throw new RequestError('No healthy upstream proxies available', 503);
    selected.set(request, upstream.url);
    const evict = () => pool.remove(upstream.url).catch(e => console.error('Failed to persist pool:', e));
    // proxy-chain does not emit requestFailed for all HTTP upstream socket errors.
    const Agent = upstream.protocol === 'https' ? https.Agent : http.Agent;
    const agent = new Agent({ keepAlive: false });
    const createConnection = agent.createConnection.bind(agent);
    agent.createConnection = (...args) => {
      const socket = createConnection(...args);
      const timer = setTimeout(() => { evict(); socket.destroy(); }, config.timeout ?? 4000);
      timer.unref();
      socket.once(upstream.protocol === 'https' ? 'secureConnect' : 'connect', () => clearTimeout(timer));
      socket.once('error', () => { clearTimeout(timer); evict(); });
      socket.once('close', () => clearTimeout(timer));
      return socket;
    };
    return { upstreamProxyUrl: upstream.url, customTag: upstream.url, httpAgent: agent, httpsAgent: agent };

  }});
  server.on('tunnelConnectFailed', ({ customTag }) => { if (customTag) pool.remove(customTag).catch(e => console.error('Failed to persist pool:', e)); });
  server.on('requestFailed', ({ request, error }) => {
    const url = selected.get(request);
    if (url) pool.remove(url).catch(e => console.error('Failed to persist pool:', e));
    console.warn(`Proxy request failed: ${error.message}`);
  });
  return server;
}
