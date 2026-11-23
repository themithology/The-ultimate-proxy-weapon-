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
export async function scrapeSources({ sourcesPath = 'config/sources.json', timeout = 10000, fetchImpl = fetch } = {}) {
  const sources = JSON.parse(await fs.readFile(sourcesPath, 'utf8'));
  if (!Array.isArray(sources)) throw new Error('sources.json must contain an array');
  const settled = await Promise.allSettled(sources.map(async source => {
    const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(timeout), redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Bound a feed's memory footprint, including when Content-Length is absent.
    const reader = response.body.getReader(); let size = 0, chunks = [];
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 10_000_000) throw new Error('Feed too large'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    return parseFeed(Buffer.concat(chunks).toString('utf8'), source.protocol);
  }));
  const unique = new Map(); let successes = 0;
  settled.forEach((entry, i) => {
    if (entry.status === 'fulfilled') { successes++; for (const proxy of entry.value) unique.set(proxy.url, proxy); }
    else console.warn(`Source failed: ${sources[i].url}: ${entry.reason.message}`);
  });
  return { proxies: [...unique.values()], successes, total: sources.length };
}
