import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { validateProxy, validateProxies } from '../src/validator.js';

test('workers refill without waiting for the slowest check', async () => {
  let started = 0, running = 0, maxRunning = 0, startedWhenSlowFinished = 0;
  const checkProxy = async proxy => {
    started++; running++; maxRunning = Math.max(maxRunning, running);
    await new Promise(resolve => setTimeout(resolve, proxy.id === 0 ? 120 : 5));
    if (proxy.id === 0) startedWhenSlowFinished = started;
    running--; return { ...proxy, latencyMs: proxy.id };
  };
  let reported = 0;
  const proxies = Array.from({ length: 8 }, (_, id) => ({ id }));
  const result = await validateProxies(proxies, { concurrency: 2, progressBatchSize: 2, checkProxy, onBatch: (_passed, count) => { reported += count; } });
  assert.equal(result.length, 8); assert.equal(reported, 8);
  assert.equal(maxRunning, 2); assert.ok(startedWhenSlowFinished > 2, 'new checks start before the slow check finishes');
});

test('timed-out HTTP proxy handshakes close their sockets', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.resume(); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const result = await validateProxy({ url: `http://127.0.0.1:${port}`, protocol: 'http', host: '127.0.0.1', port }, { echoUrl: 'http://example.com', timeout: 100 });
  assert.equal(result, null);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sockets.size, 0, 'the stalled proxy connection must be closed');
});

test('HTTPS echo validation works through an HTTP CONNECT proxy', async t => {
  const { default: https } = await import('node:https');
  const { default: fs } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { Server } = await import('proxy-chain');
  const cert = path.resolve('test/fixtures/localhost-cert.pem');
  const target = https.createServer({ key: await fs.readFile('test/fixtures/localhost-key.pem'), cert: await fs.readFile(cert) }, (_req, res) => res.end(JSON.stringify({ ip: '127.0.0.1' })));
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => target.close(resolve)));
  const upstream = new Server({ host: '127.0.0.1', port: 0 }); await upstream.listen(); t.after(() => upstream.close(true));
  const port = upstream.server.address().port;
  const script = `import axios from 'axios'; import { validateProxy } from './src/validator.js'; import { BoundedHttpProxyAgent } from './src/httpProxyAgent.js'; const agent = new BoundedHttpProxyAgent('http://127.0.0.1:${port}', {timeout:2000}); try { const response = await axios.get('https://127.0.0.1:${target.address().port}/', {httpAgent:agent,httpsAgent:agent,proxy:false,timeout:2000}); const result = await validateProxy({url:'http://127.0.0.1:${port}',protocol:'http',host:'127.0.0.1',port:${port}},{echoUrl:'https://127.0.0.1:${target.address().port}/',timeout:2000}); if (!result) throw new Error('Validator rejected verified tunnel'); console.log(response.data.ip); } catch(e){ console.error(e.stack); process.exit(1); }`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 5000 });
  assert.equal(stdout.trim(), '127.0.0.1');
});
