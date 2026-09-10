# CLAUDE.md

Context for working on this repo with Claude Code. Read this first.
For anything that touches how the site **looks or reads** — restyling, a new
section, a new feature's UI — read [`DESIGN.md`](DESIGN.md) too: tokens, house
rules, the review rubric, and the standing list of known design weaknesses.

## What this is

A private, single-page job-hunt dashboard — a Rabbit Resume recreation — that reads a Notion database and renders a conversion strip, trend stat cards, a weekly velocity chart, a reply-rate-by-source breakdown, and a searchable kanban board. It's a **Nuxt 4 app deployed as a single Cloudflare Worker**. Notion stays the source of truth and data entry surface; this app is read-only analytics on top.

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
                                   ├─ /api/postings/**  → job postings (POSTINGS KV; see below)
                                   └─ scheduledTask     → daily cron snapshot → KV
```

### File layout

```
nuxt.config.ts        cloudflare_module preset, scheduledTasks (cron), security headers, fonts
wrangler.toml         deploy config — custom domain, workers_dev=false, KV, cron, vars, assets
shared/types.ts       the /api/stats payload types — single source of truth, server + client
shared/bank.ts        answer-bank helpers shared by Worker + browser (lint, beat lines)
shared/postings.ts    normalizeUrl — the posting key, shared with career-ops
server/
  utils/aggregate.ts  aggregate() — the core fold (see "The data model")
  utils/packs.ts      PACKS KV store + prep-sheet renderer  |  utils/bank-notion.ts  Notion write-back
  utils/pack-route.ts shared plumbing for the /api/packs routes
  api/packs/**        the pack API (list, queue, request, bank, answers, exports, prep.html)
  utils/notion.ts     property readers, pagination, getCloudflareEnv()/getTaskEnv()
  utils/config.ts     constants + status ladder (SCHEMA_VERSION, buckets, prop names)
  utils/snapshot.ts   takeSnapshot()
  utils/mock.ts       fake Notion pages for tokenless local dev
  utils/postings.ts   POSTINGS KV store + the Machine Summary reader
  utils/posting-route.ts  shared plumbing for the /api/postings routes
  utils/applications-notion.ts  the one write into DB Applications
  api/postings/**     the postings API (list, queue, upsert, pack, artifacts)
  api/stats.get.ts    edge-cached via caches.default keyed by SCHEMA_VERSION
  api/history.get.ts  | api/snapshot.get.ts | tasks/snapshot.ts (cron)
app/
  pages/index.vue     assembles the sections; useStats() → SSR data
  pages/packs/        packs index + the pack page (cards, editor, exports)
  pages/postings/     the ranked posting list + the two-column posting brief
  components/          ConversionStrip, StatCard, VelocityChart, SourcesBreakdown,
                      TrackerBoard, PostingsPreview, AppTooltip, PackChip, PackCardEditor
  composables/         useStats (useFetch), useTooltip (shared floating tooltip), usePacks
  utils/format.ts      esc()/pct() — auto-imported
  assets/css/main.css  design tokens + all styles (ported from the old PAGE_HTML)
```

The dataviz is hand-rolled: plain CSS bars and small inline SVG (sparklines, velocity), rendered as Vue template elements so it all runs during SSR. There is no charting or layout dependency — `d3-sankey` went with the Sankey on 2026-09-10.

## Component library — PrimeVue (the shell)

PrimeVue v4 (`@primevue/nuxt-module`) is the UI shell: **all containers, controls, and states are PrimeVue.** Sections are `<PrimeCard class="sec">`; the header link is `<PrimeButton>`; loading/error/empty are `<PrimeProgressSpinner>`/`<PrimeMessage>`; the tracker uses `<PrimeSelectButton>` (Board/Table toggle), `<PrimeIconField>`+`<PrimeInputText>` (search), `<PrimeDataTable>` (Table view) and `<PrimeTag>` (status).

**What stays bespoke (by design):** the dataviz — the conversion strip and phone funnel (`ConversionStrip`), stat bars + sparklines (`StatCard`), velocity bars (`VelocityChart`), source/role/salary bars (`SourcesBreakdown`/`RolesBreakdown`/`SalaryContext`) — and the rich `AppTooltip`. Most of it is CSS, not SVG; moving any of it to Chart.js would lose SSR and add weight for marks that are a div with a width. They're themed with the same tokens so it reads as one system. Dense clickable list items (kanban job cards, posting preview cards) stay as themed `<a>`/`<NuxtLink>` anchors — PrimeCard is too heavy for them.

- Components are **prefixed `Prime`** (`<PrimeDataTable>`, `<PrimeButton>`, …) — no collision with our own components.
- Theme: a custom Aura preset in `theme/primevue-preset.ts` retuned to the app palette (surface ramp = the `--bg`/`--panel`/`--card` grays, primary = `--amber`). Tune the ramp there if a surface looks off.
- **`cssLayer: true`** (in `nuxt.config`) walls all PrimeVue CSS into `@layer primeui`, so our un-layered `main.css` always wins — that's how the container theming (`.sec.p-card` etc. in `main.css`) overrides PrimeVue defaults to keep the tight dark look. Don't remove it.
- App is dark-only: `darkModeSelector: '.dark'` + `<html class="dark">`.

## SVG hydration — always use `.attr` on geometry bindings

Vue 3.5's hydration re-patches *dynamic* props with `patchProp(el, key, null, value, void 0, …)` — namespace hardcoded to `void 0` (runtime-core `hydrateElement`), and runtime-dom derives `isSVG` **only** from that arg (`const isSVG = namespace === "svg"`). So dynamically-bound SVG geometry attributes that are also getter-only DOM props — `x`, `y`, `width`, `height`, `cx`, `cy`, `r`, `viewBox`, `transform` — get `el.x = value`, which throws (`Cannot set property x … only a getter`) and floods the console (~220 warnings).

**Fix/policy: bind those with the `.attr` modifier** (`:x.attr="…"`, `:viewBox.attr="…"`) so Vue forces `setAttribute` — the correct path for SVG. Already applied in `VelocityChart` and `StatCard`'s sparkline. Static geometry (e.g. `viewBox="0 0 76 76"`, `rx="2"`) is fine as-is (SSR renders it, never re-patched). Non-geometry attrs (`fill`, `stroke`, `d`, hyphenated `stroke-width`) are fine too (not getter-only IDL props → already go through setAttribute). Don't "fix" this with `<ClientOnly>` — that would needlessly drop chart SSR.

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

The conversion strip shows these "ever reached" totals and the step rate between them; the outcome bar underneath shows how many are *currently* sitting in each bucket. **If you change the ladder order, these rollups are what to edit.**

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
- The outcome bar partitions `total`: awaiting + in-process + rejected + no-answer === `total`. The strip's stage counts are cumulative ("ever reached") and deliberately do *not* sum to it.
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
- **Follow-up nudges** — `stats.attention` is still computed (follow-up + aging rows) but nothing renders it since the dashboard's top slot became the postings preview on 2026-09-10. The natural home is a cron that pings ntfy/Discord when a row enters the attention window, rather than a panel he has to remember to look at. (Needs the cron binding-access caveat resolved + a webhook secret.)
- **Time-to-response** — needs a `Rejection Date` property or use the page `last_edited_time` as a proxy; could calibrate `STALE_DAYS` from data instead of hardcoding 30.
- This is the **tracking dashboard**; the **CareerOps** side project is separate (research/apply-packs). Kept distinct on purpose. Interview packs are the one bridge: the site queues and shows them, career-ops on the Mac builds them.
- ~~**Desktop worker for packs**~~ — shipped, and it lives in the InterviewHelper repo: `Scripts/site_worker.py` runs from launchd, drains `GET /api/packs/queue`, and builds each pack with a headless `claude -p` in career-ops. `career-ops/site-apply-worker.mjs` is its sibling for apply packs.

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
(`?status=done`; creates the pack if there isn't one, naming it from the
bank title, so a bank built on the Mac can be linked up without queueing a
build first) · `GET /:jobId/prep.html` · `PUT|DELETE
/:jobId/answers/:answerId` (`?notion=0` to skip the write-back) ·
`GET|PUT|DELETE /:jobId/exports/:name`.

Config: `PACKS` KV binding (`wrangler kv namespace create PACKS`),
`NOTION_BANK_DATABASE_ID` var (defaults to the 🎤 database), optional
`NOTION_BANK_TOKEN` secret. Local: `npx wrangler dev .output/server/index.mjs
--assets .output/public --local` after `nuxt build` emulates the KV; the
whole route set was exercised that way before the first deploy.

## Job postings (2026-09-09)

The other end of the pipeline. Interview packs are for jobs already applied
to; **postings** are jobs career-ops found and scored but that have not been
applied to yet. They land on the site so they can be read and decided on from
a phone, "Build pack" queues a tailored CV back on the Mac, and "Mark applied"
writes the Notion row — which is how a posting becomes an application and
enters the funnel.

```
career-ops (Mac)                         jobs.codertheory.dev         phone
07:00 standup → strong-match-queue.md
push-postings.mjs ─ PUT /api/postings/:id ─► POSTINGS KV ────────────► /postings
   (thin: score, why, comp, geo, stack)                                 ranked
site-eval-worker.mjs  (every 30 min)
   any posting with no valid evaluation
   → claude -p through modes/oferta.md
   → reports/NNN-*.md, schema-validated
push-postings.mjs --upgrade ─ PUT same id ─► + jd, + analysis ───────► /postings/:id
   (Machine Summary + JD from reports/)                                 [Build pack]
site-apply-worker.mjs ◄─ GET /api/postings/queue ◄──────────────────────────┘
   claude -p → the existing CV chain → data/site-packs/<id>.json
   ─ PUT /api/postings/:id/artifacts/*.pdf ─► artifacts ─────────────► download
                             POST /:id/applied ─► Notion row ────────► the funnel
```

Decisions that are load-bearing:

- **Keyed by `sha256(normalizeUrl(url)).slice(0,16)`.** `normalizeUrl` is a
  port of career-ops's `url-key.mjs` (its canonical posting key) and lives in
  `shared/postings.ts` so the Worker, the browser and the producer all derive
  the same id from the same URL with no lookup. `normalizeUrl` returns `''`
  for anything that is not a real http(s) URL, and **`''` is "no key", never a
  value to dedupe on** — those are skipped, not stored. `PUT /:id` recomputes
  the id from the body's url and 409s on a mismatch, so a producer bug cannot
  silently split one posting into two records.
- **Two orthogonal fields.** `state` (`new` / `dismissed` / `applied`) is his
  decision; `pack` (`none` / `requested` / `building` / `done` / `failed`) is
  the Mac's progress. Folding them into one ladder the way packs do would make
  "dismissed, but the pack already built" unrepresentable. `state: applied` is
  not settable through `/state` — it is a consequence of the Notion row
  existing, and claiming it without the row would put a job in the funnel's
  story that the funnel has never heard of.
- **A push never overwrites a judgement.** `PUT /:id` is an upsert: present
  fields win, absent fields keep their value, and `state`, `pack`, artifacts
  and `notionPageId` are never touched by a producer (`mergePosting`). That is
  what lets a thin record from the morning scan be upgraded in place hours
  later by an evaluation without undoing something he did on his phone.
- **Every enum is a free string.** 174 of 194 real reports carry a
  `## Machine Summary`, and the corpus spells `legitimacy_tier` five ways
  (including a bare `1`) and `risk_level` seven ("Low-Medium", "N/A - not
  eligible"). Strict validation would reject about a third of it, so
  `cleanAnalysis` normalizes shape and key case only, never vocabulary.
- **Artifacts are binary; pack exports are not.** A CV is a ~110KB PDF, so
  postings get their own `artifact:` prefix, a raw-bytes path
  (`readRawBody(event, false)` → `ArrayBuffer` → KV) and a widened
  `KVNamespace` interface in `server/utils/notion.ts`. Capped at 6MB and 12
  files. Served `content-disposition: attachment` — unlike a pack export,
  which is `inline`, because the whole point here is getting the file onto the
  device.
- **`done` is refused until a file exists** (409), the same lie-prevention as
  a pack's bank check. A "Ready" pack with no CV behind it would be found out
  at the worst possible moment.
- **The manifest is the agent/uploader contract.** `claude -p` writes
  `data/site-packs/<id>.json` (`{reportNum, files[]}`) and
  `site-apply-worker.mjs` uploads exactly those paths, refusing anything
  resolving outside the repo. Letting the agent do the HTTP would put the
  service token in a prompt and make "did it upload" unverifiable.
- **Notion `Status` may be a `status` or a `select` property** and the two
  take different payloads. `readStatus` already tolerates both on read;
  `applications-notion.ts` reads the database schema once and branches, rather
  than guessing and showing him a 400 for a schema difference he cannot see.
  A missing `Status` column writes the row anyway — losing the click is worse.
- **`/api/stats` is edge-cached 5 minutes**, so a row created by "Mark
  applied" does not appear in the funnel immediately. The success notice says
  so; do not "fix" it by dropping the cache.
- **No `SCHEMA_VERSION` bump.** Postings never touch the `/api/stats` payload,
  and like the pack routes these are uncached.

The brief (`app/pages/postings/[id].vue`) was rebuilt from the
`Posting Brief v2` design on 2026-09-10: the decision on the left, a sticky
rail of actions on the right. Left is the call (score + bar, verdict, signal
pills coloured by `tone()`, facts, stack chips), then the evaluation — next
action, the three finding lists with counts, **the requirements matrix**, risk,
and a `<details>` for everything else the report carried. The matrix is the
substantive addition: `analysis.requirements` has been in the payload since the
first push and nothing rendered it.

Two things worth keeping. `tone()` reads a colour off the words rather than
matching an enum, for the same reason `cleanAnalysis` stores them as free
strings — the corpus spells everything several ways. And the stack chips are
tinted by cross-referencing each token against the requirements matrix, so
"Kubernetes" reads amber when the JD called it high-importance and the match is
only partial.

The rail has one primary button whose label and action move with the state
(Build pack → Building… → Mark applied → Open in Notion). The JD is its own
grid child rather than the last card in the left column: when the grid
collapses on a phone that puts it *after* the rail, instead of burying the
actions under two hundred lines of job description. That is a deliberate
departure from the design, which simply stacks main-then-rail.

Revised again the same day from an updated `Posting Brief v2`: findings and
requirements are **tables** (three equal columns forced a two-line gap to wrap
to four; a row per finding with the kind labelled once per group gives the
text the full measure), the requirements table gets a real `<thead>` and a
560px min-width with horizontal scroll on a phone, and the rail's files became
cards with the real filename and a download affordance.

**Build and Delete are dialogs.** That is a departure from the arm-then-confirm
convention, and a deliberate one: `PrimeDialog` is an in-page modal, not a
browser `confirm()`, so it does not block automation or screen readers — which
is what that rule was actually protecting. Both earn it. The build note steers
emphasis and deserves a textarea rather than a one-line field wedged into a
300px rail; and the delete dialog *names what goes with it* ("its job
description, the evaluation, and 3 built files") plus whether the Notion row
survives, which "Really delete?" cannot say. Dismiss and per-file delete keep
the two-step arm — the gradation is intentional, heavier action, louder
confirmation.

These tables are plain `<table>` rather than `PrimeDataTable`: they neither
sort nor page, and the PrimeVue rule is about controls and containers, not
static markup.

Routes (`server/api/postings/`): `GET /` list · `GET /queue`
requested+building, FIFO · `GET|PUT|DELETE /:id` · `POST /:id/state` ·
`POST /:id/pack` · `POST /:id/pack/status` · `POST /:id/applied` ·
`GET|PUT|DELETE /:id/artifacts/:name`.

Config: `POSTINGS` KV binding (`wrangler kv namespace create POSTINGS`). The
producers authenticate with a Cloudflare Access **service token** like the
pack worker does, from the Keychain item
`dev.codertheory.careerops.site` (`{"clientId","clientSecret"}`), or
`CAREER_OPS_SITE_CLIENT_ID` / `_SECRET` / `_BASE` for testing.

The producer side lives in **career-ops**, not here, and is four pieces:

| Script | What it does | Schedule |
|---|---|---|
| `push-postings.mjs` | strong-match queue → thin postings; `--upgrade` rescans `reports/` for the Machine Summary + JD | 07:15 daily |
| `site-eval-worker.mjs` | every posting without a *valid* evaluation gets one, then pushes it | every 30 min, 3 per tick |
| `site-apply-worker.mjs` | drains `/api/postings/queue`, builds the CV + cover letter, uploads them | every 20 min |
| `validate-machine-summary.mjs` | the schema gate the other three rely on | on demand / inside the eval run |

All default to `https://jobs.codertheory.dev`; point them at a local
`wrangler dev` with `CAREER_OPS_SITE_BASE`.

**Why the eval worker exists.** A full A–G evaluation only ever ran when a
human pasted a JD into a Claude session, so the site got the morning scan's
thin record and nothing else — the brief's requirements matrix, hard stops,
gaps and strengths were empty on real data no matter how well they were
built. The worker closes that: no valid evaluation → one headless `claude -p`
through `modes/oferta.md` → push.

**Why the validator exists.** `batch/batch-prompt.md` has specified the
Machine Summary schema all along and nothing checked it, so it drifted: **0
of 195 reports carried a complete one**, none had ever emitted
`requirement_importance`, and 47 carried an improvised key set
(`comp_anchor_cad`, `geo_eligible`, `stack_primary`) that appears in no spec.
Downstream — `analyze-patterns.mjs`, `salary-gap.mjs`, this site — silently
rendered nothing for keys that never arrived. So "has an evaluation" means
*passes validation*, not *a report exists*; the latter would have meant
"never evaluate anything". The evaluation prompt runs the validator on itself
and fixes what it reports before finishing.

Errors fail; vocabulary warnings do not. The site reads these as free strings
precisely because the corpus spells them several ways, and failing a real
evaluation over the word "Legitimate" would throw away the work to enforce a
label nothing depends on.

Known gap: the same job re-listed under different URLs is three postings,
because three URLs are three ids. career-ops has `detect-reposts.mjs` and a
SimHash JD fingerprint for exactly this; wiring it into the push is the
obvious next improvement.

## Dashboard v2 (2026-09-10)

Implemented from a Claude Design project (`Job Pipeline v2.dc.html`), which
was itself built against `DESIGN.md` §7. What changed and why:

- **The Sankey is gone**, replaced by `ConversionStrip`. The diagram showed
  where everything went but never answered the question the page exists for —
  where the process leaks — and it was unreadable on a phone (§7.1: a fixed
  800×400 viewBox scaled to 360px rendered its 11px labels at about 5px). The
  step rate between stages is the headline now ("→ 23% to interview"), with a
  one-line note on what was lost at that step, and a bar underneath saying
  where the applications sit right now — the one thing the Sankey did well.
  `d3-sankey`, `PipelineSankey.vue`, `buildSankey()` and `Stats.sankey` all
  went with it (**SCHEMA_VERSION 10**).
- **Strip and phone funnel both render server-side; CSS picks one** at 880px.
  The design measured the viewport in JS, which would have cost the SSR of
  whichever layout lost and risked a hydration mismatch.
- **Stat cards lost the donut** (§7.3). A donut cannot express a 2% ratio —
  `StatCard` carried an arc floor to force a visible tick, a mark apologising
  for itself. It is a bar on a shared 0–100 scale plus a 30-day sparkline off
  `/api/history` (§7.10), which finally consumes the snapshots the cron has
  been writing since July. Degrades to no sparkline under 3 snapshots.
- **A lede** states the finding in words before any chart (§7.2). Guarded: it
  falls back to the plain counts when there is no LinkedIn row, no ATS row, or
  the ratio is under 1.2×. Note `sources[].domain` holds a *channel label*
  ("LinkedIn", "Ashby") from `channelOf()`, not a bare domain — match it
  case-insensitively.
- **Weight order** (§7.2): reply-rate-by-source is first and widest, velocity
  is context beside it, and role-type + salary share one quiet footnote panel
  rather than two cards of equal weight. Salary is a range bar on a shared
  scale, so the overlap between heard-back and silent is the first thing you
  see — two big medians invited a conclusion the sample size cannot carry.
- **Skeletons** at real panel dimensions replace the centred spinner (§7.8).
- **Tracker**: status filters (All / In conversation / Live / Closed / No
  answer) defaulting to *In conversation*, because 8 columns of mostly-dead
  rows buried the two he can act on. The choice persists in `localStorage`,
  read in `onMounted` — reading it during setup would make the client's first
  render disagree with the SSR markup. Board columns now say how much is below
  the fold (§7.9). The table keeps `PrimeDataTable` (sorting, paging and
  keyboard behaviour stay library-owned) restyled to the design, with the
  status pill, the age-against-cutoff bar, and sort indicators hidden until
  hover or active.

## Tunable constants (`server/utils/config.ts`)

`DEFAULT_STALE_DAYS` 30 · `ATTENTION_MIN_DAYS` 10 · `MAX_SOURCES` 6 · `CACHE_TTL_SECONDS` 300 · `SCHEMA_VERSION` (bump on payload change).
