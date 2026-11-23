import { SocksProxyAgent } from 'socks-proxy-agent';

// Preserve normal error propagation while guarding late socket errors.
export class SafeSocksProxyAgent extends SocksProxyAgent {
  constructor(proxy, options = {}) {
    super(proxy, options);
    this.disableConnectedTimeout = options.disableConnectedTimeout === true;
  }
  async connect(request, options) {
    let rawSocket;
    const rememberSocket = info => { rawSocket = info.socket; };
    request.once('proxy', rememberSocket);
    try {
      const socket = await super.connect(request, options);
      socket.on('error', () => {});
      if (this.disableConnectedTimeout) { rawSocket?.setTimeout(0); socket.setTimeout(0); }
      return socket;
    } finally { request.off('proxy', rememberSocket); }
  }
}
