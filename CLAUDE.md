# CLAUDE.md

Context for working on this repo with Claude Code. Read this first.
For anything that touches how the site **looks or reads** — restyling, a new
section, a new feature's UI — read [`DESIGN.md`](DESIGN.md) too: tokens, house
rules, the review rubric, and the standing list of known design weaknesses.

## What this is

A private, single-page job-hunt dashboard — a Rabbit Resume recreation — that reads a Notion database and renders a Sankey pipeline, funnel stat cards, a weekly velocity chart, a reply-rate-by-source breakdown, and a searchable kanban board. It's a **Nuxt 4 app deployed as a single Cloudflare Worker**. Notion stays the source of truth and data entry surface; this app is read-only analytics on top.

Auth is **Cloudflare Access** (Zero Trust) in front of the Worker's custom domain — there is deliberately **no auth code** in the app. Because access is gated at the edge, the API is free to return company names and Notion links.

> **History:** v1–v2 were a single hand-written Worker in `src/index.js` (Worker logic + a `PAGE_HTML` template string, no build step). v3 migrated to Nuxt 4 + TypeScript for maintainability while keeping the exact Cloudflare/Access deploy model. `src/index.js` is kept as a reference for the old imperative frontend; it is **not** part of the build.

## Architecture

Nuxt 4 + Nitro, built with the **`cloudflare_module` preset** → an ESM Worker in `.output/`, deployed with `wrangler deploy`. The server aggregates **server-side** and returns only the shapes the frontend needs; the client never sees raw Notion payloads.

```
Browser ─► Cloudflare Access ─► Worker (Nitro) ─► Notion API
                                   │
   app/  (Vue/SSR dashboard) ◄─────┤  GET /            → SSR dashboard (useFetch /api/stats)
                                   ├─ GET /api/stats    → aggregated JSON (edge-cached 5 min)
                                   ├─ GET /api/history  → daily snapshots from KV
                                   ├─ GET /api/snapshot → manual snapshot trigger (reliable seed)
                                   ├─ /api/packs/**     → interview packs (PACKS KV; see below)
                                   └─ scheduledTask     → daily cron snapshot → KV
```

### File layout

```
nuxt.config.ts        cloudflare_module preset, scheduledTasks (cron), security headers, fonts
wrangler.toml         deploy config — custom domain, workers_dev=false, KV, cron, vars, assets
shared/types.ts       the /api/stats payload types — single source of truth, server + client
shared/bank.ts        answer-bank helpers shared by Worker + browser (lint, beat lines)
server/
  utils/aggregate.ts  aggregate() — the core fold (see "The data model")
  utils/packs.ts      PACKS KV store + prep-sheet renderer  |  utils/bank-notion.ts  Notion write-back
  utils/pack-route.ts shared plumbing for the /api/packs routes
  api/packs/**        the pack API (list, queue, request, bank, answers, exports, prep.html)
  utils/notion.ts     property readers, pagination, getCloudflareEnv()/getTaskEnv()
  utils/config.ts     constants + status ladder (SCHEMA_VERSION, buckets, prop names)
  utils/snapshot.ts   takeSnapshot()
  utils/mock.ts       fake Notion pages for tokenless local dev
  api/stats.get.ts    edge-cached via caches.default keyed by SCHEMA_VERSION
  api/history.get.ts  | api/snapshot.get.ts | tasks/snapshot.ts (cron)
app/
  pages/index.vue     assembles the sections; useStats() → SSR data
  pages/packs/        packs index + the pack page (cards, editor, exports)
  components/          PipelineSankey, StatCard, VelocityChart, SourcesBreakdown,
                      TrackerBoard, AttentionQueue, AppTooltip, PackChip, PackCardEditor
  composables/         useStats (useFetch), useTooltip (shared floating tooltip), usePacks
  utils/format.ts      esc()/pct() — auto-imported
  assets/css/main.css  design tokens + all styles (ported from the old PAGE_HTML)
```

The frontend uses **d3-sankey as an npm dep** (layout math only) and renders SVG marks as Vue template elements — no d3 DOM selections, and it runs during SSR.

## Component library — PrimeVue (the shell)

