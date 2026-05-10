// status.moleculesai.app — read-only status page for Molecules AI services.
//
// Pulls the probe-list config + per-site history JSONL from the
// molecule-ai-status repo on Gitea, renders a one-row-per-service
// dashboard with current state + a 24h-history sparkline.
//
// Why no framework: this page is plain DOM + fetch. Zero build step,
// zero dependencies, zero supply-chain surface. The thing it MUST do
// well is "load fast, show correct status, never lie." React/Vue
// would be cargo-culting at this scale.
//
// Data source: same-origin /data/* paths, Vercel-rewritten to
// git.moleculesai.app raw URLs. The rewrite avoids cross-origin
// browser fetches (Gitea doesn't send Access-Control-Allow-Origin
// on raw file responses). vercel.json owns the rewrite map.

const HISTORY_URL = (slug) => `/data/history/${slug}.jsonl`;
const CONFIG_URL = `/data/.upptimerc.yml`;
const REPO_BROWSE = "https://git.moleculesai.app/molecule-ai/molecule-ai-status";

// Window of history we render in the sparkline (24h of probes at one
// per 5 minutes ≈ 288). Cap to keep the DOM bounded if a site has
// been probing for years.
const SPARKLINE_LIMIT = 288;

// Slugify must match the probe binary's slugify() in cmd/probe/main.go
// — the page reads files the probe writes, so the slugging rule is
// load-bearing. Mirror in tests if/when this gets a follow-up.
function slugify(s) {
  let out = "";
  let last = "-";
  for (const c of s.toLowerCase()) {
    const isAlnum = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
    if (isAlnum) {
      out += c;
      last = c;
    } else if (last !== "-") {
      out += "-";
      last = "-";
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

// Minimal YAML parser for the subset of .upptimerc.yml we read:
// only the `sites:` list of `{name, url}`. Anything more elaborate
// (anchors, multiline strings, etc.) is overkill — the upstream
// upptime config schema is intentionally simple.
function parseSites(yamlText) {
  const sites = [];
  let inSites = false;
  let current = null;
  for (const rawLine of yamlText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("#")) continue;
    if (/^\s*$/.test(line)) continue;

    if (/^sites:\s*$/.test(line)) {
      inSites = true;
      continue;
    }
    if (inSites && /^[a-zA-Z]/.test(line)) {
      // hit a top-level key after sites: — bail
      inSites = false;
    }
    if (!inSites) continue;

    const itemStart = line.match(/^\s*-\s+name:\s*(.+)$/);
    if (itemStart) {
      if (current) sites.push(current);
      current = { name: itemStart[1].trim().replace(/^["']|["']$/g, "") };
      continue;
    }
    const urlMatch = line.match(/^\s+url:\s*(.+)$/);
    if (urlMatch && current) {
      current.url = urlMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  if (current) sites.push(current);
  return sites.filter((s) => s.name && s.url);
}

// Parse a JSONL response into an array of Result objects. Tolerant of
// trailing newlines + (rarely) blank lines from a partial-write race.
function parseJSONL(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line — better than the whole page erroring
    }
  }
  return out;
}

// Best-effort fetch — returns null on failure (no exceptions).
async function fetchText(url) {
  try {
    const resp = await fetch(url, { cache: "no-cache" });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// Render a row for one site given its latest results.
function renderRow(site, results) {
  const last = results[results.length - 1];
  const status = !last ? "unknown" : last.success ? "up" : "down";
  const latency = last && last.success ? `${last.latency_ms} ms` : "—";

  // Sparkline: last SPARKLINE_LIMIT entries, one bar per. Bar height
  // proportional to latency (clamped). Failing checks render red and
  // taller (so eye is drawn to outages).
  const recent = results.slice(-SPARKLINE_LIMIT);
  const succ = recent.filter((r) => r.success);
  const maxLat = Math.max(50, ...succ.map((r) => r.latency_ms));

  const spark = recent
    .map((r) => {
      const cls = r.success ? "" : "fail";
      const h = !r.success ? 20 : Math.max(2, Math.round((r.latency_ms / maxLat) * 18));
      return `<span class="${cls}" style="height:${h}px" title="${r.timestamp} · ${r.success ? r.latency_ms + "ms" : "FAIL: " + (r.error || "")}"></span>`;
    })
    .join("");

  return `
    <div class="row" data-status="${status}">
      <div class="dot ${status}" title="${status}"></div>
      <div class="row-name">
        <a href="${site.url}" target="_blank" rel="noopener noreferrer">${escape(site.name)}</a>
        <span class="url">${escape(site.url)}</span>
      </div>
      <div class="row-spark" title="last ${recent.length} checks (newest right)">${spark}</div>
      <div class="row-latency">${latency}</div>
    </div>
  `;
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function renderSummary(rows) {
  const total = rows.length;
  const up = rows.filter((r) => r.status === "up").length;
  const down = rows.filter((r) => r.status === "down").length;
  const unknown = rows.filter((r) => r.status === "unknown").length;

  let dot, text, sub;
  if (total === 0) {
    dot = "var(--ink-soft)";
    text = "No services configured";
    sub = "Add `.upptimerc.yml` entries.";
  } else if (down === 0 && unknown === 0) {
    dot = "var(--green)";
    text = "All systems operational";
    sub = `${up} of ${total} services responding normally.`;
  } else if (down === 0) {
    dot = "var(--amber)";
    text = "Status partially unknown";
    sub = `${up} up · ${unknown} no recent data.`;
  } else if (up === 0) {
    dot = "var(--red)";
    text = "Major outage";
    sub = `${down} services failing.`;
  } else {
    dot = "var(--amber)";
    text = "Partial outage";
    sub = `${up} up · ${down} down · ${unknown} unknown.`;
  }
  return `
    <div class="summary-dot" style="background:${dot}"></div>
    <div class="summary-text">
      <strong>${text}</strong>
      <small>${sub}</small>
    </div>
  `;
}

async function load() {
  // 1. Fetch + parse the probe-list config.
  const yaml = await fetchText(CONFIG_URL);
  if (!yaml) {
    document.getElementById("grid").innerHTML =
      `<div class="empty">Failed to load probe-list config. Check that <code>${CONFIG_URL}</code> is reachable (Vercel rewrites <code>/data/*</code> to ${REPO_BROWSE}/raw/branch/main/<em>$1</em>).</div>`;
    document.getElementById("updated").textContent = "load failed";
    return;
  }
  const sites = parseSites(yaml);
  if (sites.length === 0) {
    document.getElementById("grid").innerHTML =
      `<div class="empty">No sites declared in <code>.upptimerc.yml</code>.</div>`;
    return;
  }

  // 2. For each site, fetch its history JSONL in parallel.
  const enriched = await Promise.all(
    sites.map(async (site) => {
      const slug = slugify(site.name);
      const text = await fetchText(HISTORY_URL(slug));
      const results = text ? parseJSONL(text) : [];
      return { site, slug, results };
    })
  );

  // 3. Render rows + summary.
  const rowSummaries = enriched.map(({ results }) => {
    const last = results[results.length - 1];
    return {
      status: !last ? "unknown" : last.success ? "up" : "down",
    };
  });

  document.getElementById("summary").innerHTML = renderSummary(rowSummaries);
  document.getElementById("grid").innerHTML = enriched
    .map(({ site, results }) => renderRow(site, results))
    .join("");

  // Updated-at timestamp: latest probe across all sites.
  const allTimestamps = enriched
    .flatMap(({ results }) => results)
    .map((r) => r.timestamp)
    .filter(Boolean);
  if (allTimestamps.length > 0) {
    const latest = allTimestamps.sort().pop();
    const ago = Math.round((Date.now() - new Date(latest).getTime()) / 60000);
    document.getElementById("updated").innerHTML =
      `last probe ${ago} min ago · <a href="${REPO_BROWSE}/src/branch/main/history">history</a>`;
  } else {
    document.getElementById("updated").innerHTML =
      `no probe data yet · <a href="${REPO_BROWSE}">source</a>`;
  }
}

load();
// Auto-refresh every 5 min — matches the probe cadence so the page
// catches up with new history without a hard reload.
setInterval(load, 5 * 60 * 1000);
