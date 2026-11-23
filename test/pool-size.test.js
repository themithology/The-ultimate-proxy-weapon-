import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProxyPool } from '../src/pool.js';

test('the pool keeps no more than 9999 fastest distinct proxies', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-cap-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pool = new ProxyPool({ directory }); await pool.load();
  const proxies = Array.from({ length: 10005 }, (_, i) => ({ url: `http://127.0.0.1:${i + 1}`, protocol: 'http', latencyMs: 10005 - i }));
  await pool.replace([...proxies, proxies[0]]);
  assert.equal(pool.list().length, 9999); assert.equal(pool.list()[0].latencyMs, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'proxies.json'), 'utf8')).length, 9999);
});

test('bursts of removals persist the latest pool without a snapshot per eviction', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-burst-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pool = new ProxyPool({ directory }); await pool.load();
  const proxies = Array.from({ length: 500 }, (_, i) => ({ url: `http://127.0.0.1:${10000 + i}`, protocol: 'http', latencyMs: i }));
  await pool.replace(proxies);
  await Promise.all(proxies.slice(0, 400).map(proxy => pool.remove(proxy.url)));
  const persisted = JSON.parse(await fs.readFile(path.join(directory, 'proxies.json'), 'utf8'));
  assert.equal(persisted.length, 100); assert.deepEqual(persisted, pool.list());
});