PrimeVue v4 (`@primevue/nuxt-module`) is the UI shell: **all containers, controls, and states are PrimeVue.** Sections are `<PrimeCard class="sec">`; the header link is `<PrimeButton>`; loading/error/empty are `<PrimeProgressSpinner>`/`<PrimeMessage>`; the tracker uses `<PrimeSelectButton>` (Board/Table toggle), `<PrimeIconField>`+`<PrimeInputText>` (search), `<PrimeDataTable>` (Table view) and `<PrimeTag>` (status).

**What stays bespoke SVG (by design):** the dataviz — Sankey (`PipelineSankey`), donut stat cards (`StatCard`), velocity bars (`VelocityChart`), source/role bars (`SourcesBreakdown`/`RolesBreakdown`) — and the rich `AppTooltip`. No library (incl. Chart.js) ships a Sankey, and moving the others to Chart.js would lose SSR and add weight. They're themed with the same tokens so it reads as one system. Dense clickable list items (kanban job cards, attention cards) stay as themed `<a>` anchors — PrimeCard is too heavy for them.

- Components are **prefixed `Prime`** (`<PrimeDataTable>`, `<PrimeButton>`, …) — no collision with our own components.
- Theme: a custom Aura preset in `theme/primevue-preset.ts` retuned to the app palette (surface ramp = the `--bg`/`--panel`/`--card` grays, primary = `--amber`). Tune the ramp there if a surface looks off.
- **`cssLayer: true`** (in `nuxt.config`) walls all PrimeVue CSS into `@layer primeui`, so our un-layered `main.css` always wins — that's how the container theming (`.sec.p-card` etc. in `main.css`) overrides PrimeVue defaults to keep the tight dark look. Don't remove it.
- App is dark-only: `darkModeSelector: '.dark'` + `<html class="dark">`.

## SVG hydration — always use `.attr` on geometry bindings

Vue 3.5's hydration re-patches *dynamic* props with `patchProp(el, key, null, value, void 0, …)` — namespace hardcoded to `void 0` (runtime-core `hydrateElement`), and runtime-dom derives `isSVG` **only** from that arg (`const isSVG = namespace === "svg"`). So dynamically-bound SVG geometry attributes that are also getter-only DOM props — `x`, `y`, `width`, `height`, `cx`, `cy`, `r`, `viewBox`, `transform` — get `el.x = value`, which throws (`Cannot set property x … only a getter`) and floods the console (~220 warnings).

**Fix/policy: bind those with the `.attr` modifier** (`:x.attr="…"`, `:viewBox.attr="…"`) so Vue forces `setAttribute` — the correct path for SVG. Already applied in `PipelineSankey`, `VelocityChart`, `StatCard`. Static geometry (e.g. `viewBox="0 0 76 76"`, `rx="2"`) is fine as-is (SSR renders it, never re-patched). Non-geometry attrs (`fill`, `stroke`, `d`, hyphenated `stroke-width`) are fine too (not getter-only IDL props → already go through setAttribute). Don't "fix" this with `<ClientOnly>` — that would needlessly drop chart SSR.

