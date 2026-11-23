# Automatic Proxy Scraper & Rotating Gateway

Self-hosted Node.js 20.11+ service that collects public IPv4 proxy feeds, checks exit IP and latency, and provides an authenticated HTTP forward proxy and management API. **Public proxies are untrusted:** operators can log, alter, block or intercept traffic. Do not send credentials or sensitive data through them. Respect website terms, robots policies, rate limits and applicable laws. This project does not guarantee privacy, anonymity, availability or the accuracy of public feed claims.

See [PTERODACTYL.md](PTERODACTYL.md) for panel deployment instructions.

## Quick start

```sh
cp .env.example .env
# Edit .env and replace all three change-me credentials with strong, unique secrets.
npm ci
npm start
# Or: docker compose up --build -d
```

Open **http://localhost:8000/** for the personal dashboard. The dashboard has no login: anyone who can reach the API port can view the pool, download it, and trigger refreshes. Bind to a private interface or restrict the port with a firewall if you do not want it exposed. The proxy gateway still requires the configured credentials.

Both servers start immediately; the initial scrape runs in the background and can take a long time. The gateway returns 503 until a working upstream is available. When the pool starts empty, successful validation batches are published as the scan progresses, rather than waiting for the entire feed to be checked. Feed availability changes; edit `config/sources.json` to add/remove feeds. Entries have a `url` and default `protocol` (`http`, `https`, `socks4`, `socks5`). A scheme in a feed overrides its default. `https` means TLS **to the proxy**, not simply an HTTP proxy capable of CONNECT. Some upstream lists use “HTTPS” to mean CONNECT-capable HTTP proxies; configure those as `http`.

```sh
curl http://localhost:8000/health
curl -H 'x-api-key: YOUR_API_KEY' 'http://localhost:8000/proxy/random?protocol=socks5&format=text'
curl -H 'x-api-key: YOUR_API_KEY' http://localhost:8000/proxies.json
curl -H 'x-api-key: YOUR_API_KEY' http://localhost:8000/proxies.txt
curl -X POST -H 'x-api-key: YOUR_API_KEY' http://localhost:8000/refresh
curl -x http://user:pass@localhost:8080 https://httpbin.org/ip
```

Replace credentials in the example. The original management endpoints require the API key except `/health`; the no-login dashboard and its `/dashboard/*` endpoints are public to anyone who can reach the API port. `/refresh` returns 202 when started, 409 if a cycle is already running. The scraper is scheduled every 20 seconds by default (`SCRAPE_INTERVAL_SECONDS` can be set from 1 to 3600); the older `SCRAPE_INTERVAL_MINUTES` setting remains supported when the seconds setting is absent; existing proxies are rechecked every 5 minutes. Overlapping cycles are skipped, so a long scan can make the actual interval longer and delay a recheck. Files are individually written with temporary files and atomic renames (the pair is not a transactional snapshot). A total source outage preserves the existing pool. Validation uses a bounded continuously refilled worker pool and a strict timeout; configure concurrency and timeouts in `.env`. Each refresh tests up to `MAX_CANDIDATES` (default 100,000, maximum 1,000,000) mixed across sources, plus the existing pool. The active pool is capped at `POOL_MAX_SIZE` (default and maximum 9,999) and retains the lowest-latency verified proxies. Per-feed cursors advance to a different portion of each list on later refreshes. Cursors reset on restart and changing feeds can reorder, so full coverage is not guaranteed. The default concurrency is 1,000 and the configurable maximum is 2,000; lower `VALIDATION_CONCURRENCY` if the host limits simultaneous connections or memory, and increase `MAX_CANDIDATES` if you want longer scans. Existing `.env` values override these defaults: explicitly set `MAX_CANDIDATES=100000` or up to `1000000` to increase an existing installation. A scan cannot test more unique candidates than its feeds provide; long scans skip scheduled ticks. The dashboard reports feed progress, validation progress, and the measured average checks per second. Concurrency is not throughput: no particular checks-per-second rate is guaranteed. Increase the open-file limit if necessary. No memory usage figure is guaranteed; feed size and runtime conditions vary.

The validator requires the IP echo result to equal the proxy's IPv4 address. This rejects NAT/multi-hop exits and may accept a transparent proxy in unusual cases (e.g. running on the proxy host). It does **not** inspect forwarding headers or prove anonymity. `anonymity: exit-ip-match` describes only this test. Feed contents, IP echo service, and the network itself are not trusted. The default HTTPS echo verifies TLS. HTTPS target traffic is tunneled, but ordinary HTTP traffic and gateway Basic credentials are visible on the network; restrict access using a firewall/VPN. The gateway fails closed on an empty pool. Detected HTTP upstream connection errors and HTTP CONNECT rejections remove the selected upstream; destination failures can also lead to eviction. proxy-chain does not expose every SOCKS failure or dropped tunnel, so the periodic revalidation is the fallback for those cases. Long-lived tunnels are not continuously health-checked and cannot be transparently retried.

Docker bind-mounted `data` must be writable by the container's `node` user (usually UID 1000); `config` is mounted read-only. Adjust permissions before starting. `PROXY_PORT` and `API_PORT` changes also require changing compose port mappings. Protect both ports with firewall rules; the public health endpoint reveals operational metrics. API key and proxy Basic authentication are not encrypted without TLS.

