import fs from 'node:fs/promises';
import path from 'node:path';

export class ProxyPool {
  constructor({ directory = 'data', rotation = 'round-robin' } = {}) {
    this.directory = directory; this.rotation = rotation; this.proxies = []; this.index = 0;
    this.lastScrape = null; this.revision = 0; this.evictions = new Map(); this.writeQueue = Promise.resolve();
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const items = JSON.parse(await fs.readFile(path.join(this.directory, 'proxies.json'), 'utf8'));
      if (!Array.isArray(items)) throw new Error('Invalid pool file');
      this.proxies = items.filter(item => item && typeof item.url === 'string' && ['http', 'https', 'socks4', 'socks5'].includes(item.protocol));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.persist();
  }
  list() { return [...this.proxies]; }
  select(protocol, mode = this.rotation) {
    const candidates = protocol ? this.proxies.filter(p => p.protocol === protocol) : this.proxies;
    if (!candidates.length) return null;
    if (mode === 'random') return candidates[Math.floor(Math.random() * candidates.length)];
    if (mode === 'lowest-latency') return candidates[0];
    return candidates[this.index++ % candidates.length];
  }
  async replace(proxies) {
    this.proxies = [...proxies].sort ( (a, b) => a.latencyMs - b.latencyMs); this.index = 0;
    await this.persist();
  }
  async remove(url) {
    if (!this.proxies.some(p => p.url === url)) return;
    this.evictions.set(url, ++this.revision);
    this.proxies = this.proxies.filter(p => p.url !== url);
    await this.persist();
  }
  persist() {
    const snapshot = this.list();
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      for (const [name, content] of [['proxies.json', JSON.stringify(snapshot, null, 2) + '\n'], ['proxies.txt', snapshot.map(p => p.url).join('\n') + (snapshot.length ? '\n' : '')]]) {
        const target = path.join(this.directory, name), temp = `${target}.${process.pid}.tmp`;
        await fs.writeFile(temp, content); await fs.rename(temp, target);
      }
    });
    return this.writeQueue;
  }
}
