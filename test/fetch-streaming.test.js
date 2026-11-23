import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { Server } from 'proxy-chain';
import { ProxyPool } from '../src/pool.js';
import { createApi } from '../src/apiServer.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('Elfura fetch supports range, headers, methods, status passthrough, large and long streams, and 65 concurrent requests', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fetch-stream-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const seen = []; const payloadSize = 11 * 1024 * 1024;
  const target = http.createServer((req, res) => {
    seen.push({ path: req.url, method: req.method, headers: req.headers });
    if (req.url.startsWith('/status/')) { const code = Number(req.url.split('/').at(-1)); res.writeHead(code, code === 302 ? { Location: '/moved' } : {}); return res.end('target status'); }
    if (req.url === '/range') { res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/12', 'Accept-Ranges': 'bytes', 'Content-Length': '4' }); return res.end('abcd'); }
    if (req.url === '/large') { res.writeHead(200, { 'Content-Length': String(payloadSize), 'Content-Type': 'video/mp4' }); return res.end(Buffer.alloc(payloadSize, 42)); }
    if (req.url === '/long') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.write('first'); return setTimeout(() => res.end('last'), 700); }
    if (req.url === '/many') return setTimeout(() => res.end('ok'), 100);
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ method: req.method, body })); });
  });
  await listen(target); t.after(() => close(target));
  const upstream = new Server({ host: '127.0.0.1', port: 0 }); await upstream.listen(); t.after(() => upstream.close(true));
  const pool = new ProxyPool({ directory }); await pool.load();
  await pool.replace([{ url: `http://127.0.0.1:${upstream.server.address().port}`, protocol: 'http', latencyMs: 1 }]);
  const app = createApi(pool, { apiKey: 'key', fetchHeaderTimeoutMs: 500, fetchMaxConcurrency: 100 }, () => true);
  const api = http.createServer(app); await listen(api); t.after(() => close(api));
  const base = `http://127.0.0.1:${api.address().port}/fetch?url=`;
  const targetUrl = `http://127.0.0.1:${target.address().port}`;
  const fetchTarget = (path, options = {}) => fetch(base + encodeURIComponent(targetUrl + path), { ...options, headers: { 'x-api-key': 'key', ...options.headers }, redirect: 'manual' });
  const partial = await fetchTarget('/range', { headers: { 'user-agent': 'Elfura-test', referer: 'https://example.org/', origin: 'https://example.org', accept: 'video/*', range: 'bytes=0-3', 'x-secret-not-forwarded': 'private' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), 'abcd');
  assert.equal(partial.headers.get('content-range'), 'bytes 0-3/12'); assert.equal(partial.headers.get('accept-ranges'), 'bytes');
  const received = seen.find(item => item.path === '/range').headers;
  for (const [name, expected] of Object.entries({ 'user-agent': 'Elfura-test', referer: 'https://example.org/', origin: 'https://example.org', accept: 'video/*', range: 'bytes=0-3' })) assert.equal(received[name], expected);
  assert.equal(received['x-api-key'], undefined); assert.equal(received['x-secret-not-forwarded'], undefined);
  const post = await fetchTarget('/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"hello":true}' });
  assert.deepEqual(await post.json(), { method: 'POST', body: '{"hello":true}' });
  for (const code of [302, 403, 404, 429, 500]) {
    const response = await fetchTarget(`/status/${code}`); assert.equal(response.status, code); await response.text();
    if (code === 302) assert.equal(response.headers.get('x-upstream-location'), '/moved');
    assert.equal(pool.list().length, 1, `target ${code} must not retire proxy`);
  }
  const large = await fetchTarget('/large'); assert.equal((await large.arrayBuffer()).byteLength, payloadSize);
  const long = await fetchTarget('/long'); assert.equal(await long.text(), 'firstlast', 'stream must survive beyond header timeout');
  const responses = await Promise.all(Array.from({ length: 65 }, () => fetchTarget('/many')));
  assert.ok(responses.every(response => response.status === 200)); await Promise.all(responses.map(response => response.text()));
});

test('failed proxy handshake is dropped and returns 502', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fetch-failure-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sockets = new Set();
  const blackhole = net.createServer(socket => { sockets.add(socket); socket.resume(); socket.on('close', () => sockets.delete(socket)); }); await listen(blackhole);
  t.after(() => { for (const socket of sockets) socket.destroy(); return close(blackhole); });
  const pool = new ProxyPool({ directory }); await pool.load(); await pool.replace([{ url: `http://127.0.0.1:${blackhole.address().port}`, protocol: 'http', latencyMs: 1 }]);
  const app = createApi(pool, { apiKey: 'key', fetchHeaderTimeoutMs: 100 }, () => true); const api = http.createServer(app); await listen(api); t.after(() => close(api));
  const response = await fetch(`http://127.0.0.1:${api.address().port}/fetch?url=${encodeURIComponent('http://example.com/')}`, { headers: { 'x-api-key': 'key' } });
  assert.equal(response.status, 502); assert.equal(pool.list().length, 0); await pool.writeQueue;
});
