# Deploy on Pterodactyl

This ZIP extracts directly into the current directory. It contains the application source, not preinstalled dependencies or credentials.

## Before you begin

- Use a Node.js 20.11+ egg/image (Node 20 LTS or newer) with npm and outbound network access. Your host's egg may use different names for its startup settings; ask your host if you cannot edit the startup command or allocations.
- Allocate **two different TCP ports**: the primary server allocation for the dashboard/API, and a second allocation for the proxy gateway. Both ports need to be reachable from your clients. A reverse proxy can provide HTTPS for the dashboard but does not replace the gateway's TCP allocation.
- At least 2 GB RAM is recommended. Public proxy feeds and proxy availability change; an empty pool can be normal while validation is running or when no public proxies pass the checks.

## Install

1. Upload the ZIP to the server's root directory (`/home/container` in most Node eggs) and extract it there. `package.json`, `src/`, `public/`, and `config/` should be directly in that directory, not inside another folder.
2. Duplicate `.env.example` as `.env`. The dot prefix matters; enable hidden files in the panel if needed. Edit these values:

   ```dotenv
   PROXY_USER=your_proxy_username
   PROXY_PASS=your_proxy_password
   API_KEY=your_api_key
   PROXY_PORT=SECOND_ALLOCATED_PORT
   HOST=0.0.0.0
   ```

   Replace `SECOND_ALLOCATED_PORT` with the actual number, and choose your own credentials. Do not use `change-me`. The dashboard itself has no login. `API_KEY` is required for the separate API; the gateway requires the proxy username and password.
3. In `.env`, **delete the `API_PORT=8000` line** if your Node egg provides `SERVER_PORT`; the app will then use the primary allocation automatically. Otherwise, set `API_PORT` to the numeric primary allocation. `API_PORT` overrides `SERVER_PORT` if both are set. The dashboard and proxy ports must be different.
4. If your egg has a **Main File** or **Startup File** field, set it to `src/index.js` (not `index.js`). If the egg instead lets you set the full startup command, use:

   ```sh
   npm ci --omit=dev && npm start
   ```

   If the egg already installs dependencies and starts its Main File, leave that behavior enabled; do not put an npm command in the Main File field. Otherwise, install dependencies with `npm ci --omit=dev` and configure it to run `npm start` in the project root. Package installation needs access to the npm registry. Do not use an egg that only starts a fixed Java `.jar` file.
5. Start the server. Open `http://YOUR_SERVER_ADDRESS:PRIMARY_PORT/` for the dashboard. Use the allocated IP/domain and port shown by your host; if the host maps ports externally, use its public address/port instead of assuming the internal value.
6. Configure your scraper to use `http://your_proxy_username:your_proxy_password@YOUR_SERVER_ADDRESS:SECOND_PORT` as its HTTP proxy. The gateway supports HTTPS destinations via CONNECT. Replace the placeholders with your actual values.

The dashboard and `/dashboard/*` routes do not require a login. Anyone who can reach the dashboard port can view or export the pool and trigger a refresh; restrict access if needed. Proxy credentials sent over plain HTTP are not encrypted. The dashboard can come up before a scan finishes; an empty pool causes the gateway to return 503. Check panel logs and host outbound network policy if all feed requests fail.
