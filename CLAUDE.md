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
shared/pipeline.ts    the interview ladder + which rungs a job can move to (menu and route agree)
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
  utils/applications-notion.ts  the two writes into DB Applications: create (Mark applied), status change
  utils/jd-capture.ts  fetch a JD straight from the posting (ATS APIs, LinkedIn guest, page)
  utils/jd-store.ts    store a captured / pasted JD on the posting, never clobbering a better one
  utils/application-page.ts  the Notion application page: summary, Timeline, JD / Apply Pack / Analytics sub-pages
  utils/notion-blocks.ts     light Markdown → Notion blocks
scripts/capture-jds.mjs      the same capture, run on the Mac for what Cloudflare cannot reach (LinkedIn)
  api/postings/**     the postings API (list, queue, upsert, pack, artifacts)
  api/jobs/[id]/status.post.ts  mark an application rejected / moved on a round
  utils/stats-cache.ts  the /api/stats cache key, shared by the route that fills it and the one that purges it
  api/ei/**           the EI week (candidates + what is logged) and the write into the EI log
  utils/ei-week.ts    assembles EI candidates from timestamps only his actions write
  utils/activity.ts   status changes he made, one KV document per day, for the EI day
  api/stats.get.ts    edge-cached via caches.default keyed by SCHEMA_VERSION
  api/history.get.ts  | api/snapshot.get.ts | tasks/snapshot.ts (cron)
app/
  pages/index.vue     assembles the sections; useStats() → SSR data
  pages/packs/        packs index (views, gap list) + the pack page
  pages/postings/     the posting listing (saved views + table) + the brief
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

**Pack detail v2** (2026-09-11, from `Pack Detail v2.dc.html`). The page
stacked four full-width panels — status, files, lint, then the cards — so the
only thing actually read before an interview sat below all of it. It is now the
same two-column layout as the posting brief: the deck on the left, a sticky
rail of build state beside it. `.pack-grid` / `.pack-rail` share the brief's
selectors rather than copying them.

- **Running order first, then `reserve`.** Deck cards lead with their budget
  (`1 · 4:00`); cards outside the deck are labelled `reserve`, not left blank.
  A reserve card is not spare — it is the fallback when they ask something the
  deck did not plan for. A bank with no `presentation` says so instead
  ("No running order yet — every card is reached by its cues or from the
  picker"), which is the common case: of the three real packs, none has a deck.
- **Beats are a table** — beat, stance, keys as three columns to scan down
  rather than one wrapped run each. Stance is coloured on interview-helper's
  own scale (deliberate blue, measured green, gap amber, unmeasured stone).
- **Rebuild and pack-delete are dialogs**, the same departure the brief makes
  and for the same reason: `PrimeDialog` is an in-page modal, not a browser
  `confirm()`, so it blocks neither automation nor screen readers. Delete
  *names what goes* ("6 cards, 13 beats and 2 exported files"), which "Really
  delete?" cannot. Card and export deletes keep the two-step arm.
- **The rebuild hint does not repeat the design's copy.** The design said
  "Cards you edited here are overwritten"; here the write-back means the
  opposite — edits land in Notion first, so a rebuild keeps them, *unless* the
  write-back was refused. The hint says that instead.
- **The rail's posting link has two branches.** A posting whose `notionPageId`
  matches the pack's `jobId` links internally to `/postings/:id`; otherwise it
  falls back to the job's Notion `Reference Link` from `stats.jobs`. Only
  postings marked applied *through the site* carry a `notionPageId` (4 of 47),
  so the fallback is the one that usually fires.

Two bugs this page surfaced, both older than it and both fixed here:
`grid-template-columns: 1fr` in the stacked media query floors at min-content,
so one wide table pushed the page to 394px at a 360px viewport — the posting
brief had the same latent blowout, now `minmax(0, 1fr)` for both. And
`as="a"` PrimeButtons render real anchors, which the UA underlines: Postings,
Interview packs, Open in Notion and Prep sheet were all underlined until
`.p-button { text-decoration: none }`.

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

The listing (`app/pages/postings/index.vue`) was rebuilt from `Postings.dc.html`
on 2026-09-10: saved views across the top, then one table. The counts on the
views are the navigation — the number says whether a view is worth opening
before you open it, which plain tabs cannot. "Ready to send" (a pack built and
not yet sent) is the only view with something to do right now.

Note the design file is built entirely on *tracker* data — `stats.jobs`,
buckets, interview packs, "no-reply cutoff" — despite its name. It was applied
to postings at Lucas's direction, with the columns remapped to what a posting
actually has: score, state, comp, geo, source, age, apply-pack. "Mark rejected"
has no meaning for a posting never applied to, so the three bulk actions are
**Build packs / Mark applied / Dismiss**; Mark applied is the one that writes
to Notion and therefore the one behind a confirmation listing what it will
create.

Two SSR traps this page hit, both worth remembering:

- **`usePostings()` is not awaitable.** Nuxt's asyncData `then` resolves to its
  own object, so `await usePostings()` returns something without the
  composable's helpers and `postings` comes back undefined. A page that needs
  rows server-side awaits `useFetch` directly.
- **A second `useFetch` on the same key from a header component flips `pending`
  back to true mid-render.** `AddPostingButton` called `usePostings()` for a
  refresh it did not need (it navigates), and because it renders above the
  `v-if` chain the page server-rendered its loading skeleton instead of the
  rows — on every request. The button owns no data now.

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

**Application questions** (2026-09-11). The supplemental questions a form
asks — "why here", "describe a system you owned", salary, work authorization.
He pastes them off the form (one per line; numbering, bullets and the
required-field asterisk are stripped), presses Draft answers, and the Mac
answers each one through career-ops's `modes/apply.md` from his CV, the JD and
the posting's own evaluation. He reads, edits and copies them on the phone at
`/postings/:id/questions`.

Stored at `questions:<id>` in the POSTINGS KV, with the count, answered count
and status denormalised onto the meta so the list and the brief show them
without a second fetch. Question ids are a synchronous FNV hash of the text,
which is what lets a re-paste carry existing answers across: adding one
question to a form must not discard the seven answers already drafted. A web
edit flips that answer's `source` to `edited`, so a redraft can say plainly
that it will replace his own words too.

`done` is refused with nothing answered, the same lie-prevention the pack and
bank routes use. The worker drains `/api/postings/questions/queue` in the same
tick as the apply packs and hands answers back through a
`data/site-answers/<id>.json` manifest, for the same reason the pack worker
does: an agent that also does the HTTP puts the service token in a prompt and
makes "did it upload" unverifiable. That queue fetch is wrapped in a
try/catch — a worker newer than the deployed site would otherwise 404 there
and take the CV builds down with it.

Routes (`server/api/postings/`): `GET /` list · `GET /queue`
requested+building, FIFO · `GET|PUT|DELETE /:id` · `POST /:id/state` ·
`POST /:id/pack` · `POST /:id/pack/status` · `POST /:id/applied` ·
`GET|PUT|DELETE /:id/artifacts/:name` · `GET|PUT /:id/questions` ·
`POST /:id/questions/request` · `POST /:id/questions/status` ·
`PUT /:id/questions/:qid` · `GET /questions/queue`.

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

## Notifications for anything handed to an agent (2026-09-16, generalised 2026-09-17)

Anything requested on the site and built on the Mac is a wait: an apply pack
takes a **median of 41 minutes** (fastest 11, slowest 176 across the first ten),
an interview pack longer, and drafted answers ride the apply worker's 20-minute
tick. `scripts/notify-agent-work.mjs` pushes to the ntfy topic career-ops
already sends the morning standup to, so it is one feed with nothing new to
subscribe to. launchd runs it every two minutes
(`dev.codertheory.jobtracker.agent-notify`, plist in `scripts/`, log in
`~/Library/Logs/job-tracker-agent-notify.log`). Tapping the notification opens
the posting, the answers, or the pack with `?from=/` so the back arrow lands on
the dashboard.

**It started as a pack-only notifier and had exactly the gap you would expect:**
he submitted application questions for drafting and nothing told him when the
answers landed. So the watchers are a **list**, not three code paths — `ns`,
what rows to pull, what counts as finished, and the stamp that makes a re-run
count as new. Everything the site can hand to an agent belongs in `WATCHERS`
(apply packs, drafted answers, interview packs) and the next one is one entry.

Details worth keeping:

- **A new watcher seeds silently.** A namespace absent from the state file has
  no history, so every already-finished item under it would look new — adding
  "questions" would have announced every set of answers ever drafted at once.
  Unseen namespaces are recorded and skipped on their first run, the same
  courtesy the whole script gets on *its* first run.
- **State is keyed by the build, not the item** (`done@<builtAt>`), so a rebuild
  notifies again and a status that has not moved stays quiet. Answers carry no
  build time, so their stamp is `done@<answered>/<questions>`; a redraft passes
  through `requested`, which drops the key out of the watched set and makes its
  return count as new even if the count is unchanged.
- **A failed send keeps the old state** so the next run retries.
- **Titles are ASCII.** HTTP header values are not UTF-8 — a "·" in a title
  arrives on the phone as a replacement character. The body is the request body
  and keeps its punctuation.

**Why it is on the Mac and not in the Worker, which is where it belongs.** The
obvious design is a call in the route that marks work done, and that was built
first. ntfy.sh answered the Worker with `429 daily message quota reached` while
the identical publish from the Mac returned 200: ntfy identifies a "visitor"
**by IP address**, and authenticating does not change that, so a Worker shares
one anonymous quota with every other Cloudflare customer's egress and it is
permanently spent. Only a paid plan (account-based on the hosted service) or
self-hosting would fix it. If either ever happens, move the send into the
`status` routes and delete the launchd agent — the Worker knows the moment work
lands, with no polling and no dependency on the Mac being awake.

**Deliberately not watched:** posting evaluations. The eval worker grinds
through the whole backlog three at a time, so notifying on those would be a
stream of alerts for work he never asked for. The rule is *things he requested*.

## Job descriptions and the Notion application page (2026-09-15)

**Every posting gets its JD, captured straight from the posting — no model
involved.** Until now a JD only reached the site as a side effect of a full
career-ops evaluation (the eval worker's `claude -p` archived it under jds/,
and `push-postings --upgrade` pushed it). Anything not evaluated never got one:
unscored postings, anything under the eval worker's `--min-score`, and
everything queued while Claude was over its usage limit. On 2026-09-15, 72 new
postings had none.

`server/utils/jd-capture.ts` fetches it instead, one strategy per source:
Greenhouse's boards API, Lever's postings API, Ashby's job-board API,
LinkedIn's public guest endpoint, and for anything else the page itself
(JSON-LD `JobPosting` → schema.org microdata, which is how Job Bank publishes →
a long `og:description`). Output is light Markdown.

Where it runs, because the sources disagree about who may ask:

| Source | From the Worker (Cloudflare) | From the Mac |
|---|---|---|
| Greenhouse, Lever, Ashby, Workday, Job Bank | ✅ | ✅ |
| LinkedIn | ❌ 429 — it rate-limits Cloudflare's addresses | ✅ |
| Indeed | ❌ blocked | ❌ blocked → paste it on the brief |

- **The Worker captures on arrival** — in the background after a producer
  `PUT /api/postings/:id`, after "Add posting", and before the Notion page is
  set up on "Mark applied". A push retries a failed capture at most once a
  day (`jdAttemptedAt`), so the eval worker's half-hourly pushes do not
  hammer a source that said no.
- **`scripts/capture-jds.mjs` runs on the Mac** every 30 minutes
  (`dev.codertheory.jobtracker.jd-capture`, plist in `scripts/`, log in
  `~/Library/Logs/job-tracker-jd-capture.log`) for what Cloudflare cannot
  reach. It loads the same TypeScript through jiti — one parser, two places —
  paces one posting per 4s, caps a run at 20, and stops the run on a 429.
- **A capture never replaces a JD already stored**: career-ops's archived copy
  or one he pasted is at least as good as a fresh scrape, and a posting that
  has since closed would swap a real description for an error page. A paste
  (`PUT /:id/jd`, source `pasted`) does replace — that one is his call.
- **The meta is re-read before a capture writes**, because it runs a second or
  two after the push that triggered it; writing back the copy it started from
  would undo whatever he did to the posting meanwhile.
- Provenance is on the meta: `jdSource`, `jdCapturedAt`, and `jdError` (why
  the last attempt failed, shown on the brief). The brief renders the JD —
  escaped first, since it is third-party text, then only the Markdown the
  capture writes — open by default when there is no evaluation, and offers
  Fetch it / Paste it when there is none.

**The Notion application page is organised again.** Pages he built by hand
before the site (Insignia Software is the model) had a summary line, a
Timeline, a sub-page index, and 📋 Job Description / 📦 Apply Pack /
📊 Analytics sub-pages. `createApplication` only ever set properties, so every
application sent from the site had an empty page. `syncApplicationPage`
restores that layout from what the site holds — the JD, the artifacts and form
answers, the evaluation — and runs after "Mark applied", whenever a JD arrives
for an applied posting, and from "Update Notion page" on the brief.

**It only adds.** The summary and Timeline are written only onto a page with
no content (an empty paragraph counts as none); a sub-page is created only
when no child page of that name exists. So it can run again whenever something
arrives late, and never touches his writing. Interview Prep, transcripts and
round reviews stay his to add.

## EI job-search activity (2026-09-11; "Log EI time" 2026-09-15)

His record for Service Canada lives in the Notion **EI Job Search Activity
Log** (Activity · Date · Method · Outcome · Time Spent · Notes) and has already
been through one audit interview. Every path that used to write it was a Claude
session run by hand, so when the site became where he applies, the log went
stale. Two surfaces write it now, from the same candidates:

- **"Log EI time"** on the dashboard header — end of day. A dialog with what
  the site saw him do *today*, each row pre-filled with a suggested time, plus
  **Nothing suitable today** (a search with nothing worth applying to, still
  job-search activity, in his own wording) and **Add something else** for what
  the site cannot see (an interview, a call). One press of Log writes it.
- **`/ei`** — the week, rows not pre-filled, for a careful review or a missed
  day. Both render `EiEntryRow`, so they cannot drift.

Decisions that are load-bearing:

- **Only his actions produce rows, and only timestamps his actions write date
  them.** The Mac evaluates postings, builds CVs and drafts answers overnight;
  none of that is his job-search time. The sources are `appliedAt`,
  `packRequestedAt`, `dismissedAt`, the questions record (pasted and edited
  answers, and his draft request — never an answer the Mac drafted), and
  activity events from the status menu. **Never date a candidate by a
  posting's `updatedAt`**: every producer push stamps it. That was the first
  version's bug — a posting the eval worker re-pushed overnight appeared as a
  dismissal he made that day. `dismissedAt` was added for this and is kept by
  `mergePosting`; dismissals from before it existed produce no row, which is
  right, because nothing records when they happened.
- **Suggested times are shown with their arithmetic** ("3 tailored CVs and
  cover letters × 30 min") and only ever pre-fill the box. The server never
  fills `Time Spent` in: `POST /api/ei/entries` refuses a row without one. What
  reaches Notion is what was on screen when he pressed Log. (The first version
  offered no suggestions at all; he asked for the day to be assumable, and a
  visible, editable starting value is that without the site writing hours he
  never saw.)
- **Dates are America/Edmonton.** He applies in the evening, which in UTC is the
  next day.
- **Applications dedupe on the Notion page id**, not company+date: the site's
  `appliedAt` is a local date and Notion's Application Date is UTC, so matching
  on date proposed every evening application twice.
- **Matching against rows he already wrote is conservative.** His entries are
  freehand and often summarise ("Submitted four applications"), which pairs
  with nothing; the row shows what the day already holds under that method and
  he drops it. A missed match costs a tap; a silent double entry lands in an
  audited record.
- **Status changes are recorded in KV** (`activity:<day>` in POSTINGS, one JSON
  document per day, 180-day TTL) because Notion keeps no history and its
  `last_edited_time` includes the Mac's email classifier. They propose one
  "Processed employer correspondence" row per day; Undo removes the event.
  **Read by exact key, never `list()`.** The first version wrote a key per
  event and listed by prefix; KV listings trail writes by up to a minute, so
  the EI day could not see a rejection made a second earlier, and Undo — also
  listing — could not find the event to delete, leaving an undone rejection in
  the record. Caught in production testing and fixed before use.

Config: the EI database must be shared with the dashboard's integration (Notion
→ the database → ••• → Connections), or set `NOTION_EI_TOKEN`;
`NOTION_EI_DATABASE_ID` overrides the default database.

## Rejected / moved on a round (2026-09-15)

Every job card and table row has a ⋮ button opening one shared `PrimeMenu`:
**Progressed to** (the rungs it can still reach) and **Closed → Rejected**. It
writes the Notion row through `POST /api/jobs/:id/status` and the card moves
at once, with an Undo toast.

**"Progressing" is not a Notion status.** The live Status enum is Applied ·
Interviewing · On Hold · Offer · Accepted · Rejected; the `progressing` bucket
only exists for historical rows. Moving forward is three properties together:

| Action | Status | Furthest Stage | Interviewed | Next Action |
|---|---|---|---|---|
| reject | Rejected | *unchanged* | *unchanged* | Nothing |
| advance to a round | Interviewing | the chosen rung | ✓ | Prepare Interview |
| advance to Offer | Offer | Offer | ✓ | Decide |
| restore (Undo) | exactly the snapshot the previous call returned | | | |

Decisions that are load-bearing:

- **Rejecting never clears Furthest Stage or Interviewed.** A rejection at
  Round 2 still reached Round 2, and `readInterviewed` is what routes it
  through `rejectedAfterInterview` instead of counting it as a form rejection.
  Clearing them would quietly lower the interview rate.
- **Furthest Stage only goes up**, except through Undo. `reachableStages()` in
  `shared/pipeline.ts` is used by both the menu and the route, so the menu can
  never offer a move the server refuses. Two repeats are allowed: Round 3+
  again (it is a range), and the current rung on a job that is not actively
  interviewing (reopening a rejected or paused process where it stopped).
- **The route refuses any page not in DB Applications** (422). It takes a page
  id from the browser, and the answer bank and EI log are shared with the same
  integration — a stale id must not be able to set "Status: Rejected" on them.
- **Undo instead of a confirm step.** A status change is fully reversible, so a
  mis-tap on a phone costs one tap to fix rather than every change costing two.
  The toast also explains where a rejected card went — it leaves the default
  "In conversation" filter the moment it is marked.
- **Two caches sit in front of the read**, and both have to be handled:
  `/api/stats` is edge-cached 5 min *and* sent `max-age=300`, so a plain
  refetch after a change returns the old payload and the card slides back.
  So the route returns the row rebuilt from Notion's own PATCH response
  (`jobFromPage`, extracted from `aggregate()` and verified byte-identical on
  the mock set) and the card moves from that; the route purges the edge copy;
  and 1.5s later the page makes one `?fresh=1` read to bring the counts in
  line. **`?fresh=1` skips the cache in both directions** — if Notion's query
  lags its own write, caching that answer would undo the purge for five
  minutes. Rows changed in the last two minutes keep the PATCH's version even
  if that read disagrees.
- **Nuxt 4 `useFetch` data is a shallow ref** — `useJobStatus` replaces
  `stats.value` whole; editing a job in place re-renders nothing. Board cards
  are keyed by job id for the same reason cards now move: an index key hands
  one job's DOM (and its busy spinner) to whichever card slides into its slot.

Not done, deliberately: marking progress creates **no EI entry** — the site
knows when the button was pressed, not when the interview happened, and the EI
log records the latter. And career-ops's `data/applications.md` is not updated;
it was already drifting from Notion (70 of 177 applications are not in it).

## Application questions: context, choices, removal (2026-09-23)

The paste parser was one question per line, which is right for a plain list and
destroys anything else. A real form — two multiple-choice questions, one
carrying a five-point spec and nine candidate JSON answers, the other a
twenty-line Python function and thirteen complexity options, plus one free-text
question — came out as **51 "questions"**, every option and every line of code
its own row.

`parseQuestions` now returns `{question, body, options}`:

- **The required-field asterisk delimits questions.** It is the only reliable
  "a new question starts here" signal in a paste; blank lines and numbering both
  appear *inside* a question carrying a spec or a code block. With no asterisk
  anywhere, the old one-per-line rule still applies — that is what a plain list
  looks like.
- **Choices are the trailing run of single-line, blank-separated paragraphs**,
  minimum three. Context is contiguous, so it collapses into one multi-line
  paragraph and stays out of the run. Fewer than three trailing lines is prose,
  not a choice list.
- **The parse is shown before it is saved.** `POST /questions/preview` parses
  and stores nothing; the editor renders it and saving is a separate press. The
  difference between one question with thirteen options and fourteen questions
  is invisible until it is on screen, and every heuristic here is a guess.

`body` is rendered as preformatted text and `options` as pick-one buttons that
write the chosen text straight into the answer — a choice question is answered
by choosing, not by writing about choosing. The free-text box stays underneath
for forms that want reasoning too.

`DELETE /questions/:qid` removes one, armed-then-confirm. Re-pasting the whole
form was previously the only way, which meant reproducing the paste exactly or
losing the answers already drafted for the questions being kept.

`mergeQuestions` preserves stored `body`/`options` when an incoming item omits
them — the Mac posts answers back with neither, and without that a draft would
erase the question's own context.

career-ops's `answerPrompt` renders the body and the options into the prompt and
requires a choice answer to be one of the options copied verbatim. Sending only
the prompt line would ask the model to judge a function it was never shown.

## The built files live in Notion now (2026-09-22)

The Apply Pack sub-page listed the CV and cover letter as links back to
jobs.codertheory.dev — fine while the site exists and worth nothing the day it
does not. `server/utils/notion-files.ts` uploads the artifacts into Notion
itself, where, in Notion's words, an attached file "becomes a permanent part of
your workspace".

Notion's file-upload API is three calls: `POST /v1/file_uploads` for an id and
an upload URL, `POST /v1/file_uploads/:id/send` with the bytes as multipart
under the field name `file`, then a `file` block referencing the upload id via
`PATCH /v1/blocks/:page/children`. Single-part tops out at 20MB (a tailored CV
is ~110KB) and an id must be attached within an hour, which is moot when both
happen in one request.

- **These three calls use `Notion-Version: 2026-03-11`; everything else stays on
  `2022-06-28`.** The file endpoints did not exist on the old version, and
  moving the whole app forward would cross 2025-09-03, which changed how
  databases and page parents are shaped — precisely what
  `applications-notion.ts` and `aggregate.ts` read. Two versions is cheaper than
  re-testing every property reader.
- **Idempotent by filename.** The name is written into the file block's caption
  and read back from `attachedFilenames()`, so syncing twice does not leave two
  copies of a CV. Verified: a second sync attaches nothing.
- **Best-effort.** An upload that fails returns `ok: true` with an error note —
  the sub-pages that were just written must not be undone because Notion
  refused a PDF.
- Attachment happens wherever `syncApplicationPage` already runs: "Mark
  applied", and the brief's "Update Notion page".

Pack pages created before this keep their old footer line about files living on
the site; the sync only ever *adds*, and rewriting his page content to correct a
sentence is not worth breaking that rule for.

## The brief's whitespace gap on a thin posting (2026-09-18)

The posting brief is three grid siblings — `.brief-main`, `.brief-rail`, then
`.brief-jd` — in a two-column grid, with the JD deliberately a separate child so
that the stacked layout puts it *after* the rail rather than burying the actions
under two hundred lines of job description.

That put the JD in an implicit **second row**, and with `align-items: start` a
second row cannot begin until the tallest cell of the first ends — which is the
rail. On a posting with a full evaluation the left column is the taller of the
two and nobody notices. On a new posting carrying only comp, geo and stack, the
rail was 321px taller than the decision column, so the JD was pushed that far
down with nothing in the gap.

Fixed by spanning the rail across both rows (`grid-row: 1 / span 2`) and pinning
the JD to row 2, so the JD starts directly under the left column at whatever
height it ends. Measured on a real thin posting: the gap went from 335px to
14px, which is the grid gap itself. The stacked layout resets all three to
`auto` so source order still wins — decision, actions, then the JD — and phone
width stays free of horizontal overflow.

## Closed listings leave the queue (2026-09-17)

93 postings sat untouched and some were already dead — one scoring 4.2 whose own
evaluation read "This listing is closed: the LinkedIn guest page reads No longer
accepting applications", still ranked above everything he could actually apply
to. A queue that cannot tell a live job from a filled one spends the scarcest
thing in the system, which is his attention on a given morning.

career-ops's `liveness-api.mjs` had done the hard part for months and nothing
scheduled it. `check-posting-liveness.mjs --site --write` runs at 07:40 (plist
in career-ops), after `resolve-req` at 07:20 — an ATS link has a public API to
ask and a LinkedIn link mostly does not, so resolving a posting is also what
makes it checkable.

- **Only a definitive answer counts.** A 404 from an ATS API, or a board that no
  longer lists the req, sets `closedAt` + `closedReason`. A redirect, a 429, a
  timeout or an unknown host sets nothing and is not stamped, so the next run
  asks again rather than recording a non-answer as an answer. The asymmetry is
  the point: a false "closed" costs him a real job, a stale row costs him a line.
- **It never touches `state`.** Dismissing is his decision and always has been.
  A closed posting drops out of the **New** view and gets its own **Listing
  closed** view and a muted chip — the record stays, because it was evaluated
  and may be reposted.
- **On the brief it reads as a hard stop**, first in the list, and unlike the
  others it was verified rather than judged.
- `liveCheckedAt` keeps a live posting from being re-asked daily (`--recheck 3`).

## Hard stops reach the Build button (2026-09-17)

An evaluation records hard stops — "US work authorization is the only
work-eligibility statement in the posting", "this listing is closed: the
LinkedIn guest page reads No longer accepting applications", a mandatory
relocation — and the build flow read none of them. 4 of the first 20 unapplied
evaluated postings carry one, including a closed listing still sitting in the
queue at score 4.2.

The Build dialog now leads with them and the confirm button reads **Build it
anyway**. It does not block: an evaluation can be wrong and the call is his. It
stops being the *default*, which is the point — a pack costs a median of 41
minutes of machine time and a slot in his attention.

**A trap this change walked into.** The computed first read `posting.value`,
which does not exist in that file (the fetch binds to `data`). `npm run build`
reported no error, because **typescript and vue-tsc are not installed**, so
`nuxt typecheck` cannot run and the esbuild pipeline never type-checks `.vue`
scripts. Worse, the dialog body only evaluates when opened, so the page rendered
fine and would have thrown on the click. If you add one dev dependency to this
repo, make it vue-tsc.

## Screen prep — the stage that was losing (2026-09-17)

Of the ten applications that have ever reached an interview, **seven stopped at
the first screen** and none produced an offer. Everything the site builds sits
on one side or the other of that call: apply packs and drafted question answers
before it, the interview pack after. `/postings/:id/screen` is the half hour
before it.

Two kinds of prompt, and the difference is the design:

- **Standing** — the six questions every screen opens with. Their answers do not
  change per company, so they **carry forward**: the last answer he wrote is
  what the next call starts from, marked `carried` until he revisits it. Without
  that he retypes "tell me about yourself" ten times and stops using the page by
  the third. Stored once at `screen:standing` in POSTINGS KV, so carrying
  forward is one read rather than a scan of every posting.
- **Probe** — assembled from *this* posting's evaluation: its hard stops and the
  high-importance requirements it rated his match partial on, capped at five.
  Those have been sitting in `analysis` unread since the first push, and they
  are exactly what an interviewer pushes on.

**Nothing here writes his answers**, the same rule the answer bank has. The
prompts are questions and the `because` lines are quoted from the evaluation; a
generated answer fails in the room. Two details that follow from the page being
read ten minutes before a call: the length shown is **spoken** length (~150 wpm,
not reading speed), because the failure mode is a two-minute answer to a
sixty-second question; and a standing answer over 90 seconds is flagged.

The evaluation's `evidence` column is free text and often degenerate — plenty of
rows say just "stated" — so anything under 24 characters is dropped for a
sentence that at least explains why the prompt is there.

- **Asked** — questions from real calls, recorded afterwards in "After the
  call". At one interview per eighteen applications these are the rarest input
  the system gets and none of it was captured anywhere before. A recorded
  question becomes a prompt on **every** future screen prep, deduped on its
  text, newest first, capped at six carried forward — so each call prepares the
  next one. They sort above probes, because a question actually asked outranks
  one guessed from a JD. Their answers carry forward like standing ones.
  "Not asked" removes one: a mistyped question would otherwise ride along
  forever.

Routes: `GET /api/postings/:id/screen` (assembles, stores nothing) ·
`PUT /api/postings/:id/screen/:promptId` (stores, and updates the standing doc
when the prompt is standing or asked) · `POST /api/postings/:id/screen/asked` ·
`DELETE /api/postings/:id/screen/asked?prompt=<id>`. Documents:
`screen:<postingId>`, `screen:standing`, `screen:asked`.

## Apply where the job lives (2026-09-17)

`PostingMeta.employerUrl` is the employer's own req for a job discovered on an
aggregator. When it is set the brief leads with it (`.link-card--primary`) and
demotes the original to "Where it was found", because that is the link that
converts: applications sent on the employer's page reach a screen at **15.4%**
against **4.9%** through LinkedIn and Indeed, and both processes that ever
reached a third round came in that way. Reply rate says the opposite — a named
ATS answers 38% of the time and has produced no interviews at all — which is
why the funnel is measured by `stages`, not by replies.

It is a producer-supplied field (`mergePosting` `pick` semantics, not one of
the never-touched ones), resolved on the Mac by career-ops's
`resolve-employer-req.mjs` at 07:20 and pushed through the ordinary
`PUT /api/postings/:id`. The resolver matches a title exactly or reports
candidates; it never guesses, because a wrong req would send an application for
a job he never read.

## The site did not know what it had applied to (2026-09-17)

`state: applied` was only ever set by pressing **Mark applied**, and that is not
how most applications happen. The ones that convert are sent on the employer's
own careers page, where the Notion row is written there and then and the site
never hears about it. So of the 107 postings the dashboard called untouched,
**14 had already been applied to — including every posting scoring 4.0 or
better.** The "what should I apply to today" list was actively wrong, and no
measurement of which recommendations converted was possible at all.

`server/utils/reconcile.ts` links a posting to the Notion row it became, behind
`GET /api/postings/reconcile` (report) and `POST` (apply), run daily at 07:30 by
`scripts/reconcile-postings.mjs` (plist in `scripts/`) just after career-ops
pushes the morning's postings.

- **It links, it never creates.** The invariant the applied state was given in
  the first place still holds: `applied` is a consequence of a Notion row
  existing, never a claim made without one.
- **Two matches, both exact.** `url` — the row's `Job Posting` URL runs through
  the same `normalizeUrl` + sha256 the posting id comes from, so a match means
  both sides resolved the same posting. `title` — same company and an
  *identical* role title, and only where that pair names exactly one row on
  each side.
- **Everything weaker is reported, never written.** This is the one rule that
  matters. Company-plus-role similarity is what produced a confident wrong
  answer when the drift was first investigated: two Sophos roles and two
  Mozilla roles collapsed onto one tracker row each. Token overlap is worse
  than it looks — "Applied AI Engineer (P4)" scores a perfect 1.0 against
  "AI Engineer (P3)" because one title's tokens are a subset of the other's,
  and they are different jobs. Hence exact titles, with parenthetical parts
  *kept*: `(P4)` against `(P3)` is the entire difference.
- **`appliedAt` comes from Notion's Application Date, never `now`.** It is one
  of the timestamps the EI week builds candidates from, so stamping today on
  fourteen historical applications would propose fourteen entries he never
  made, in a document that has already been through an audit. Verified after
  the first run: 0 rows added to the current EI week.

First run linked 6 (2 by URL, 4 by title), taking applied from 14 to 20. The
re-run proposes nothing, which is the property that lets it sit on a schedule.

**Why so few link by URL:** the posting carries the LinkedIn URL it was found
at and Notion carries the employer's own URL he applied through — different
URLs, different ids. That gap is the same one the direct-to-employer resolver
is meant to close; until it exists, the title match is carrying the drift.

## KV quota: listings come from an index, never a scan (2026-09-16)

He started getting "close to 100% of your daily quota" alerts. The cause was
not growth, it was the listing shape — and it is the kind of thing that only
shows up once machines outnumber people.

`listPostings`/`listPacks` were `list({prefix:'meta:'})` followed by a `get`
per key. At 123 postings **one call is 124 KV operations**, and the callers are
five launchd agents, not a person: `pack-notify` every 2 min, `site-apply`
every 20, `jd-capture` every 30, `site-eval` hourly, InterviewHelper's worker
every 10 — on top of a full scan for every dashboard load, and he had been
refreshing constantly waiting for packs to build. Measured: **~118,000 reads
and ~1,800 list requests a day** against a free plan's **100,000 reads / 1,000
writes / 1,000 deletes / 1,000 list requests**.

Free-plan limits do not throttle. From the pricing page: *"If you exceed any
one of these limits, further operations of that type will fail with an error"*
until 00:00 UTC. So this was not a bill, it was a **daily outage** — the site
and both desktop workers going down mid-afternoon, every day.

`server/utils/kv-index.ts` holds one document per store (`index:postings`,
`index:packs`) with every meta in it, so a listing is **one read**. Same
traffic: ~1,800 reads/day and almost no list requests. The listing also got
30× faster (1,890ms → 65ms), which is the part he will actually notice.

- **The index is a cache, never the record.** `meta:<id>` stays authoritative
  and every item route still reads it directly. A stale or missing index costs
  a stale listing, never a lost posting.
- **It is fresher than the scan it replaced**, not staler: `putMeta` patches
  the index in the same breath as the write, while `list()` trails a write by
  up to 60s — which is why a just-requested pack could previously sit invisible
  to the queue. Verified: request → visible in `/api/postings/queue` at once.
- **Patches are best-effort.** The meta is written first and unconditionally;
  an index write that fails is swallowed. Failing his "Build pack" tap because
  a cache write failed is the worse trade.
- **Rebuilt hourly**, and on `?fresh=1`. A rebuild unions the scan with index
  entries written in the last 5 minutes, so a lagging `list()` cannot delete a
  just-created posting. `?fresh=1` is also the repair for an index that drifted
  (two concurrent writers can drop one patch — KV has no compare-and-set).
- **The cost it adds: a meta write is now two writes.** Writes are the tightest
  remaining meter at 1,000/day, so a bulk `push-postings --upgrade` over the
  whole corpus (~480 writes) is now the thing to watch, not listings.

Verified on production against real data: `/api/postings` and `/api/packs`
match `?fresh=1` byte-for-byte, and create/update/delete all reach the index
immediately.

**A KV trap this re-confirmed:** a `get` by exact key is read-your-own-writes
in the same colo but is edge-cached ~60s elsewhere, so a record read back
seconds after a `DELETE` can still answer 200. `jd-store.ts`'s "deleted while
we were fetching" guard is subject to exactly this. Don't diagnose delete bugs
inside that window — check the namespace with `wrangler kv key get --remote`.

## Tunable constants (`server/utils/config.ts`)

`DEFAULT_STALE_DAYS` 30 · `ATTENTION_MIN_DAYS` 10 · `MAX_SOURCES` 6 · `CACHE_TTL_SECONDS` 300 · `SCHEMA_VERSION` (bump on payload change).
