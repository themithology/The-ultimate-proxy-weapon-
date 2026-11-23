import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Server } from 'proxy-chain';
import { ProxyPool } from '../src/pool.js';
import { parseFeed, scrapeSources } from '../src/scraper.js';
import { validateProxies } from '../src/validator.js';
import { createProxyServer } from '../src/proxyServer.js';
import { createApi } from '../src/apiServer.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const config = { host: '127.0.0.1', proxyPort: 0, proxyUser: 'alice', proxyPass: 'secret', apiKey: 'key', timeout: 1000 };
function connect(port, auth) { return new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1'); let data = '';
  socket.on('connect', () => socket.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n` : ''}\r\n`));
  socket.on('data', chunk => { data += chunk; if (data.includes('\r\n\r\n')) { socket.destroy(); resolve(data); } }); socket.on('error', reject);
}); }

test('parse and fetch feeds, validate and serve rotating local proxies', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const echo = http.createServer((_req, res) => res.end(JSON.stringify({ ip: '127.0.0.1' }))); await listen(echo); t.after(() => close(echo));
  const upstream = new Server({ host: '127.0.0.1', port: 0 }); await upstream.listen(); t.after(() => upstream.close(true));
  const upstream2 = new Server({ host: '127.0.0.1', port: 0 }); await upstream2.listen(); t.after(() => upstream2.close(true));
  const a = upstream.server.address().port, b = upstream2.server.address().port;
  const source = http.createServer((_req, res) => res.end(`127.0.0.1:${a}\nhttp://127.0.0.1:${a}\n127.0.0.1:${b}\n999.1.1.1:80\n`)); await listen(source); t.after(() => close(source));
  const sourcesPath = path.join(dir, 'sources.json'); await fs.writeFile(sourcesPath, JSON.stringify([{ url: `http://127.0.0.1:${source.address().port}`, protocol: 'http' }, { url: 'http://127.0.0.1:1', protocol: 'http' }]));
  const scraped = await scrapeSources({ sourcesPath, timeout: 1000 }); assert.equal(scraped.successes, 1); assert.equal(scraped.proxies.length, 2);
  assert.equal(parseFeed('socks5://1.2.3.4:1080\n2.3.4.5:0', 'http')[0].protocol, 'socks5');
  const batches = [];
  const valid = await validateProxies(scraped.proxies, { concurrency: 1, timeout: 1000, echoUrl: `http://127.0.0.1:${echo.address().port}`, onBatch: batch => batches.push(batch.length) }); assert.equal(valid.length, 2); assert.deepEqual(batches, [1, 1]);
  const pool = new ProxyPool({ directory: dir }); await pool.load(); await pool.replace(valid);
  assert.equal((await fs.readFile(path.join(dir, 'proxies.txt'), 'utf8')).trim().split('\n').length, 2);
  const gateway = createProxyServer(pool, config); await gateway.listen(); t.after(() => gateway.close(true));
  const gatewayPort = gateway.server.address().port;
  assert.match(await connect(gatewayPort), /407/);
  const api = createApi(pool, config, () => true); const apiServer = http.createServer(api); await listen(apiServer); t.after(() => close(apiServer));
  const base = `http://127.0.0.1:${apiServer.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.match(await (await fetch(base)).text(), /Network overview/);
  assert.equal((await (await fetch(`${base}/dashboard/data`)).json()).proxies.length, 2);
  assert.equal((await fetch(`${base}/dashboard/refresh`, { method: 'POST' })).status, 202);
  assert.equal((await (await fetch(`${base}/dashboard/proxies.txt`)).text()).trim().split('\n').length, 2);
  assert.equal((await fetch(`${base}/proxies.json`)).status, 401);
  assert.equal((await (await fetch(`${base}/proxies.json`, { headers: { 'x-api-key': 'key' } })).json()).length, 2);
  assert.equal((await fetch(`${base}/refresh`, { method: 'POST', headers: { 'x-api-key': 'key' } })).status, 202);
  // A forward-proxy request exercises the gateway and its upstream, end to end.
  const response = await new Promise((resolve, reject) => { const req = http.get({ host: '127.0.0.1', port: gatewayPort, path: `http://127.0.0.1:${echo.address().port}/`, headers: { 'Proxy-Authorization': `Basic ${Buffer.from('alice:secret').toString('base64')}` } }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body })); }); req.on('error', reject); });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).ip, '127.0.0.1');
  const beforeConnect = pool.list().reduce((sum, p) => sum + pool.getHealth(p.url).observations, 0);
  const curl = await promisify(execFile)('curl', ['--noproxy', '', '--max-time', '5', '--proxytunnel', '-x', `http://alice:secret@127.0.0.1:${gatewayPort}`, `http://127.0.0.1:${echo.address().port}/`]);
  assert.equal(JSON.parse(curl.stdout).ip, '127.0.0.1');
  assert.equal(pool.list().reduce((sum, p) => sum + pool.getHealth(p.url).observations, 0), beforeConnect + 1);
  const stats = await (await fetch(`${base}/proxy/stats`, { headers: { 'x-api-key': 'key' } })).json();
  assert.equal(stats.length, 2);
  const first = pool.select(), second = pool.select(); assert.notEqual(first.url, second.url);
  await pool.replace([]); assert.match(await connect(gatewayPort, 'alice:secret'), /503/);
});
