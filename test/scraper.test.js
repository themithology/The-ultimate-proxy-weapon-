import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scrapeSources } from '../src/scraper.js';

test('a hanging response and hanging cancellation cannot stall a scrape', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-timeout-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcesPath = path.join(directory, 'sources.json');
  await fs.writeFile(sourcesPath, JSON.stringify([{ url: 'http://hung.test', protocol: 'http' }, { url: 'http://good.test', protocol: 'http' }]));
  const never = () => new Promise(() => {});
  const fetchImpl = async url => url.includes('hung')
    ? { ok: true, body: { getReader: () => ({ read: never, cancel: never }) } }
    : new Response('1.2.3.4:80\n');
  const updates = []; const started = Date.now();
  const result = await scrapeSources({ sourcesPath, timeout: 100, fetchImpl, onProgress: progress => updates.push(progress) });
  assert.ok(Date.now() - started < 2000); assert.equal(result.successes, 1); assert.equal(result.proxies.length, 1);
  assert.deepEqual(updates.at(-1), { completed: 2, total: 2, successes: 1 });
});

test('candidate limit mixes multiple sources', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-mix-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcesPath = path.join(directory, 'sources.json');
  await fs.writeFile(sourcesPath, JSON.stringify([{ url: 'http://a.test', protocol: 'http' }, { url: 'http://b.test', protocol: 'socks5' }]));
  const result = await scrapeSources({ sourcesPath, limit: 2, fetchImpl: async url => new Response(url.includes('a.test') ? '1.1.1.1:80\n1.1.1.2:80' : '2.2.2.2:1080\n2.2.2.3:1080') });
  assert.equal(result.proxies.length, 2); assert.deepEqual(result.proxies.map(p => p.protocol), ['http', 'socks5']);
});

test('successive limited refreshes advance each source cursor', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-cursor-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcesPath = path.join(directory, 'sources.json');
  await fs.writeFile(sourcesPath, JSON.stringify([{ url: 'http://a.test', protocol: 'http' }]));
  const cursorBySource = new Map([['http://a.test', 0]]);
  const options = { sourcesPath, limit: 2, cursorBySource, fetchImpl: async () => new Response('1.1.1.1:80\n1.1.1.2:80\n1.1.1.3:80\n1.1.1.4:80') };
  assert.deepEqual((await scrapeSources(options)).proxies.map(p => p.host), ['1.1.1.1', '1.1.1.2']);
  assert.deepEqual((await scrapeSources(options)).proxies.map(p => p.host), ['1.1.1.3', '1.1.1.4']);
});

test('non-success feeds are temporarily skipped on later scrapes and then retried', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-404-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcesPath = path.join(directory, 'sources.json'); const url = 'http://missing.test';
  await fs.writeFile(sourcesPath, JSON.stringify([{ url, protocol: 'http' }]));
  let calls = 0; const sourceCooldowns = new Map();
  const options = { sourcesPath, sourceCooldowns, missingCooldownMs: 60000, fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } };
  assert.equal((await scrapeSources(options)).successes, 0); assert.equal(calls, 1);
  assert.equal((await scrapeSources(options)).successes, 0); assert.equal(calls, 1);
  sourceCooldowns.set(url, Date.now() - 1);
  await scrapeSources(options); assert.equal(calls, 2);
});


test('a non-2xx response is cooled down instead of repeatedly fetched', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-500-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcesPath = path.join(directory, 'sources.json'); const url = 'http://broken.test';
  await fs.writeFile(sourcesPath, JSON.stringify([{ url, protocol: 'http' }]));
  let calls = 0; const sourceCooldowns = new Map();
  const options = { sourcesPath, sourceCooldowns, fetchImpl: async () => { calls++; return new Response('', { status: 500 }); } };
  await scrapeSources(options); await scrapeSources(options); assert.equal(calls, 1);
  const redirectOptions = { ...options, sourceCooldowns: new Map(), fetchImpl: async (_url, requestOptions) => {
    assert.equal(requestOptions.redirect, 'manual'); return new Response('', { status: 302 });
  } };
  assert.equal((await scrapeSources(redirectOptions)).successes, 0);
});


test('2xx feed responses other than 200 are accepted', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-201-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcesPath = path.join(directory, 'sources.json');
  await fs.writeFile(sourcesPath, JSON.stringify([{ url: 'http://ok.test', protocol: 'http' }]));
  const result = await scrapeSources({ sourcesPath, fetchImpl: async () => new Response('1.2.3.4:80', { status: 201 }) });
  assert.equal(result.successes, 1); assert.equal(result.proxies.length, 1);
});
