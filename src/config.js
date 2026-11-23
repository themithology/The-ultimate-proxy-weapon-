import 'dotenv/config';

const number = (name, fallback, min, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected integer ${min}-${max}`);
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
  return { proxyUser: required('PROXY_USER'), proxyPass: required('PROXY_PASS'), apiKey: required('API_KEY'),
    host: process.env.HOST || '0.0.0.0', proxyPort: number('PROXY_PORT', 8080, 1, 65535), apiPort: number('API_PORT', 8000, 1, 65535),
    rotation, concurrency: number('VALIDATION_CONCURRENCY', 300, 1, 500), timeout: number('VALIDATION_TIMEOUT_MS', 4000, 100, 60000),
    scrapeTimeout: number('SCRAPE_TIMEOUT_MS', 10000, 100, 60000), echoUrl };
}
