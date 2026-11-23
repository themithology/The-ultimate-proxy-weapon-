import { Agent } from 'agent-base';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';

// A CONNECT agent with a bounded handshake. It owns and closes the pending
// upstream request even if the caller aborts before a socket is handed back.
export class BoundedHttpProxyAgent extends Agent {
  constructor(proxyUrl, { timeout = 4000 } = {}) {
    super();
    this.proxy = new URL(proxyUrl);
    this.handshakeTimeout = timeout;
    if (!['http:', 'https:'].includes(this.proxy.protocol)) throw new Error('Unsupported HTTP proxy protocol');
  }
  async connect(request, opts) {
    const host = opts.host;
    if (!host || !opts.port) throw new Error('Missing target host or port');
    const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${opts.port}`;
    const headers = { host: authority };
    if (this.proxy.username || this.proxy.password) {
      const credentials = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
      headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }
    return new Promise((resolve, reject) => {
      const transport = this.proxy.protocol === 'https:' ? https : http;
      const connector = transport.request({ hostname: this.proxy.hostname, port: this.proxy.port || (this.proxy.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT', path: authority, headers, agent: false });
      let finished = false;
      const timer = setTimeout(() => connector.destroy(new Error('Proxy handshake timed out')), this.handshakeTimeout);
      const onClientClose = () => connector.destroy(new Error('Request closed during proxy handshake'));
      request.once('close', onClientClose);
      const finish = (error, socket) => {
        if (finished) { socket?.destroy(); return; }
        finished = true; clearTimeout(timer); request.off('close', onClientClose);
        if (error) reject(error); else resolve(socket);
      };
      // A malformed HTTPS proxy can emit a late TLS error after the request
      // was already aborted. Keep a socket-level listener for its lifetime.
      connector.on('socket', socket => socket.on('error', () => {}));
      connector.once('error', error => finish(error));
      connector.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy(); finish(new Error(`Proxy CONNECT returned ${response.statusCode}`)); return;
        }
        if (head.length) socket.unshift(head);
        if (!opts.secureEndpoint) return finish(null, socket);
        const tlsSocket = tls.connect({ socket, host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: opts.rejectUnauthorized !== false });
        // axios/Node still receive the same error; this listener only prevents a
        // late error from becoming an uncaught event during cancellation races.
        tlsSocket.on('error', () => {});
        finish(null, tlsSocket);
      });
      connector.end();
    });
  }
}
