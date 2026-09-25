# Job Pipeline

A private, single-page dashboard for Lucas's Notion job-tracker database ("DB Applications"): a conversion strip that names where the process leaks, response/interview/offer rates, weekly velocity, and reply rate by source. Notion remains the source of truth, and the app is read-mostly on top of it.

Auth is handled by Cloudflare Access (Zero Trust) in front of the Worker, so nothing here is publicly reachable and the Worker itself contains no auth code.

## Interview packs

The one thing the dashboard writes. Press **Build pack** on a job (board card or table row) and the Mac builds an InterviewHelper answer bank for that interview; the pack page (`/packs/<job>`) then shows every card, a printable prep sheet, the `bank.json` the app imports, and anything else the desktop publishes. Cards can be edited or added from a phone; each save updates the pack and writes the row back to the 🎤 Interview Answer Bank in Notion, so a later **Regenerate** keeps the edit. Details, routes and the one-time Access service-token setup are in `CLAUDE.md` › "Interview packs".

## 1. Notion database (as it exists today)

The Worker is adapted to the current schema — no changes required:

| Property         | Used by the Worker | Notes                                          |
| ---------------- | ------------------ | ---------------------------------------------- |
| Company (title)  | no                 |                                                |
| Position         | no                 |                                                |
| Status           | **yes**            | Options in use: `Applied`, `Progressing`, `Rejected` |
| Application Date | **yes**            | Drives the stale/"No Answer" cutoff            |
| Salary, Next Action, Website, Contact, Reference Link | no | ignored |

### How the funnel is derived

- **Progressing** is the interviewing stage (node label matches your term).
- **Applied** rows older than `STALE_DAYS` (default 30) count as **No Answer**; fresher ones are **Awaiting Reply**.
- **Response rate** = any human reply (Rejected + Progressing + offers) / total.
- **Interview rate** = Progressing + offers (+ post-interview rejections) / total.
- **Offer rate** = offers / total.

### Recognized future statuses (just add them in Notion, no code change)

`Interviewing`, `Offer Accepted`, `Offer Declined`, `No Answer`, `Ghosted` — matching is case-insensitive. Optionally, add an `Interviewed` **checkbox** and tick it on rejections that happened after an interview; those route through the Progressing stage and keep the interview rate honest.

## 2. Notion integration


