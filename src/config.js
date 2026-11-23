import 'dotenv/config';

const number = (name, fallback, min, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected integer ${min}-${max}`);
  return value;
};
const ratio = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`Invalid ${name}: expected number > 0 and <= 1`);
  return value;
};
export function loadConfig() {
  const required = name => {
    const value = process.env[name];
    if (!value || value === 'change-me') throw new Error(`Set a strong ${name} in your environment`);
    return value;
  };
  const rotation = process.env.ROTATION_MODE || 'round-robin';
  if (!['round-robin', 'random', 'lowest-latency'].includes(rotation)) throw new Error('Invalid ROTATION_MODE');
  const echoUrl = process.env.ECHO_URL || 'https://api.ipify.org?format=json';
  if (!['http:', 'https:'].includes(new URL(echoUrl).protocol)) throw new Error('ECHO_URL must be HTTP(S)');
  const scrapeIntervalSeconds = process.env.SCRAPE_INTERVAL_SECONDS !== undefined
    ? number('SCRAPE_INTERVAL_SECONDS', 20, 1, 3600)
    : process.env.SCRAPE_INTERVAL_MINUTES !== undefined
      ? number('SCRAPE_INTERVAL_MINUTES', 1, 1, 60) * 60
      : 20;
  return { proxyUser: required('PROXY_USER'), proxyPass: required('PROXY_PASS'), apiKey: required('API_KEY'),
    host: process.env.HOST || '0.0.0.0', proxyHost: process.env.PROXY_HOST || process.env.HOST || '0.0.0.0', proxyPort: number('PROXY_PORT', 8080, 1, 65535), apiPort: number('API_PORT', process.env.SERVER_PORT || 8000, 1, 65535),
    rotation, scrapeIntervalSeconds, maxCandidates: number('MAX_CANDIDATES', 20000, 1, 1000000), concurrency: number('VALIDATION_CONCURRENCY', 500, 1, 500), timeout: number('VALIDATION_TIMEOUT_MS', 4000, 100, 60000),
    maxPoolSize: number('POOL_MAX_SIZE', 9999, 1, 9999), proxyCooldownMs: number('PROXY_COOLDOWN_SECONDS', 3600, 1, 86400) * 1000,
    healthBaselineRequests: number('HEALTH_BASELINE_REQUESTS', 5, 1, 100), healthWindow: number('HEALTH_WINDOW', 20, 1, 1000),
    healthRetentionRatio: ratio('HEALTH_RETENTION_RATIO', 0.5),
    scrapeTimeout: number('SCRAPE_TIMEOUT_MS', 10000, 100, 60000), echoUrl };
}
