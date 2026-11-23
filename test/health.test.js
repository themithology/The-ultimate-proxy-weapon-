import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Server } from 'proxy-chain';
import { ProxyPool } from '../src/pool.js';
import { createProxyServer } from '../src/proxyServer.js';

test('baseline and rolling window retire degraded proxies and persist removal', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'health-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pool = new ProxyPool({ directory, healthBaselineRequests: 3, healthWindow: 4, healthRetentionRatio: 0.5 });
  await pool.load(); const item = { url: 'http://127.0.0.1:1234', protocol: 'http', latencyMs: 1 }; await pool.replace([item]);
  for (const success of [true, true, true]) pool.recordOutcome(item.url, success);
  assert.equal(pool.getHealth(item.url).baselineSuccessRate, 1);
  for (const success of [false, false, false]) pool.recordOutcome(item.url, success);
  assert.equal(pool.list().length, 1, 'must wait for a full post-baseline window');
  pool.recordOutcome(item.url, false);
  assert.equal(pool.list().length, 0); await pool.writeQueue;
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'proxies.json'), 'utf8')), []);
  await pool.replace([item]); assert.equal(pool.getHealth(item.url).observations, 0);
  for (let i = 0; i < 3; i++) pool.recordOutcome(item.url, false);
  assert.equal(pool.list().length, 0, 'zero baseline retires proxy'); await pool.writeQueue;
});

test('gateway records actual HTTP status outcomes and retires degraded upstream', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-health-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let status = 200;
  const target = http.createServer((_req, res) => { res.statusCode = status; res.end('result'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => target.close(resolve)));
  const upstream = new Server({ host: '127.0.0.1', port: 0 }); await upstream.listen(); t.after(() => upstream.close(true));
  const url = `http://127.0.0.1:${upstream.server.address().port}`;
  const pool = new ProxyPool({ directory, healthBaselineRequests: 2, healthWindow: 2, healthRetentionRatio: 0.75 });
  await pool.load(); await pool.replace([{ url, protocol: 'http', latencyMs: 1 }]);
  const gateway = createProxyServer(pool, { host: '127.0.0.1', proxyPort: 0, proxyUser: 'u', proxyPass: 'p', timeout: 1000 });
  await gateway.listen(); t.after(() => gateway.close(true));
  async function request() {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: gateway.server.address().port, path: `http://127.0.0.1:${target.address().port}/`, headers: { 'Proxy-Authorization': `Basic ${Buffer.from('u:p').toString('base64')}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
    });
  }
  assert.equal(await request(), 200); assert.equal(await request(), 200);
  assert.equal(pool.getHealth(url).baselineSuccessRate, 1);
  status = 503; assert.equal(await request(), 503); assert.equal(pool.list().length, 1);
  assert.equal(await request(), 503); assert.equal(pool.list().length, 0); await pool.writeQueue;
  assert.equal(await request(), 503);
});