1. Go to notion.so → Settings → Connections → Develop or manage integrations (or notion.so/my-integrations) and create an **internal integration**. Capabilities: **Read content** only. Copy the secret.
2. Open your job-tracker database as a full page → `•••` menu → **Connections** → add your integration.
3. Database ID: **`5eeb24123cb282b19daa019d619d5214`** (recovered from your export — the ID `0fbb2412-...` from earlier is a different object, likely the view/data source; don't use it). Dashes optional.

## 3. Deploy the Worker

```bash
cd job_tracker
npm install
wrangler login

# Set your custom domain in wrangler.toml first (routes → pattern),
# using a hostname in a zone on your Cloudflare account.

wrangler secret put NOTION_TOKEN         # paste the integration secret
wrangler secret put NOTION_DATABASE_ID   # paste the database ID

npm run deploy   # nuxt build (cloudflare_module preset) && wrangler deploy
```

`npm run deploy` is the one to use. `wrangler deploy` on its own ships whatever
is already in `.output/`, so without a build first it will happily redeploy the
last one.

Optionally set `NOTION_VIEW_URL` in `wrangler.toml` to your Job Application Tracker page URL to get an "Open board in Notion" link in the header. `STALE_DAYS` (default 30) controls when an unanswered application counts as "No Answer".

`workers_dev = false` is deliberate: the `*.workers.dev` hostname would bypass Access. Don't re-enable it.

## 4. Put Cloudflare Access in front (the auth)

Zero Trust is free for up to 50 users.

1. Cloudflare dashboard → **Zero Trust** → set up a team name if you haven't (free plan).
2. **Access → Applications → Add an application → Self-hosted.**
3. Application domain: the same hostname as in `wrangler.toml` (e.g. `jobs.example.dev`). Session duration: your call — 1 week is comfortable for a personal dashboard.
4. Add a policy: **Allow**, include → **Emails** → your email address. Nothing else.
5. Login methods: the default **One-time PIN** is zero-setup (emails you a code). Add Google as an identity provider later if you want one-click login.
6. Save. Visiting the dashboard now redirects to a Cloudflare login page; anyone not on the allow list gets nothing.

That's the entire auth story — no sessions, passwords, or tokens in the Worker.

### Optional hardening

Access injects a signed JWT (`Cf-Access-Jwt-Assertion`) on every request. Since the Worker is only reachable via the Access-protected custom domain (workers.dev disabled), verifying it is belt-and-suspenders — but if you ever add more routes or domains, verify the JWT in the Worker against your team's public keys (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`).

## 5. Costs and limits

- Workers free tier: 100k requests/day — a personal dashboard uses a rounding error of that.
- Stats are edge-cached for 5 minutes, so Notion sees at most ~12 queries/hour regardless of how often you refresh (Notion's limit is ~3 req/s; irrelevant here).
- Zero Trust free plan: 50 users; you need 1.


## What's on the dashboard

- **Conversion strip** — the step rate between stages, which names the bottleneck
  outright, over a bar showing where applications are sitting right now. This
  replaced the Sankey: the Sankey showed where everything went but never
  answered where the process leaks, and at 360px wide its labels rendered at
  about 5px.
- **Needs attention** — rows with `Next Action = Follow up`, plus Awaiting rows
  aged 10+ days, which is the old-enough-to-nudge-but-not-yet-ghosted window.
  Follow-ups first, then oldest first.
- **Velocity** — applications per week from Application Date, with the
  eventually-got-a-reply portion overlaid.
- **Reply rate by source** — Reference Link domains bucketed (ca.indeed.com
  becomes indeed.com), top few by volume plus "other". This is the
  where-do-the-hours-go chart.
- **Roles and salary context** — what the applications actually were, and what
  they were paying.
- **Board and table** — two views of the same rows with one search box driving
  both, and column badges showing matched/total while a filter is active.
- **Daily snapshots** — a cron writes the day's counts and metrics to KV, which
  is the only reason any trend line exists. Notion mutates statuses in place, so
  once a row flips the earlier state is gone and history cannot be
  reconstructed from it. `/api/history` returns the accumulated series.

## Architecture

**Nuxt 4 + Nitro, built with the `cloudflare_module` preset into a single ESM
Worker.** Aggregation happens server-side; the client is sent only the shapes it
needs and never a raw Notion payload.

```
Browser ─► Cloudflare Access ─► Worker (Nitro) ─► Notion API
                                   │
                                   ├─ GET /              SSR dashboard
                                   ├─ GET /api/stats     aggregated JSON, edge-cached
                                   ├─ GET /api/history   daily snapshots from KV
                                   ├─ /api/packs/**      interview packs (PACKS KV)
                                   ├─ /api/postings/**   job postings (POSTINGS KV)
                                   └─ scheduledTask      daily cron snapshot → KV
```

A single `PipelineHub` Durable Object is the realtime spine. Workers are
stateless and cannot hold a WebSocket open, and a DO is the only primitive on
the platform that can, so anything the page needs pushed to it goes through
there.

## Layout

```
nuxt.config.ts     cloudflare_module preset, scheduledTasks (cron), security headers
wrangler.toml      custom domain, workers_dev=false, KV, cron, vars, Durable Object
theme/             PrimeVue preset, so the component library matches the bespoke dataviz
shared/            types, bank helpers, pipeline ladder — imported by both server and app
server/
  utils/aggregate.ts   the core fold behind /api/stats
  utils/notion.ts      property readers, pagination, env access
  utils/mock.ts        fake Notion pages, so the whole path runs with no token
  durable/             PipelineHub
  api/                 stats, history, snapshot, packs, postings, jobs, ei
app/
  pages/               dashboard, packs, postings
  components/          ConversionStrip, StatCard, VelocityChart, SourcesBreakdown,
                       RolesBreakdown, SalaryContext, TrackerSection, PostingsPreview
  composables/         useStats, useTooltip, usePacks
scripts/               JD capture and reconcile, plus the launchd plists that run them
src/index.js           the v1/v2 Worker, kept for reference. Not part of the build.
```

`src/index.js` used to be the entire app: Worker logic plus the whole frontend
in a `PAGE_HTML` template string, no build step. v3 moved to Nuxt 4 and
TypeScript and kept the same Cloudflare and Access deploy model. It is still in
the repo because the imperative version is occasionally worth looking at, but
nothing imports it.

## Local development

```bash
npm install
npm run dev
```

With no `NOTION_TOKEN` in the environment, `server/utils/mock.ts` supplies fake
Notion pages shaped exactly like the real query results, so the whole
aggregate → `/api/stats` → dashboard path runs offline. Dates are computed
relative to now, so the Awaiting-vs-No-Answer cutoff and the weekly series
populate realistically.

Note that a `.env` with a real `NOTION_TOKEN` will be picked up and you will be
looking at live data instead.
