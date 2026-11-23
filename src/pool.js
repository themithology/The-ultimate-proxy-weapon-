import fs from 'node:fs/promises';
import path from 'node:path';

export class ProxyPool {
  constructor({ directory = 'data', rotation = 'round-robin', healthBaselineRequests = 5, healthWindow = 20, healthRetentionRatio = 0.5, maxSize = 9999, cooldownMs = 3600000 } = {}) {
    this.directory = directory; this.rotation = rotation; this.proxies = []; this.index = 0;
    this.maxSize = maxSize; this.cooldownMs = cooldownMs; this.retiredUntil = new Map();
    this.healthBaselineRequests = healthBaselineRequests; this.healthWindow = healthWindow; this.healthRetentionRatio = healthRetentionRatio; this.health = new Map();
    this.lastScrape = null; this.revision = 0; this.evictions = new Map(); this.writeQueue = Promise.resolve();
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const items = JSON.parse(await fs.readFile(path.join(this.directory, 'proxies.json'), 'utf8'));
      if (!Array.isArray(items)) throw new Error('Invalid pool file');
      this.proxies = items.filter(item => item && typeof item.url === 'string' && ['http', 'https', 'socks4', 'socks5'].includes(item.protocol)).sort((a, b) => a.latencyMs - b.latencyMs).slice(0, this.maxSize);
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
    const now = Date.now();
    for (const [url, until] of this.retiredUntil) if (until <= now) this.retiredUntil.delete(url);
    this.proxies = [...new Map(proxies.filter(p => !this.retiredUntil.has(p.url)).map(p => [p.url, p])).values()].sort((a, b) => a.latencyMs - b.latencyMs).slice(0, this.maxSize); this.index = 0;
    const active = new Set(this.proxies.map(p => p.url));
    for (const url of this.health.keys()) if (!active.has(url)) this.health.delete(url);
    await this.persist();
  }
  async remove(url) {
    if (!this.proxies.some(p => p.url === url)) return;
    this.evictions.set(url, ++this.revision);
    this.retiredUntil.set(url, Date.now() + this.cooldownMs);
    this.health.delete(url);
    this.proxies = this.proxies.filter(p => p.url !== url);
    await this.persist();
  }
  getHealth(url) {
    const stats = this.health.get(url);
    if (!stats) return { observations: 0, baselineSuccessRate: null, recentSuccessRate: null };
    return { observations: stats.observations, baselineSuccessRate: stats.baseline,
      recentSuccessRate: stats.recent.reduce((sum, value) => sum + value, 0) / stats.recent.length };
  }
  recordOutcome(url, success) {
    // Ignore requests that complete after their proxy has already been retired.
    if (!this.proxies.some(p => p.url === url)) return;
    const stats = this.health.get(url) ?? { observations: 0, baseline: null, initial: [], recent: [] };
    stats.observations++;
    stats.recent.push(success ? 1 : 0);
    if (stats.recent.length > this.healthWindow) stats.recent.shift();
    if (stats.baseline === null) {
      stats.initial.push(success ? 1 : 0);
      if (stats.initial.length === this.healthBaselineRequests) {
        stats.baseline = stats.initial.reduce((sum, value) => sum + value, 0) / stats.initial.length;
        stats.initial = [];
      }
    }
    this.health.set(url, stats);
    if (stats.baseline !== null && (stats.baseline === 0 ||
        (stats.observations >= this.healthBaselineRequests + this.healthWindow &&
         stats.recent.reduce((sum, value) => sum + value, 0) / stats.recent.length < stats.baseline * this.healthRetentionRatio))) {
      console.log(`Retiring proxy due to degraded request success rate: ${url}`);
      this.remove(url).catch(error => console.error('Failed to persist pool:', error));
    }
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