## Reverse proxy (API only)

Terminate TLS for the management API; do **not** route the forward proxy through these examples. Configure DNS and certificates separately and restrict access to trusted clients. Example Nginx inside the same host:

```nginx
server {
    listen 443 ssl;
    server_name proxy-api.example.com;
    ssl_certificate /etc/letsencrypt/live/proxy-api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/proxy-api.example.com/privkey.pem;
    location / { proxy_pass http://127.0.0.1:8000; proxy_set_header Host $host; }
}
```

Caddy alternative:

```caddy
proxy-api.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

## Tests

Run `npm test`. Tests use local fixtures and do not depend on public feeds. The service requires external network access to fetch feeds, reach the echo service and connect to upstream proxies. Sources are community-maintained and can disappear or change format; test them before relying on them.

### Real-network smoke test

GitHub Actions runs a separate live smoke test against the actual feeds and sampled public proxies, then checks the API and makes a real HTTPS CONNECT request through the gateway. It can fail for reasons outside this project (feed outages, proxy churn, runner network restrictions, or echo service outages); inspect the run logs before treating a failure as a code regression. Run it locally with `node scripts/live-smoke.js` when outbound access is available; set `LIVE_SAMPLE_SIZE` (default 1200, maximum 20000) to adjust the sample. It sends traffic through untrusted public proxies and does not test every endpoint or guarantee future proxy availability.

### Adaptive pool retirement

Requests use the configured `ROTATION_MODE` (`round-robin`, `random`, or `lowest-latency`). The pool keeps an in-memory rolling success history for each active proxy. Its first `HEALTH_BASELINE_REQUESTS` observations (default 5) set the initial success rate; a zero baseline retires it immediately. After a further `HEALTH_WINDOW` observations (default 20), the proxy is retired if the most recent window's success rate is below the baseline multiplied by `HEALTH_RETENTION_RATIO` (default 0.5). For example, an initial 100% rate and a recent rate below 50% triggers retirement. This avoids judging a proxy from just one target response. Detected connection failures cause immediate eviction and an in-memory `PROXY_COOLDOWN_SECONDS` quarantine (default one hour); after that it can be re-added if validation succeeds. Cooldowns reset on restart. Stats are reset on restart or retirement and are available at `GET /proxy/stats` with the API key.

For plain HTTP, completed responses count as successful regardless of target status; a 403 or 404 does not imply a broken proxy. For HTTPS the gateway sees the CONNECT response, not the encrypted HTTP responses inside the tunnel, so only tunnel establishment can contribute to these stats; successful CONNECT does not mean the scraper received a successful page. Client cancellations without a completed response are not counted. If application-level HTTPS response rates matter, record them in your scraper and use a separate feedback mechanism; the proxy cannot see them automatically.

## Path-based scraper endpoint (one panel allocation)

`GET /fetch?url=ENCODED_TARGET_URL` makes an HTTP(S) request through a proxy selected from the verified pool. It is a normal HTTP API served on the **dashboard/API port**, not a standard forward proxy URL; clients must call this endpoint explicitly. Include your existing API key:

```sh
curl --get -H 'x-api-key: YOUR_API_KEY' \
  --data-urlencode 'url=https://example.com/' \
  'http://YOUR_PANEL_ADDRESS:PRIMARY_PORT/fetch'
```

The dashboard displays the endpoint based on the address used to open it. GET, HEAD, POST, PUT, PATCH and DELETE are supported, including streaming request bodies. The target status and body are returned; target errors such as 403, 404 and 429 do not retire a proxy. Redirects are not followed; their location is returned in `X-Upstream-Location`. Request headers forwarded: User-Agent, Referer, Origin, Accept, Range, If-Range, If-None-Match, If-Modified-Since, Content-Type and Content-Length. API keys and cookies are not forwarded. Content-Type, Content-Length, Content-Range, Content-Encoding, Accept-Ranges, ETag and Last-Modified are passed back. Response bodies stream with backpressure and have no application size or duration cap; client disconnects cancel upstream without retiring the proxy. `FETCH_HEADER_TIMEOUT_MS` (default 20000) bounds waiting for response headers, not stream duration. `FETCH_MAX_CONCURRENCY` defaults to 100 (range 50–500); available bandwidth, sockets and hosting limits may reduce real capacity. A reverse proxy or hosting platform may impose its own limits. An empty pool returns 503; a network failure returns 502 when possible. Public proxies may fail or be untrusted. This API cannot be used as `curl -x http://host/fetch`; normal HTTP/HTTPS forward proxy clients require a separate reachable proxy port (or a host-provided TCP/CONNECT proxy service). Keep the API key private and restrict network access; this endpoint can request arbitrary URLs through upstream proxies.

Feeds returning 404 or 410 are skipped for one hour. Other non-2xx responses (including redirects), timeouts and network errors are retried after 20 seconds; check the earlier `Source failed` log lines for the cause. A cycle with all feeds on cooldown does not mean it retried them. Feed availability can depend on your hosting provider's network.
