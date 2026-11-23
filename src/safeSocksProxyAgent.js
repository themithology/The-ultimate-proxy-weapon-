import { SocksProxyAgent } from 'socks-proxy-agent';

// Preserve normal request error propagation while keeping late errors on a
// socket alive through cancellation or an invalid upstream TLS handshake.
export class SafeSocksProxyAgent extends SocksProxyAgent {
  async connect(request, options) {
    const socket = await super.connect(request, options);
    socket.on('error', () => {});
    return socket;
  }
}
