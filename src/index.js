/**
 * Job Pipeline v2 — private dashboard for Lucas's Notion job-tracker database.
 *
 * v2 adds: needs-attention queue, weekly velocity chart, reply-rate-by-source
 * breakdown, kanban search, and (optional) daily KV snapshots via cron for
 * future trend lines.
 *
 * Schema (DB Applications):
 *   Company (title) · Position · Status · Application Date · Salary
 *   Next Action · Website · Contact · Reference Link
 *
 * Funnel derivation:
 *   - "Progressing" = the interviewing stage
 *   - Applied rows older than STALE_DAYS (default 30) count as "No Answer"
 *   - Fresh Applied rows are "Awaiting Reply"
 *   - Optional "Interviewed" checkbox on Rejected rows routes the rejection
 *     through the Progressing stage
 *
 * Attention queue:
 *   - Next Action = "Follow up" (any non-terminal bucket)
 *   - Awaiting rows aged ATTENTION_MIN_DAYS..STALE_DAYS (nudge window)
 *
 * Routes:
 *   GET /             → dashboard HTML
 *   GET /api/stats    → aggregated stats + job cards (JSON, cached 5 min)
 *   GET /api/history  → daily snapshots from KV (if binding configured)
 *
 * Secrets:  NOTION_TOKEN, NOTION_DATABASE_ID
 * Vars:     NOTION_VIEW_URL (optional), STALE_DAYS (default 30)
 * Bindings: SNAPSHOTS (KV, optional — enables cron snapshots + /api/history)
 *
 * Auth is Cloudflare Access in front of this Worker (see README).
 */

const NOTION_VERSION = "2022-06-28";
const CACHE_TTL_SECONDS = 300;
// Bump whenever the /api/stats payload shape changes — keys the edge cache,
// so a deploy never serves an old-shaped cached response to new frontend code.
const SCHEMA_VERSION = "5";
const DEFAULT_STALE_DAYS = 30;
const ATTENTION_MIN_DAYS = 10;
const MAX_SOURCES = 6;

const STATUS_PROP = "Status";
const DATE_PROP = "Application Date";
const POSITION_PROP = "Position";
const NEXT_ACTION_PROP = "Next Action";
const SOURCE_PROP = "Reference Link";
const INTERVIEWED_PROP = "Interviewed"; // optional checkbox, absent today

const STATUS_BUCKETS = {
  "applied": "applied",
  "pending": "pending",
  "interviewed": "interviewed",
  "progressing": "progressing",
  "interviewing": "interviewed",
  "offer accepted": "offerAccepted",
  "offer declined": "offerDeclined",
  "rejected": "rejected",
  "no answer": "noAnswer",
  "ghosted": "noAnswer",
};

// "Heard back" = any human reply, including rejections. Used for the first
// stat card, the sources chart, and the velocity overlay. Distinct from the
// interview rate (which requires reaching the Interviewed stage).
const HEARD_BACK_BUCKETS = new Set([
  "pending", "interviewed", "progressing", "rejected", "offerAccepted", "offerDeclined",
]);

