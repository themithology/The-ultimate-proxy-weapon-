import fs from 'node:fs/promises';
import net from 'node:net';

export function parseFeed(text, defaultProtocol) {
  const result = [];
  // Only accept standalone IPv4 endpoints, optionally with an explicit scheme.
  const regex = /(?:^|[\s,;"'])((?:(?:https?|socks4|socks5):\/\/)?(?:\d{1,3}\.){3}\d{1,3}:\d{1,5})(?=$|[\s,;"'])/gim;
  for (const match of text.matchAll(regex)) {
    const raw = match[1], [protocol, address] = raw.includes('://') ? raw.toLowerCase().split('://') : [defaultProtocol, raw];
    if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) continue;
    const [host, portString] = address.split(':'); const port = Number(portString);
    if (net.isIP(host) !== 4 || port < 1 || port > 65535) continue;
    result.push({ url: `${protocol}://${host}:${port}`, protocol, host, port });
  }
  return result;
}
export async function scrapeSources({ sourcesPath = 'config/sources.json', timeout = 10000, fetchImpl = fetch, limit = Infinity, onProgress = () => {}, cursorBySource = new Map(), sourceCooldowns = new Map(), missingCooldownMs = 3600000 } = {}) {
  const sources = JSON.parse(await fs.readFile(sourcesPath, 'utf8'));
  if (!Array.isArray(sources)) throw new Error('sources.json must contain an array');
  let completed = 0, successes = 0;
  const settled = await Promise.allSettled(sources.map(async source => {
    if ((sourceCooldowns.get(source.url) ?? 0) > Date.now()) {
      completed++; onProgress({ completed, total: sources.length, successes });
      return [];
    }
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(`Timeout after ${timeout}ms`)); }, timeout);
    });
    const fetchSource = async () => {
      const response = await fetchImpl(source.url, { signal: controller.signal, redirect: 'manual' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      sourceCooldowns.delete(source.url);
      const reader = response.body.getReader(); let size = 0, chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 10_000_000) throw new Error('Feed too large'); chunks.push(value);
        }
        return parseFeed(Buffer.concat(chunks).toString('utf8'), source.protocol);
      } finally {
        // Some broken streams never settle cancel(); never block the entire scrape on it.
        reader.cancel().catch(() => {});
      }
    };
    try {
      const entries = await Promise.race([fetchSource(), deadline]);
      successes++;
      return entries;
    } catch (error) {
      sourceCooldowns.set(source.url, Date.now() + missingCooldownMs);
      throw error;
    } finally {
      clearTimeout(timer); controller.abort(); completed++;
      onProgress({ completed, total: sources.length, successes });
    }
  }));
  const lists = [];
  settled.forEach((entry, i) => {
    if (entry.status === 'fulfilled' && entry.value.length) lists.push({ url: sources[i].url, entries: entry.value });
    else if (entry.status === 'rejected') console.warn(`Source failed: ${sources[i].url}: ${entry.reason.message}`);
  });
  // Mix feeds and advance a per-source cursor across refreshes. Changing feeds can
  // reorder between runs, so complete coverage is not guaranteed.
  const offsets = lists.map(({ url, entries }) => (cursorBySource.get(url) ?? Math.floor(Math.random() * entries.length)) % entries.length);
  const positions = lists.map(() => 0), unique = new Map();
  let remaining = lists.length;
  while (remaining && unique.size < limit) {
    for (let i = 0; i < lists.length && unique.size < limit; i++) {
      const list = lists[i].entries; if (positions[i] >= list.length) continue;
      const proxy = list[(offsets[i] + positions[i]++) % list.length];
      unique.set(proxy.url, proxy);
      if (positions[i] === list.length) remaining--;
    }
  }
  lists.forEach(({ url, entries }, i) => cursorBySource.set(url, (offsets[i] + positions[i]) % entries.length));
  return { proxies: [...unique.values()], successes, total: sources.length, limited: unique.size >= limit };
}
