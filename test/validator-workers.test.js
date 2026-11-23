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

test('malformed TLS from HTTP, HTTPS and SOCKS proxies does not crash the process', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const sockets = new Set();
  function track(socket) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); }
  const httpProxy = net.createServer(socket => { track(socket); socket.once('data', () => socket.end('HTTP/1.1 200 Connection Established\r\n\r\nHTTP/1.1 200 OK\r\n\r\n')); });
  const httpsProxy = net.createServer(socket => { track(socket); socket.end('HTTP/1.1 200 OK\r\n\r\n'); });
  const socksProxy = net.createServer(socket => {
    track(socket); let stage = 0;
    socket.on('data', () => {
      if (stage++ === 0) socket.write(Buffer.from([5, 0]));
      else if (stage === 2) socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
      else socket.end('HTTP/1.1 200 OK\r\n\r\n');
    });
  });
  const servers = [httpProxy, httpsProxy, socksProxy];
  for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); });
  const [httpPort, httpsPort, socksPort] = servers.map(server => server.address().port);
  const script = `import { validateProxies } from './src/validator.js'; const keepAlive=setInterval(()=>{},1000); const endpoints = [['http',${httpPort}],['https',${httpsPort}],['socks5',${socksPort}]]; const proxies = Array.from({length:600},(_,i)=>{const [protocol,port]=endpoints[i%3]; return {protocol,port,host:'127.0.0.1',url:protocol+'://127.0.0.1:'+port};}); const valid=await validateProxies(proxies,{concurrency:300,timeout:1500,echoUrl:'https://127.0.0.1:4443/'}); clearInterval(keepAlive); console.log('completed',valid.length);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 15000 });
  assert.match(stdout, /completed 0/);
});