const BUCKET_SPEC = [
  { key: "awaiting", label: "Awaiting Reply", color: "amber" },
  { key: "pending", label: "Pending", color: "blue" },
  { key: "interviewed", label: "Interviewed", color: "olive" },
  { key: "progressing", label: "Progressing", color: "plum" },
  { key: "offerAccepted", label: "Offer Accepted", color: "teal" },
  { key: "offerDeclined", label: "Offer Declined", color: "rust" },
  { key: "rejected", label: "Rejected", color: "rust" },
  { key: "noAnswer", label: "No Answer", color: "stone" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/stats") {
      return handleStats(request, env, ctx);
    }

    if (url.pathname === "/api/history") {
      return handleHistory(env);
    }

    // Manual snapshot trigger (Access-protected like everything else).
    // Same write as the daily cron — safe to hit anytime; same-day runs overwrite.
    if (url.pathname === "/api/snapshot") {
      try {
        const result = await takeSnapshot(env);
        return json(result, result.error ? 500 : 200);
      } catch (err) {
        return json({ error: `Snapshot failed: ${err.message}` }, 502);
      }
    }

    if (url.pathname === "/") {
      const html = PAGE_HTML.replace(
        "__NOTION_URL__",
        JSON.stringify(env.NOTION_VIEW_URL || "")
      );
      return new Response(html, {
        headers: {
          "content-type": "text/html;charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Daily snapshot → KV, for trend lines that Notion alone can't reconstruct
  // (statuses mutate in place). Requires a SNAPSHOTS KV binding + cron trigger.
  async scheduled(event, env, ctx) {
    await takeSnapshot(env);
  },
};

async function takeSnapshot(env) {
  if (!env.SNAPSHOTS) return { error: "No SNAPSHOTS KV binding configured." };
  if (!env.NOTION_TOKEN || !env.NOTION_DATABASE_ID) return { error: "Missing Notion secrets." };
  const pages = await queryAllPages(env);
  const staleDays = Number(env.STALE_DAYS) > 0 ? Number(env.STALE_DAYS) : DEFAULT_STALE_DAYS;
  const stats = aggregate(pages, { staleDays, now: Date.now() });
  const date = new Date().toISOString().slice(0, 10);
  const snapshot = {
    date,
    total: stats.total,
    counts: stats.counts,
    metrics: stats.metrics,
  };
  await env.SNAPSHOTS.put("snap:" + date, JSON.stringify(snapshot));
  return { ok: true, snapshot };
}

async function handleStats(request, env, ctx) {
  if (!env.NOTION_TOKEN || !env.NOTION_DATABASE_ID) {
    return json({ error: "Worker is missing NOTION_TOKEN / NOTION_DATABASE_ID secrets." }, 500);
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/stats?v=" + SCHEMA_VERSION, request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let pages;
  try {
    pages = await queryAllPages(env);
  } catch (err) {
    return json({ error: `Notion query failed: ${err.message}` }, 502);
  }

  const staleDays = Number(env.STALE_DAYS) > 0 ? Number(env.STALE_DAYS) : DEFAULT_STALE_DAYS;
  const stats = aggregate(pages, { staleDays, now: Date.now() });
  const response = json(stats, 200, {
    "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleHistory(env) {
  if (!env.SNAPSHOTS) return json({ enabled: false, snapshots: [] });
  const list = await env.SNAPSHOTS.list({ prefix: "snap:", limit: 1000 });
  const snapshots = (
    await Promise.all(list.keys.map((k) => env.SNAPSHOTS.get(k.name, "json")))
  ).filter(Boolean);
  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  return json({ enabled: true, snapshots });
}

async function queryAllPages(env) {
  const results = [];
  let cursor = undefined;

  do {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

// ---- Property readers ----

function readStatus(page) {
  const prop = page.properties?.[STATUS_PROP];
  if (!prop) return null;
  if (prop.type === "status") return prop.status?.name ?? null;
  if (prop.type === "select") return prop.select?.name ?? null;
  return null;
}

function readSelect(page, name) {
  const prop = page.properties?.[name];
  if (prop?.type === "select") return prop.select?.name ?? null;
  if (prop?.type === "status") return prop.status?.name ?? null;
  return null;
}

function readTitle(page) {
  for (const prop of Object.values(page.properties || {})) {
    if (prop.type === "title") {
      return (prop.title || []).map((t) => t.plain_text).join("").trim();
    }
  }
  return "";
}

function readRichText(page, name) {
  const prop = page.properties?.[name];
  if (prop?.type === "rich_text") {
    return (prop.rich_text || []).map((t) => t.plain_text).join("").trim();
  }
  return "";
}

function readUrl(page, name) {
  const prop = page.properties?.[name];
  return prop?.type === "url" ? prop.url || null : null;
}

function readDateMs(page) {
  const start = page.properties?.[DATE_PROP]?.date?.start;
  if (!start) return null;
  const ms = Date.parse(start);
  return Number.isFinite(ms) ? ms : null;
}

function readInterviewed(page) {
  const prop = page.properties?.[INTERVIEWED_PROP];
  return prop?.type === "checkbox" ? Boolean(prop.checkbox) : false;
}

// ---- Derivation helpers ----

function classify(page, { staleMs, now }) {
  const name = (readStatus(page) || "").trim().toLowerCase();
  const bucket = STATUS_BUCKETS[name];
  if (bucket === "applied") {
    const ms = readDateMs(page);
    const isStale = ms !== null && now - ms > staleMs;
    return isStale ? "noAnswer" : "awaiting";
  }
  return bucket ?? null;
}

// Registrable-ish domain: ca.indeed.com → indeed.com, www.linkedin.com → linkedin.com
function sourceDomain(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : host;
  } catch {
    return null;
  }
}

// Monday of the week containing the given ISO date (UTC).
function weekStartISO(iso) {
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function aggregate(pages, { staleDays, now }) {
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;

  const counts = {
    awaiting: 0,
    pending: 0,
    interviewed: 0,
    progressing: 0,
    offerAccepted: 0,
    offerDeclined: 0,
    rejected: 0,
    rejectedAfterInterview: 0,
    noAnswer: 0,
    unknown: 0,
  };
  const jobs = [];
  const attention = [];
  const weekMap = new Map(); // weekStart → { applied, replied }
  const sourceMap = new Map(); // domain → { total, replied }

  for (const page of pages) {
    const bucket = classify(page, { staleMs, now });
    if (!bucket) {
      counts.unknown++;
      continue;
    }
    counts[bucket]++;
    if (bucket === "rejected" && readInterviewed(page)) {
      counts.rejectedAfterInterview++;
    }

    const dateIso = page.properties?.[DATE_PROP]?.date?.start ?? null;
    const dateMs = readDateMs(page);
    const ageDays = dateMs !== null ? Math.floor((now - dateMs) / dayMs) : null;
    const replied = HEARD_BACK_BUCKETS.has(bucket);
    const nextAction = readSelect(page, NEXT_ACTION_PROP);

    const job = {
      company: readTitle(page) || "Untitled",
      position: readRichText(page, POSITION_PROP),
      bucket,
      date: dateIso,
      ageDays,
      url: page.url ?? null,
    };
    jobs.push(job);

    // Attention queue.
    const isTerminal = bucket === "rejected" || bucket === "offerAccepted" || bucket === "offerDeclined";
    if (nextAction === "Follow up" && !isTerminal) {
      attention.push({ ...job, reason: "followup" });
    } else if (bucket === "awaiting" && ageDays !== null && ageDays >= ATTENTION_MIN_DAYS) {
      attention.push({ ...job, reason: "aging" });
    }

    // Weekly velocity (by application week; replied = eventually got any reply).
    if (dateIso) {
      const week = weekStartISO(dateIso);
      if (week) {
        const w = weekMap.get(week) || { applied: 0, replied: 0 };
        w.applied++;
        if (replied) w.replied++;
        weekMap.set(week, w);
      }
    }

    // Source breakdown.
    const domain = sourceDomain(readUrl(page, SOURCE_PROP)) || "unknown";
    const src = sourceMap.get(domain) || { total: 0, replied: 0 };
    src.total++;
    if (replied) src.replied++;
    sourceMap.set(domain, src);
  }

  jobs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  // Follow-ups first, then oldest aging first.
  attention.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === "followup" ? -1 : 1;
    return (b.ageDays ?? 0) - (a.ageDays ?? 0);
  });

  // Continuous weekly series from first to last week.
  const weekly = [];
  if (weekMap.size) {
    const keys = [...weekMap.keys()].sort();
    let cur = keys[0];
    const last = keys[keys.length - 1];
    while (cur <= last) {
      const w = weekMap.get(cur) || { applied: 0, replied: 0 };
      weekly.push({ week: cur, applied: w.applied, replied: w.replied });
      const d = new Date(cur + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 7);
      cur = d.toISOString().slice(0, 10);
    }
  }

  // Top sources by volume; the rest folded into "other".
  const sorted = [...sourceMap.entries()].sort((a, b) => b[1].total - a[1].total);
  const sources = [];
  let other = { total: 0, replied: 0 };
  for (const [domain, s] of sorted) {
    if (sources.length < MAX_SOURCES && domain !== "unknown") {
      sources.push({ domain, ...s });
    } else {
      other.total += s.total;
      other.replied += s.replied;
    }
  }
  if (other.total) sources.push({ domain: "other", ...other });

  const total =
    counts.awaiting +
    counts.pending +
    counts.interviewed +
    counts.progressing +
    counts.offerAccepted +
    counts.offerDeclined +
    counts.rejected +
    counts.noAnswer;

  const offers = counts.offerAccepted + counts.offerDeclined;
  // Ladder: Pending → Interviewed → Progressing → Offers. A row's current
  // status implies it passed through the earlier stages.
  const everProgressing = counts.progressing + offers;
  const everInterviewed = counts.interviewed + everProgressing + counts.rejectedAfterInterview;
  const everPending = counts.pending + everInterviewed;
  const heardBack =
    counts.pending + counts.interviewed + counts.progressing + offers + counts.rejected;
  const rejectedBeforeInterview = counts.rejected - counts.rejectedAfterInterview;

  return {
    generatedAt: new Date(now).toISOString(),
    staleDays,
    total,
    counts,
    buckets: BUCKET_SPEC.map((b) => ({
      ...b,
      label: b.key === "noAnswer" ? `No Answer (>${staleDays}d)` : b.label,
      count: counts[b.key],
    })),
    jobs,
    attention,
    weekly,
    sources,
    metrics: {
      heardBack,
      interviewed: everInterviewed,
      offers,
      heardBackRate: total ? heardBack / total : 0,
      interviewRate: total ? everInterviewed / total : 0,
      offerRate: total ? offers / total : 0,
    },
    sankey: {
      nodes: [
        { id: "applications", label: "Applications" },
        { id: "pending", label: "Pending" },
        { id: "interviewed", label: "Interviewed" },
        { id: "progressing", label: "Progressing" },
        { id: "awaiting", label: "Awaiting Reply" },
        { id: "rejected", label: "Rejected" },
        { id: "noAnswer", label: "No Answer" },
        { id: "offers", label: "Offers" },
        { id: "accepted", label: "Offer Accepted" },
        { id: "declined", label: "Offer Declined" },
      ],
      links: [
        { source: "applications", target: "pending", value: everPending },
        { source: "applications", target: "awaiting", value: counts.awaiting },
        { source: "applications", target: "rejected", value: rejectedBeforeInterview },
        { source: "applications", target: "noAnswer", value: counts.noAnswer },
        { source: "pending", target: "interviewed", value: everInterviewed },
        { source: "interviewed", target: "progressing", value: everProgressing },
        { source: "interviewed", target: "rejected", value: counts.rejectedAfterInterview },
        { source: "progressing", target: "offers", value: offers },
        { source: "offers", target: "accepted", value: counts.offerAccepted },
        { source: "offers", target: "declined", value: counts.offerDeclined },
      ],
    },
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json;charset=utf-8", ...extraHeaders },
  });
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Job Pipeline</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@500;600&family=Spline+Sans+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #141416; --panel: #1c1c20; --panel-edge: #2a2a31; --card: #232329;
    --text: #e9e7e2; --muted: #8d8c96; --faint: #5b5a63;
    --plum: #96688c; --rust: #9c5a52; --stone: #63636d; --olive: #85944f;
    --teal: #4d8b78; --blue: #517ea6; --green: #57b784; --amber: #c2a24b;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: "Instrument Sans", system-ui, sans-serif;
    min-height: 100vh; padding: 28px clamp(16px, 4vw, 48px) 48px;
  }
  .mono { font-family: "Spline Sans Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }

  header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: 0.01em; margin: 0; }
  .board-link {
    color: var(--muted); text-decoration: none; font-size: 13px;
    border: 1px solid var(--panel-edge); border-radius: 8px; padding: 7px 12px;
    transition: color 120ms, border-color 120ms;
  }
  .board-link:hover, .board-link:focus-visible { color: var(--text); border-color: var(--faint); }
  .board-link:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

  .panel { background: var(--panel); border: 1px solid var(--panel-edge); border-radius: 14px; padding: 18px 20px; }
  .panel h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--muted); letter-spacing: 0.04em; text-transform: uppercase; }

  /* Attention queue */
  #attention { margin-bottom: 14px; border-color: #3a3323; display: none; }
  #attention h2 { color: var(--amber); }
  .attn-row { display: flex; gap: 10px; overflow-x: auto; padding: 6px 0 2px; scrollbar-width: thin; }
  .attn-card {
    flex: 0 0 auto; min-width: 190px; max-width: 240px;
    display: block; text-decoration: none;
    background: var(--card); border: 1px solid var(--panel-edge);
    border-radius: 10px; padding: 9px 12px; transition: border-color 120ms;
  }
  .attn-card:hover, .attn-card:focus-visible { border-color: var(--amber); }
  .attn-card:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
  .attn-card .co { font-size: 13px; font-weight: 600; color: var(--text); margin: 0 0 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .attn-card .role { font-size: 11.5px; color: var(--muted); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .attn-card .why { font-size: 11px; margin: 6px 0 0; display: inline-block; border-radius: 999px; padding: 1px 8px; }
  .why.followup { color: var(--amber); border: 1px solid #4a3f1f; }
  .why.aging { color: var(--muted); border: 1px solid var(--panel-edge); }

  .grid { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr) 250px; align-items: stretch; }
  @media (max-width: 880px) { .grid { grid-template-columns: 1fr; } }

  #sankey-panel { min-height: 380px; display: flex; flex-direction: column; }
  #sankey { flex: 1; width: 100%; }
  #sankey text { font-family: "Spline Sans Mono", ui-monospace, monospace; pointer-events: none; }
  .node-value { font-size: 14px; font-weight: 600; fill: var(--text); }
  .node-label { font-size: 11px; fill: var(--muted); }
  .ribbon { transition: stroke-opacity 140ms ease; cursor: default; }
  .ribbon:hover { stroke-opacity: 0.85 !important; }

  .stats { display: flex; flex-direction: column; gap: 14px; }
  .stat-card { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .stat-card .meta { min-width: 0; }
  .stat-card .name { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
  .stat-card .sub { font-size: 12px; color: var(--muted); margin: 0; }
  .donut { flex: none; }
  .donut .value { font-size: 14px; font-weight: 600; fill: var(--text); }

  /* Velocity + sources row */
  .row2 { display: grid; gap: 14px; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); margin-top: 14px; }
  @media (max-width: 880px) { .row2 { grid-template-columns: 1fr; } }
  #velocity svg { width: 100%; height: 150px; display: block; margin-top: 8px; }
  .vbar { cursor: default; }
  .legend { display: flex; gap: 14px; font-size: 11.5px; color: var(--muted); margin-top: 8px; }
  .legend .k { display: inline-flex; align-items: center; gap: 6px; }
  .legend .sw { width: 10px; height: 10px; border-radius: 3px; }

  .src-row { display: grid; grid-template-columns: 110px 1fr 86px; gap: 10px; align-items: center; margin-top: 9px; font-size: 12.5px; }
  .src-row .dom { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .src-bar { height: 12px; background: #26262c; border-radius: 6px; overflow: hidden; position: relative; }
  .src-bar .fill { position: absolute; inset: 0 auto 0 0; background: var(--stone); opacity: .45; border-radius: 6px; }
  .src-bar .rep { position: absolute; inset: 0 auto 0 0; background: var(--amber); border-radius: 6px; }
  .src-row .rate { color: var(--muted); text-align: right; }

  /* Kanban */
  #tracker { margin-top: 26px; }
  #tracker .tracker-head { display: flex; align-items: center; gap: 14px; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; }
  #tracker h2 { font-size: 18px; font-weight: 600; margin: 0; color: var(--text); text-transform: none; letter-spacing: 0; }
  #search {
    background: var(--panel); border: 1px solid var(--panel-edge); border-radius: 9px;
    color: var(--text); font: inherit; font-size: 13px; padding: 8px 12px; width: min(340px, 100%);
  }
  #search::placeholder { color: var(--faint); }
  #search:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
  .board { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px; scrollbar-width: thin; }
  .col {
    flex: 1 0 215px; min-width: 215px;
    border: 1px dashed var(--panel-edge); border-radius: 12px;
    padding: 10px; display: flex; flex-direction: column; gap: 8px; max-height: 460px;
  }
  .col-head { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); padding: 2px 4px 6px; }
  .col-head .dot { width: 8px; height: 8px; border-radius: 50%; }
  .col-head .n {
    margin-left: auto; color: var(--text); font-weight: 600;
    background: var(--panel); border: 1px solid var(--panel-edge);
    border-radius: 999px; padding: 1px 8px; font-size: 11.5px;
  }
  .cards { overflow-y: auto; display: flex; flex-direction: column; gap: 8px; scrollbar-width: thin; }
  .card {
    display: block; text-decoration: none;
    background: var(--card); border: 1px solid var(--panel-edge);
    border-radius: 10px; padding: 10px 12px; transition: border-color 120ms;
  }
  .card:hover, .card:focus-visible { border-color: var(--faint); }
  .card:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .card .co { font-size: 13.5px; font-weight: 600; color: var(--text); margin: 0 0 2px; }
  .card .role { font-size: 12px; color: var(--muted); margin: 0; }
  .card .when { font-size: 11px; color: var(--faint); margin: 5px 0 0; }
  .empty-col { color: var(--faint); font-size: 12.5px; text-align: center; padding: 22px 0; }

  #tip {
    position: fixed; z-index: 10; pointer-events: none;
    background: #26262c; border: 1px solid #35353d; border-radius: 9px;
    padding: 9px 11px; font-size: 12.5px; color: var(--text);
    box-shadow: 0 6px 22px rgba(0,0,0,0.45);
    max-width: 260px; display: none; line-height: 1.45;
  }
  #tip .t-head { font-weight: 600; }
  #tip .t-sub { color: var(--muted); }
  #tip .t-list { color: var(--muted); margin-top: 4px; }

  .state { color: var(--muted); font-size: 14px; padding: 32px 0; text-align: center; }
  .state.error { color: #c98a8a; }
  footer { margin-top: 18px; font-size: 12px; color: var(--faint); }

  @media (prefers-reduced-motion: no-preference) {
    .ribbon.draw { animation: draw 700ms ease both; }
    @keyframes draw { from { stroke-opacity: 0; } }
  }
</style>
</head>
<body>
<header>
  <h1>Job Pipeline</h1>
  <a class="board-link" id="board-link" href="#" hidden>Open in Notion →</a>
</header>

<section class="panel" id="attention" aria-label="Needs attention">
  <h2 id="attention-head">Needs attention</h2>
  <div class="attn-row" id="attention-row"></div>
</section>

<div class="grid">
  <section class="panel" id="sankey-panel" aria-label="Application flow">
    <h2>Pipeline</h2>
    <div id="sankey-state" class="state">Loading pipeline…</div>
    <svg id="sankey" role="img" aria-label="Sankey diagram of application outcomes"></svg>
  </section>

  <aside class="stats">
    <section class="panel stat-card" aria-label="Heard back">
      <div class="meta"><p class="name">Heard back</p><p class="sub mono" id="response-sub">–</p></div>
      <svg class="donut" id="donut-response" width="76" height="76" viewBox="0 0 76 76"></svg>
    </section>
    <section class="panel stat-card" aria-label="Interview rate">
      <div class="meta"><p class="name">Interview rate</p><p class="sub mono" id="interview-sub">–</p></div>
      <svg class="donut" id="donut-interview" width="76" height="76" viewBox="0 0 76 76"></svg>
    </section>
    <section class="panel stat-card" aria-label="Offer rate">
      <div class="meta"><p class="name">Offer rate</p><p class="sub mono" id="offer-sub">–</p></div>
      <svg class="donut" id="donut-offer" width="76" height="76" viewBox="0 0 76 76"></svg>
    </section>
  </aside>
</div>

<div class="row2">
  <section class="panel" id="velocity" aria-label="Applications per week">
    <h2>Velocity</h2>
    <svg id="velocity-svg"></svg>
    <div class="legend">
      <span class="k"><span class="sw" style="background:var(--stone)"></span>applied</span>
      <span class="k"><span class="sw" style="background:var(--amber)"></span>got a reply</span>
    </div>
  </section>
  <section class="panel" id="sources" aria-label="Reply rate by source">
    <h2>Reply rate by source</h2>
    <div id="sources-list"></div>
  </section>
</div>

<section id="tracker" aria-label="Job tracker board" hidden>
  <div class="tracker-head">
    <h2>Job Tracker</h2>
    <input id="search" type="search" placeholder="Search by company or position…" autocomplete="off" />
    <span class="total mono" id="tracker-total"></span>
  </div>
  <div class="board" id="board"></div>
</section>

<div id="tip" role="tooltip"></div>
<footer class="mono" id="footer"></footer>

<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3-sankey@0.12.3/dist/d3-sankey.min.js"></script>
<script>
(function () {
  const NOTION_URL = __NOTION_URL__;

  const COLORS = {
    amber: "var(--amber)", plum: "var(--plum)", teal: "var(--teal)",
    rust: "var(--rust)", stone: "var(--stone)", blue: "var(--blue)",
    olive: "var(--olive)", green: "var(--green)",
  };
  const NODE_COLORS = {
    applications: "var(--stone)", pending: "var(--blue)", interviewed: "var(--olive)",
    progressing: "var(--plum)", awaiting: "var(--amber)", rejected: "var(--rust)",
    noAnswer: "var(--stone)", offers: "var(--teal)", accepted: "var(--green)", declined: "var(--rust)",
  };
  // Terminal nodes map straight to a kanban bucket; stage nodes ("ever
  // reached") also know which bucket is *currently* sitting there.
  const NODE_TO_BUCKET = {
    awaiting: "awaiting", rejected: "rejected", noAnswer: "noAnswer",
    accepted: "offerAccepted", declined: "offerDeclined",
    pending: "pending", interviewed: "interviewed", progressing: "progressing",
  };
  const STAGE_NODES = new Set(["pending", "interviewed", "progressing"]);

  const boardLink = document.getElementById("board-link");
  if (NOTION_URL) { boardLink.href = NOTION_URL; boardLink.hidden = false; }

  const stateEl = document.getElementById("sankey-state");
  const tip = document.getElementById("tip");

  fetch("/api/stats")
    .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.data.error || "Request failed");
      render(res.data);
    })
    .catch(function (err) {
      stateEl.textContent = "Couldn't load pipeline data. " + err.message;
      stateEl.classList.add("error");
    });

  function render(stats) {
    if (!stats.total) {
      stateEl.textContent = "No applications yet — add your first job in Notion and refresh.";
      return;
    }
    stateEl.remove();

    drawDonut("donut-response", stats.metrics.heardBackRate, "var(--amber)");
    drawDonut("donut-interview", stats.metrics.interviewRate, "var(--blue)");
    drawDonut("donut-offer", stats.metrics.offerRate, "var(--green)");
    document.getElementById("response-sub").textContent = stats.metrics.heardBack + " of " + stats.total + " ever replied";
    document.getElementById("interview-sub").textContent = stats.metrics.interviewed + " of " + stats.total + " applications";
    document.getElementById("offer-sub").textContent = stats.metrics.offers + " of " + stats.total + " applications";

    try { drawAttention(stats); } catch (e) { console.error("attention:", e); }
    try { drawSankey(stats); } catch (e) { console.error("sankey:", e); }
    try { drawVelocity(stats); } catch (e) { console.error("velocity:", e); }
    try { drawSources(stats); } catch (e) { console.error("sources:", e); }
    if (Array.isArray(stats.buckets) && Array.isArray(stats.jobs)) {
      try { drawBoard(stats); } catch (e) { console.error("board:", e); }
    }

    document.getElementById("footer").textContent =
      "Updated " + new Date(stats.generatedAt).toLocaleString() +
      " · cached 5 min · no-reply cutoff " + stats.staleDays + "d";
  }

  // ---- Tooltip helpers ----
  function showTip(html, evt) { tip.innerHTML = html; tip.style.display = "block"; moveTip(evt); }
  function moveTip(evt) {
    const pad = 14;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function hideTip() { tip.style.display = "none"; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function pct(part, whole) {
    if (!whole) return "0%";
    const p = (part / whole) * 100;
    return (p >= 10 ? Math.round(p) : Math.round(p * 10) / 10) + "%";
  }

  // ---- Attention queue ----
  function drawAttention(stats) {
    const items = stats.attention || [];
    if (!items.length) return;
    const panel = document.getElementById("attention");
    panel.style.display = "block";
    document.getElementById("attention-head").textContent = "Needs attention · " + items.length;
    const row = document.getElementById("attention-row");
    for (const it of items) {
      const a = document.createElement("a");
      a.className = "attn-card";
      a.href = it.url || "#"; a.target = "_blank"; a.rel = "noopener";
      const why = it.reason === "followup"
        ? '<span class="why followup">Follow up' + (it.ageDays != null ? " · " + it.ageDays + "d" : "") + "</span>"
        : '<span class="why aging">' + it.ageDays + "d, no reply</span>";
      a.innerHTML =
        '<p class="co">' + esc(it.company) + "</p>" +
        (it.position ? '<p class="role">' + esc(it.position) + "</p>" : "") + why;
      row.appendChild(a);
    }
  }

  // ---- Sankey ----
  function nodeTipHtml(d, stats) {
    const isStage = STAGE_NODES.has(d.id);
    let html = '<div class="t-head">' + esc(d.label) + " — " + d.value + "</div>" +
      '<div class="t-sub">' + pct(d.value, stats.total) + " of applications" +
      (isStage ? " reached this stage" : "") + "</div>";
    const bucket = NODE_TO_BUCKET[d.id];
    if (bucket) {
      const here = stats.jobs.filter(function (j) { return j.bucket === bucket; });
      if (isStage) {
        html += '<div class="t-sub">' + here.length + " currently here</div>";
      }
      const names = here.map(function (j) { return j.company; });
      if (names.length && names.length <= 8) {
        html += '<div class="t-list">' + names.map(esc).join("<br>") + "</div>";
      }
    }
    return html;
  }
  function linkTipHtml(d, stats) {
    return '<div class="t-head">' + esc(d.source.label) + " → " + esc(d.target.label) + " — " + d.value + "</div>" +
      '<div class="t-sub">' + pct(d.value, d.source.value) + " of " + esc(d.source.label) +
      " · " + pct(d.value, stats.total) + " of all</div>";
  }

  function drawSankey(stats) {
    const graph = stats.sankey;
    const links = graph.links.filter(function (l) { return l.value > 0; });
    const usedIds = new Set(links.flatMap(function (l) { return [l.source, l.target]; }));
    const nodes = graph.nodes.filter(function (n) { return usedIds.has(n.id); });
    if (!links.length) return;

    const svg = d3.select("#sankey");
    const width = svg.node().clientWidth || 720;
    const height = Math.max(320, svg.node().clientHeight || 340);
    svg.attr("viewBox", "0 0 " + width + " " + height);

    const sankey = d3.sankey()
      .nodeId(function (d) { return d.id; })
      .nodeWidth(6).nodePadding(28)
      .extent([[8, 24], [width - 8, height - 12]]);

    const out = sankey({
      nodes: nodes.map(function (d) { return Object.assign({}, d); }),
      links: links.map(function (d) { return Object.assign({}, d); }),
    });

    svg.append("g").selectAll("path").data(out.links).join("path")
      .attr("class", "ribbon draw")
      .attr("d", d3.sankeyLinkHorizontal())
      .attr("fill", "none")
      .attr("stroke", function (d) { return NODE_COLORS[d.target.id] || "var(--stone)"; })
      .attr("stroke-opacity", 0.55)
      .attr("stroke-width", function (d) { return Math.max(1.5, d.width); })
      .on("mouseenter", function (evt, d) { showTip(linkTipHtml(d, stats), evt); })
      .on("mousemove", moveTip)
      .on("mouseleave", hideTip);

    const node = svg.append("g").selectAll("g").data(out.nodes).join("g");

    node.append("rect")
      .attr("x", function (d) { return d.x0 - 5; })
      .attr("y", function (d) { return d.y0 - 5; })
      .attr("width", function (d) { return (d.x1 - d.x0) + 10; })
      .attr("height", function (d) { return Math.max(2, d.y1 - d.y0) + 10; })
      .attr("fill", "transparent")
      .on("mouseenter", function (evt, d) { showTip(nodeTipHtml(d, stats), evt); })
      .on("mousemove", moveTip)
      .on("mouseleave", hideTip);

    node.append("rect")
      .attr("x", function (d) { return d.x0; })
      .attr("y", function (d) { return d.y0; })
      .attr("width", function (d) { return d.x1 - d.x0; })
      .attr("height", function (d) { return Math.max(2, d.y1 - d.y0); })
      .attr("rx", 2).attr("fill", "#d6d4cf").attr("pointer-events", "none");

    const isLeft = function (d) { return d.x0 < width / 2; };
    node.append("text").attr("class", "node-value")
      .attr("x", function (d) { return isLeft(d) ? d.x0 - 10 : d.x1 + 10; })
      .attr("y", function (d) { return (d.y0 + d.y1) / 2 - 4; })
      .attr("text-anchor", function (d) { return isLeft(d) ? "end" : "start"; })
      .text(function (d) { return d.value; });
    node.append("text").attr("class", "node-label")
      .attr("x", function (d) { return isLeft(d) ? d.x0 - 10 : d.x1 + 10; })
      .attr("y", function (d) { return (d.y0 + d.y1) / 2 + 11; })
      .attr("text-anchor", function (d) { return isLeft(d) ? "end" : "start"; })
      .text(function (d) { return d.label; });
  }

  // ---- Velocity ----
  function weekLabel(iso) {
    const d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  }
  function drawVelocity(stats) {
    const weeks = stats.weekly || [];
    if (!weeks.length) return;
    const svg = document.getElementById("velocity-svg");
    const W = svg.clientWidth || 640, H = 150, padB = 18, padT = 6;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    const max = Math.max.apply(null, weeks.map(function (w) { return w.applied; })) || 1;
    const gap = 3;
    const bw = Math.max(4, (W - gap * (weeks.length - 1)) / weeks.length);
    const ns = "http://www.w3.org/2000/svg";
    const labelEvery = Math.max(1, Math.ceil(weeks.length / 6));

    weeks.forEach(function (w, i) {
      const x = i * (bw + gap);
      const h = ((H - padB - padT) * w.applied) / max;
      const hr = ((H - padB - padT) * w.replied) / max;
      const g = document.createElementNS(ns, "g");
      g.setAttribute("class", "vbar");

      const bar = document.createElementNS(ns, "rect");
      bar.setAttribute("x", x); bar.setAttribute("y", H - padB - h);
      bar.setAttribute("width", bw); bar.setAttribute("height", Math.max(w.applied ? 2 : 0, h));
      bar.setAttribute("rx", 2); bar.setAttribute("fill", "var(--stone)"); bar.setAttribute("opacity", "0.55");
      g.appendChild(bar);

      if (w.replied) {
        const rep = document.createElementNS(ns, "rect");
        rep.setAttribute("x", x); rep.setAttribute("y", H - padB - hr);
        rep.setAttribute("width", bw); rep.setAttribute("height", Math.max(2, hr));
        rep.setAttribute("rx", 2); rep.setAttribute("fill", "var(--amber)");
        g.appendChild(rep);
      }

      // invisible full-height hover target
      const hit = document.createElementNS(ns, "rect");
      hit.setAttribute("x", x); hit.setAttribute("y", 0);
      hit.setAttribute("width", bw + gap); hit.setAttribute("height", H);
      hit.setAttribute("fill", "transparent");
      hit.addEventListener("mouseenter", function (evt) {
        showTip('<div class="t-head">Week of ' + esc(weekLabel(w.week)) + "</div>" +
          '<div class="t-sub">' + w.applied + " applied · " + w.replied + " got a reply (" +
          pct(w.replied, w.applied) + ")</div>", evt);
      });
      hit.addEventListener("mousemove", moveTip);
      hit.addEventListener("mouseleave", hideTip);
      g.appendChild(hit);

      if (i % labelEvery === 0) {
        const t = document.createElementNS(ns, "text");
        t.setAttribute("x", x + bw / 2); t.setAttribute("y", H - 4);
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("fill", "var(--faint)"); t.setAttribute("font-size", "10");
        t.setAttribute("font-family", '"Spline Sans Mono", monospace');
        t.textContent = weekLabel(w.week);
        g.appendChild(t);
      }
      svg.appendChild(g);
    });
  }

  // ---- Sources ----
  function drawSources(stats) {
    const sources = stats.sources || [];
    if (!sources.length) return;
    const wrap = document.getElementById("sources-list");
    const max = Math.max.apply(null, sources.map(function (s) { return s.total; })) || 1;
    for (const s of sources) {
      const row = document.createElement("div");
      row.className = "src-row";
      const w = Math.max(3, (s.total / max) * 100);
      const wr = (s.replied / max) * 100;
      row.innerHTML =
        '<span class="dom">' + esc(s.domain) + "</span>" +
        '<span class="src-bar"><span class="fill" style="width:' + w + '%"></span>' +
        (s.replied ? '<span class="rep" style="width:' + Math.max(1.5, wr) + '%"></span>' : "") + "</span>" +
        '<span class="rate mono">' + pct(s.replied, s.total) + " · " + s.replied + "/" + s.total + "</span>";
      wrap.appendChild(row);
    }
  }

  // ---- Kanban + search ----
  function daysAgo(iso) {
    if (!iso) return "";
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "1 day ago";
    return days + " days ago";
  }

  function drawBoard(stats) {
    const board = document.getElementById("board");
    document.getElementById("tracker").hidden = false;
    document.getElementById("tracker-total").textContent = stats.total + " applications";
    const columns = [];

    for (const col of stats.buckets) {
      const colEl = document.createElement("div");
      colEl.className = "col";
      const head = document.createElement("div");
      head.className = "col-head";
      head.innerHTML =
        '<span class="dot" style="background:' + (COLORS[col.color] || "var(--stone)") + '"></span>' +
        esc(col.label) + '<span class="n mono">' + col.count + "</span>";
      colEl.appendChild(head);

      const cards = document.createElement("div");
      cards.className = "cards";
      const jobs = stats.jobs.filter(function (j) { return j.bucket === col.key; });
      const entries = [];

      if (!jobs.length) {
        const empty = document.createElement("div");
        empty.className = "empty-col";
        empty.textContent = "No jobs yet";
        cards.appendChild(empty);
      } else {
        for (const job of jobs) {
          const a = document.createElement("a");
          a.className = "card";
          a.href = job.url || "#"; a.target = "_blank"; a.rel = "noopener";
          a.innerHTML =
            '<p class="co">' + esc(job.company) + "</p>" +
            (job.position ? '<p class="role">' + esc(job.position) + "</p>" : "") +
            (job.date ? '<p class="when mono">' + esc(daysAgo(job.date)) + "</p>" : "");
          cards.appendChild(a);
          entries.push({ el: a, text: (job.company + " " + job.position).toLowerCase() });
        }
      }
      colEl.appendChild(cards);
      board.appendChild(colEl);
      columns.push({ entries: entries, badge: head.querySelector(".n"), total: col.count });
    }

    document.getElementById("search").addEventListener("input", function (e) {
      const q = e.target.value.trim().toLowerCase();
      for (const col of columns) {
        let visible = 0;
        for (const entry of col.entries) {
          const show = !q || entry.text.indexOf(q) !== -1;
          entry.el.style.display = show ? "" : "none";
          if (show) visible++;
        }
        col.badge.textContent = q ? visible + "/" + col.total : col.total;
      }
    });
  }

  function drawDonut(id, ratio, color) {
    const svg = document.getElementById(id);
    const r = 30, c = 38, circ = 2 * Math.PI * r;
    const p = Math.round(ratio * 100);
    const arc = Math.max(circ * ratio, ratio > 0 ? 2 : 0);
    svg.innerHTML =
      '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="var(--panel-edge)" stroke-width="6.5"/>' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="6.5" ' +
      'stroke-linecap="round" stroke-dasharray="' + arc + " " + circ + '" ' +
      'transform="rotate(-90 ' + c + " " + c + ')"/>' +
      '<text class="value mono" x="' + c + '" y="' + (c + 5) + '" text-anchor="middle">' + p + "%</text>";
  }
})();
</script>
</body>
</html>`;