Also: any locale/timezone-dependent text (e.g. the footer's `toLocaleString()` timestamp) must be in `<ClientOnly>`, or SSR and client disagree and you get a hydration text mismatch.

## The data model — this is the important part

Notion database "DB Applications". Relevant properties: `Company` (title), `Position` (rich_text), `Status` (select), `Application Date` (date), `Next Action` (select), `Reference Link` (url). Optional, not present yet: an `Interviewed` checkbox.

### Status ladder

`Status` options map to funnel buckets via `STATUS_BUCKETS` (case-insensitive). The intended ladder, earliest to latest:

```
Applied → Pending → Interviewed → Progressing → Offers (Accepted / Declined)
```

Plus terminal/off-ladder buckets: `Rejected`, `No Answer`.

Two buckets are **derived, not stored**:
- **Awaiting Reply** = `Applied` rows newer than `STALE_DAYS` (default 30). Still waiting.
- **No Answer** = `Applied` rows older than `STALE_DAYS`. Treated as ghosted. (There's no "No Answer" status in Notion; the date does the work.)

`Rejected` rows can optionally route *through* the Interviewed stage if the (future) `Interviewed` checkbox is ticked — `rejectedAfterInterview`. This keeps the interview rate honest (a post-onsite rejection shouldn't count the same as a form rejection).

### Rollups are cumulative ("ever reached")

A row's current status implies it passed through earlier stages. So in `aggregate()`:
- `everProgressing = progressing + offers`
- `everInterviewed = interviewed + everProgressing + rejectedAfterInterview`
- `everPending = pending + everInterviewed`

The Sankey stage nodes show these "ever reached" totals; tooltips separately show how many are *currently* sitting in that bucket. **If you change the ladder order, these rollups are what to edit.**

### The two metric definitions (don't collapse them)

- **Heard back** (`HEARD_BACK_BUCKETS`) = any human reply, **including rejections**. Powers the first stat card, the sources chart, and the velocity "replied" overlay. Answers "is anything reacting to my applications at all." ~20% on current data.
- **Interview rate** = reached the Interviewed stage. Excludes bare rejections. ~2% on current data.

These were briefly the same metric and got deduplicated — see git history / the README. Keep them distinct: heard-back moves first when targeting changes; interview rate is the conversion bottleneck. **Do not** switch the sources chart to the strict definition — with rejections excluded it goes to ~0 everywhere and stops being useful for deciding where to apply.

### A real finding baked into the data

Reply rate is dramatically higher through companies' own ATS (Ashby, Workday, Greenhouse) than through LinkedIn/Indeed. The sources chart exists to surface exactly this. Roughly: LinkedIn ~9%, Indeed ~21%, Ashby ~45% (small n on the ATS side, but consistent direction).

## Conventions and gotchas (learned the hard way)

- **`SCHEMA_VERSION`** (`server/utils/config.ts`) is baked into the `/api/stats` edge-cache key in `server/api/stats.get.ts`. **Bump it whenever the `/api/stats` payload shape changes**, or a deploy can serve an old-shaped cached response to new frontend code (the failure mode: blank stat cards / empty board for up to 5 minutes). When you add a field to `Stats`, add it to `shared/types.ts` too — that's the shared contract.
- **`workers_dev = false` is load-bearing.** The `*.workers.dev` hostname bypasses Cloudflare Access entirely. Never re-enable it. The custom domain is the only door. **Also: never use the Cloudflare Pages preset** — a Pages project's `*.pages.dev` domain has the same Access-bypass problem.
- **wrangler.toml key ordering.** All bare top-level keys (`name`, `main`, `compatibility_*`, `workers_dev`, `routes`) must sit **above** the first `[table]` header. In TOML anything after a `[table]` belongs to that table — this once silently swallowed `workers_dev`/`routes` into `[assets]`, which would have re-enabled the workers.dev door. `wrangler deploy --dry-run` warns about it ("Unexpected fields in assets field").
- **Access + iframe don't mix**, which is why this is a standalone page and not a Notion embed (third-party cookies get blocked). The anti-embed headers (`x-frame-options: DENY`, `referrer-policy: no-referrer`) are set via `nitro.routeRules` in `nuxt.config.ts`.
- **Section resilience** is now per-component: `app/pages/index.vue` gates on `pending`/`error`/empty, and each section is its own component fed by the typed `stats`. (The old imperative `render()` wrapped each draw in try/catch for the same reason.) The old `${}`-in-`PAGE_HTML` escaping footgun is **gone** — real `.vue` files, no template-literal gymnastics.
- **Cron binding access is the one soft spot.** Nitro scheduled tasks run *outside* the request lifecycle, where Cloudflare bindings aren't guaranteed reachable. `server/tasks/snapshot.ts` uses best-effort `getTaskEnv()` and no-ops loudly if it can't reach KV. **Not verified on a real deploy** — verify on first deploy; the reliable seed path is always the Access-gated `GET /api/snapshot` (real request context). Fall back to the `cloudflare-kv-http` driver if the task can't see the binding.
- **Env var rename:** the header "Open in Notion →" link reads `NUXT_PUBLIC_NOTION_VIEW_URL` (was `NOTION_VIEW_URL`) → maps onto `runtimeConfig.public.notionViewUrl`. Notion secrets are unchanged (`NOTION_TOKEN`, `NOTION_DATABASE_ID`).
- **Database ID is `5eeb24123cb282b19daa019d619d5214`.** An earlier `0fbb2412-...` value was a different object (view/data source) and 404s — don't use it.

## Testing

No test framework is wired up. `aggregate()` is a pure function (`server/utils/aggregate.ts`) — import it in an ad-hoc Node/vitest script, build fake Notion pages, call `aggregate(pages, { staleDays, now })`, and assert the invariants. `server/utils/mock.ts` already contains a representative fake dataset you can reuse.

Key invariants to preserve if you refactor `aggregate()` (verified against the live 129-row DB after the Nuxt migration — results were byte-identical to the old Worker):
- `total` = sum of all non-unknown buckets.
- Sankey: sum of links out of `applications` === `total`.
- Intermediate stage nodes are intentionally *not* flow-conserved — inflow minus outflow = the count currently sitting in that stage (shown in tooltips). `applications` and `offers` do conserve.
- `sources` totals sum to `total`; `weekly.applied` sums to the count of dated rows (≤ total).

Quick smoke test without Notion creds: `npm run dev` with no `.env` → the server serves `mock.ts` data so the whole dashboard renders offline.

## Deploy

```bash
wrangler secret put NOTION_TOKEN         # Notion internal integration secret (ntn_…)
wrangler secret put NOTION_DATABASE_ID   # 5eeb24123cb282b19daa019d619d5214
npm run deploy                           # = nuxt build && wrangler deploy
```

`npm run deploy` builds to `.output/` (which `wrangler.toml`'s `main`/`[assets]` point at) and deploys the Worker. The custom domain + Access sit in front unchanged. KV snapshots for trend history: the `SNAPSHOTS` binding and `[triggers] crons` are already in `wrangler.toml`; hit `/api/snapshot` once to seed today.

**Local dev:** `npm run dev` (`nuxt dev`). Put `NOTION_TOKEN` + `NOTION_DATABASE_ID` in a `.env` file (copy `.env.example`); Nuxt auto-loads it. Bindings (KV `SNAPSHOTS`, vars) are emulated by `nitro-cloudflare-dev` from `wrangler.toml`. No Access in front locally — don't expose it. (`.dev.vars` still works for `wrangler dev` against the built Worker.)

## Likely next steps (backlog)

- **Trend charts** off `/api/history` once snapshots accumulate (response-rate-over-time, pipeline composition). The snapshot plumbing exists; the UI doesn't yet. (Verify the cron actually writes on a real deploy first — see the binding caveat above.)
- ~~**Reply rate by role type**~~ — shipped (`RolesBreakdown.vue`, `classifyRole()` in `notion.ts`). Finding: reply rate is basically **flat across role types** (~20–23% for Full-Stack / Backend / AI-ML / Other), so *source* is the real lever, not role type.
- ~~**Salary context**~~ — shipped (`SalaryContext.vue`, `salary` in the payload). Finding: heard-back roles skew ~$10k higher median ($120k vs $110k), small n.
- **Follow-up nudges** — extend the cron to ping ntfy/Discord when a row enters the attention window. (Needs the cron binding-access caveat resolved + a webhook secret.)
- **Time-to-response** — needs a `Rejection Date` property or use the page `last_edited_time` as a proxy; could calibrate `STALE_DAYS` from data instead of hardcoding 30.
- This is the **tracking dashboard**; the **CareerOps** side project is separate (research/apply-packs). Kept distinct on purpose. Interview packs are the one bridge: the site queues and shows them, career-ops on the Mac builds them.
- **Desktop worker for packs** — a launchd job on the Mac that drains `GET /api/packs/queue` through career-ops (`agent-inbox` → `claude -p` with the interview-bank skill → the interview-helper MCP `site_push`) and marks packs done. Until it exists, career-ops does the same by hand from a Claude session with `site_queue` / `site_push`.

## Interview packs (2026-09-09)

The one write surface in the app, and the reason it is no longer purely
read-only analytics. An **interview pack** is everything
[InterviewHelper](https://github.com/lucaslukowski/interview-helper) (the
macOS app that ticks off his own talking points mid-interview) needs for one
interview: the answer bank it imports, plus whatever the desktop publishes
alongside (prep notes, question banks). Packs let him **queue a build, read
the result, and edit the cards from a phone**; the Mac does the building.

```
phone/laptop ─► "Build pack" on a job row ─► PACKS KV  meta:<jobId> status=requested
                                                  ▲                │
Mac (career-ops + interview-bank skill) ◄── GET /api/packs/queue ──┘
   builds the bank from Notion ─► PUT /api/packs/<id>/bank?status=done
   publishes notes            ─► PUT /api/packs/<id>/exports/<name>
phone/laptop ◄── /packs/<id>: cards, prep.html, bank.json, exports
   edits a card ─► PUT /api/packs/<id>/answers/<answerId>
                    ├─ KV bank (what the app imports, at once)
                    └─ Notion 🎤 Interview Answer Bank row (the record)
InterviewHelper ◄── Settings › Bank › Import from site → GET /api/packs/<id>/bank.json
```

Decisions that are load-bearing:

- **Keyed by the application's Notion page id** (`jobs[].id`, added in
  SCHEMA_VERSION 9). That id is also the `Companies` relation target in the
  answer bank, so a card created on the web is tagged to the right company
  with no lookup.
- **Notion stays the record of truth for his writing.** A web edit lands in
  KV first (so the site and the app see it immediately) and is then written
  to the answer-bank row: found by `Answer ID`, then by exact `Question`;
  created and company-tagged if absent. The desktop rebuilds from Notion, so
  **regenerate keeps web edits**. Removing a card unticks `Active` on a
  company-tagged row and leaves a universal row alone (the UI says which).
  Bank-level title / never-say / deck are site-only (not Notion columns).
  The write-back is reported per save, never fatal: if the dashboard's
  integration cannot see the answer-bank database (404) the card still
  saves on the site and the message says to share the database with it
  (Notion → the 🎤 database → ••• → Connections) or set `NOTION_BANK_TOKEN`.
- **The site stores and edits his words; nothing here generates them.**
  The editor is a place to type. Lint (`shared/bank.ts`, a port of the
  app's own rules) runs on every save and on the page.
- **Same edge auth, no auth code.** Every `/api/packs` route is behind
  Access like the rest. The app and the desktop worker present a
  **Cloudflare Access service token** (`CF-Access-Client-Id` /
  `CF-Access-Client-Secret` headers); the Worker never sees a difference.
  Setup (once, Zero Trust dashboard): Access › Service Auth › Service
  Tokens › create "interviewhelper"; then on the jobs.codertheory.dev
  application add a policy with action **Service Auth** whose include rule
  is that token. The app keeps the pair in the Keychain.
- **KV, not D1/R2.** Packs are dozens, not thousands; a meta + a bank + a
  few text exports per job, listed with one prefix scan. Exports are text
  only and capped at 2MB; a phone is the reader. `done` is refused until a
  bank has been uploaded — an empty "Ready" would be a lie the phone
  believes. A pack stuck in `building` (a worker that died) shows in the
  queue again.
- **Deletes are two-step on the page** (arm, then confirm within 4s) —
  the same convention as the app's Quit and Discard, and no browser
  dialogs, which block automation and screen readers alike.

Routes (`server/api/packs/`): `GET /` list · `GET /queue` requested+building
· `GET|DELETE /:jobId` · `POST /:jobId/request` · `POST /:jobId/status`
(building|done|failed) · `GET /:jobId/bank.json` · `PUT /:jobId/bank`
(`?status=done`) · `GET /:jobId/prep.html` · `PUT|DELETE
/:jobId/answers/:answerId` (`?notion=0` to skip the write-back) ·
`GET|PUT|DELETE /:jobId/exports/:name`.

Config: `PACKS` KV binding (`wrangler kv namespace create PACKS`),
`NOTION_BANK_DATABASE_ID` var (defaults to the 🎤 database), optional
`NOTION_BANK_TOKEN` secret. Local: `npx wrangler dev .output/server/index.mjs
--assets .output/public --local` after `nuxt build` emulates the KV; the
whole route set was exercised that way before the first deploy.

## Tunable constants (`server/utils/config.ts`)

`DEFAULT_STALE_DAYS` 30 · `ATTENTION_MIN_DAYS` 10 · `MAX_SOURCES` 6 · `CACHE_TTL_SECONDS` 300 · `SCHEMA_VERSION` (bump on payload change).
