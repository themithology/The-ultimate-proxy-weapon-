const $ = selector => document.querySelector(selector);
const colors = { http: '#c6f279', https: '#88b970', socks4: '#779c82', socks5: '#4f786e' };
let state = { proxies: [], filter: 'all', query: '', data: null, shown: 200 };
let showingCycleError = false;
const number = value => new Intl.NumberFormat().format(value);
const svgCopy = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
function ago(value) {
  if (!value) return 'Never';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return 'Unknown';
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}
function showNotice(message, error = false) { const el = $('#notice'); el.hidden = false; el.textContent = message; el.classList.toggle('error', error); }
async function copy(text) {
  try { await navigator.clipboard.writeText(text); showNotice('Copied to clipboard.'); }
  catch { showNotice('Could not copy automatically. Please copy the address manually.', true); }
}
function render() {
  const { proxies, data } = state; if (!data) return;
  const counts = { http: 0, https: 0, socks4: 0, socks5: 0 };
  for (const item of proxies) if (Object.hasOwn(counts, item.protocol)) counts[item.protocol]++;
  $('#active-count').textContent = number(proxies.length);
  const latencies = proxies.map(p => p.latencyMs).filter(Number.isFinite);
  $('#avg-latency').innerHTML = latencies.length ? `${Math.round(latencies.reduce((a,b) => a+b, 0) / latencies.length)} <small>ms</small>` : '—';
  $('#rotation').textContent = (data.rotation || 'round-robin').replace(/\b\w/g, c => c.toUpperCase());
  $('#last-refresh').textContent = ago(data.lastScrape);
  $('#last-refresh-detail').textContent = data.lastScrape ? new Date(data.lastScrape).toLocaleString() : 'Waiting for first scrape';
  $('#composition-total').textContent = number(proxies.length); $('#pool-count').textContent = number(proxies.length);
  $('#pool-health').textContent = proxies.length ? 'Pool is active' : 'Awaiting proxies';
  $('#pool-health-copy').textContent = proxies.length ? 'Verified endpoints are ready for your requests.' : 'Your validated proxies will appear here.';
  const dist = $('#distribution'); dist.replaceChildren();
  const legend = $('#legend'); legend.replaceChildren();
  for (const [protocol, count] of Object.entries(counts)) {
    const segment = document.createElement('span'); segment.style.background = colors[protocol]; segment.style.width = `${proxies.length ? count / proxies.length * 100 : 0}%`; dist.append(segment);
    const item = document.createElement('div'); item.className = 'legend-item';
    const dot = document.createElement('span'); dot.className = 'legend-dot'; dot.style.background = colors[protocol];
    const label = document.createElement('span'); label.textContent = protocol.toUpperCase(); const val = document.createElement('b'); val.textContent = number(count); item.append(dot, label, val); legend.append(item);
    $(`#tab-${protocol}`).textContent = number(count);
  }
  $('#tab-all').textContent = number(proxies.length);
  const busy = !!data.cycle?.busy; $('#refresh').disabled = busy; $('#refresh span').textContent = busy ? 'Refresh in progress' : 'Refresh proxies';
  if (busy && data.cycle.stage === 'fetching') {
    showNotice(`Fetching sources: ${number(data.cycle.sourcesCompleted || 0)} / ${number(data.cycle.sourcesTotal || 0)} finished · ${number(data.cycle.sourcesSucceeded || 0)} succeeded.`);
    showingCycleError = true;
  } else if (busy && data.cycle.stage === 'validating') {
    const seconds = Math.max(1, (Date.now() - Date.parse(data.cycle.validationStartedAt || Date.now())) / 1000);
    const rate = Math.round((data.cycle.checked || 0) / seconds);
    showNotice(`Checking proxies: ${number(data.cycle.checked || 0)} / ${number(data.cycle.candidates || 0)} tested · ${number(data.cycle.found || 0)} working · ${number(rate)} checks/sec.`);
    showingCycleError = true;
  } else if (data.cycle?.error) { showNotice(`Last cycle failed: ${data.cycle.error}`, true); showingCycleError = true; }
  else if (showingCycleError) { $('#notice').hidden = true; showingCycleError = false; }
  $('#gateway-address').textContent = `${location.origin}/fetch?url=https%3A%2F%2Fexample.com`;
  renderTable();
}
function renderTable() {
  const filtered = state.proxies.filter(p => (state.filter === 'all' || p.protocol === state.filter) && p.url.toLowerCase().includes(state.query));
  const rows = $('#proxy-rows'); rows.replaceChildren();
  for (const p of filtered.slice(0, state.shown)) {
    const tr = document.createElement('tr');
    const cell = (text, className) => { const td = document.createElement('td'); td.textContent = text; if (className) td.className = className; tr.append(td); return td; };
    cell(p.url, 'address'); const proto = cell(''); const tag = document.createElement('span'); tag.className = 'protocol'; tag.textContent = p.protocol; proto.append(tag);
    cell(Number.isFinite(p.latencyMs) ? `${p.latencyMs} ms` : '—');
    const rate = p.health?.recentSuccessRate; cell(typeof rate === 'number' ? `${Math.round(rate * 100)}%` : 'Not enough data', typeof rate === 'number' ? 'health-rate' : '');
    cell(ago(p.lastChecked)); const action = cell(''); const button = document.createElement('button'); button.className = 'copy-row'; button.title = 'Copy proxy address'; button.setAttribute('aria-label', `Copy ${p.url}`); button.innerHTML = svgCopy; button.addEventListener('click', () => copy(p.url)); action.append(button); rows.append(tr);
  }
  const empty = $('#empty'); empty.hidden = filtered.length > 0;
  if (!filtered.length) {
    empty.querySelector('strong').textContent = state.proxies.length ? 'No proxies match your search' : 'No proxies in your pool yet';
    empty.querySelector('p').textContent = state.proxies.length ? 'Try another protocol or search term.' : 'Your first scan runs automatically. Validated proxies will show up here as they’re found.';
  }
  $('#load-more').hidden = filtered.length <= state.shown;
  $('#showing').textContent = `Showing ${number(Math.min(filtered.length, state.shown))} of ${number(filtered.length)} proxies`;
}
async function update() {
  try {
    const response = await fetch('/dashboard/data', { cache: 'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json(); state.proxies = state.data.proxies || []; $('#connection-status').textContent = 'SYSTEM ONLINE'; $('.top-right .live-dot').style.background = ''; render();
  } catch { $('#connection-status').textContent = 'CONNECTION LOST'; $('.top-right .live-dot').style.background = '#e39183'; }
}
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => { state.filter = tab.dataset.filter; state.shown = 200; document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab)); renderTable(); });
$('#search').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); state.shown = 200; renderTable(); });
$('#refresh').addEventListener('click', async () => {
  const button = $('#refresh'); button.disabled = true;
  try { const response = await fetch('/dashboard/refresh', { method: 'POST' }); if (response.status === 409) showNotice('A refresh or revalidation is already in progress.'); else if (!response.ok) throw new Error(`HTTP ${response.status}`); else showNotice('Refresh started. New proxies will appear as they are validated.'); await update(); }
  catch { showNotice('Could not start refresh. Please try again.', true); button.disabled = false; }
});
$('#load-more').addEventListener('click', () => { state.shown += 200; renderTable(); });
$('#copy-gateway').addEventListener('click', () => copy($('#gateway-address').textContent));
function clock() { $('#clock').textContent = `${new Date().toISOString().slice(11, 19)} UTC`; }
clock(); setInterval(clock, 1000); update(); setInterval(update, 5000);
