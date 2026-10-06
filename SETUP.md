# Setup

How to get your own copy of this running. The README covers what the project is. This is the part with the steps.

Fair warning: it was built around my own Notion workspace and my own Mac, so some of this is "here is what I did" more than a supported install. The dashboard half is easy to stand up. The posting and pack features need more pieces, and a couple of them live in repos that are not public.

## 1. Try it with no setup

```bash
npm install
npm run dev
```

With no `.env` file the server uses a built-in fake dataset, so every dashboard panel renders and you can click around. Nothing is read from or written to Notion.

## 2. Connect a Notion database

The dashboard reads one Notion database of applications. It needs these properties:

| Property | Type | Needed for |
|---|---|---|
| `Company` | title | everything |
| `Position` | text | everything |
| `Status` | status or select | the funnel |
| `Application Date` | date | the funnel, the 30-day cutoff |
| `Job Posting` | url | reply rate by source |
| `Next Action` | select | the tracker, status changes |
| `Furthest Stage` | select | how far each interview process got |
| `Interviewed` | checkbox | counting rejections that came after an interview |
| `Replied` | date | when the first reply arrived |
| `Salary` | number | the salary panel |

The first four are enough for the funnel. A missing property is skipped, not an error.

The `Status` options the code understands are `Applied`, `Interviewing`, `On Hold`, `Offer`, `Accepted` and `Rejected`. An application that stays `Applied` for more than 30 days is counted as no answer, so you do not need a status for that.

Then:

1. Create an internal integration at notion.so/my-integrations. It needs to read, update and insert content, because marking a posting applied creates a row and the status menu edits one.
2. Open the database as a full page, then `•••` > Connections, and add the integration.
3. Copy `.env.example` to `.env` and fill in `NOTION_TOKEN` and `NOTION_DATABASE_ID`.

The database id is the 32-character hex string in the database's URL. Make sure it is the database and not one of its views, which has a different id and returns a 404.

## 3. Deploy to Cloudflare

You need a Cloudflare account and a domain on it. A custom domain is not optional, for the reason in step 4.

```bash
wrangler login

wrangler kv namespace create SNAPSHOTS
wrangler kv namespace create PACKS
wrangler kv namespace create POSTINGS
```

Each command prints an id. Put the three ids in `wrangler.toml` in place of mine, and change the `routes` pattern to your own hostname.

```bash
wrangler secret put NOTION_TOKEN
wrangler secret put NOTION_DATABASE_ID

npm run deploy
```

Use `npm run deploy`, not `wrangler deploy` by itself. The second one ships whatever is already in `.output/`, so without a build first it redeploys the previous version.

A few things in `wrangler.toml` to leave alone:

- `workers_dev = false`. See step 4.
- The order of the keys. Everything that is not inside a `[table]` has to stay above the first one. I once had `workers_dev` and `routes` end up inside `[assets]` without any error.
- The `ASSETS` binding name and the Durable Object block. The live-update socket needs the second one.

After the first deploy, open `/api/snapshot` once (signed in). It writes today's numbers to KV so the trend lines have a starting point. A daily cron takes over from there.

## 4. Put Cloudflare Access in front of it

Do this before anything real is in the database. The app has no login of its own. Access is the only thing between the site and the internet.

In the Zero Trust dashboard, add a self-hosted application for your hostname with a policy that allows only you.

Two ways to get this wrong:

- Leaving the `*.workers.dev` URL enabled. That hostname is not behind Access, so it serves the whole site to anyone. `workers_dev = false` is what closes it.
- Deploying as a Cloudflare Pages project. A `*.pages.dev` domain has the same problem.

To check, request `/api/stats` in a private window. You should get a redirect to a login page and not JSON.

At this point the dashboard, the tracker board and the status menu all work. Everything below is for the other features.

## 5. Optional: other Notion databases

These each need the integration connected to one more database, the same way as step 2.

- **Interview packs** write card edits back to an answer-bank database. Set `NOTION_BANK_DATABASE_ID` in `wrangler.toml`, or `NOTION_BANK_TOKEN` as a secret if you want a separate integration for it.
- **The activity log** writes to a job-search log database. Set `NOTION_EI_DATABASE_ID`, and `NOTION_EI_TOKEN` if it needs its own integration.

If the integration cannot see one of these, the site still saves what you did and says which database to share.

## 6. Optional: scripts that push to the site

Postings, built CVs and drafted answers all arrive from scripts running somewhere else (my Mac). They cannot sign in through a browser, so they use an Access service token.

1. Zero Trust > Access > Service Auth > Service Tokens, create a token.
2. On your Access application, add a policy with the action "Service Auth" that includes that token.
3. Give the scripts the pair. They look for it in the macOS Keychain first:

```bash
security add-generic-password -s dev.codertheory.careerops.site \
  -a access-service-token \
  -w '{"clientId":"<id>.access","clientSecret":"<secret>"}'
```

Or set `CAREER_OPS_SITE_CLIENT_ID` and `CAREER_OPS_SITE_CLIENT_SECRET` in the environment. `CAREER_OPS_SITE_BASE` points a script at a different host, which is how I test against a local build.

The scripts in this repo, all under `scripts/`:

| Script | What it does | How often I run it |
|---|---|---|
| `capture-jds.mjs` | Fetches job descriptions from sources that block Cloudflare's addresses (LinkedIn, mostly) | every 30 minutes |
| `notify-agent-work.mjs` | Sends a phone notification through ntfy when something I asked for is ready | every 2 minutes |
| `reconcile-postings.mjs` | Links a posting to the Notion row it became, on an exact match only | daily |
| `backfill-postings-from-notion.mjs` | Creates posting records for applications sent outside the site | by hand |

The `.plist` files beside them are the launchd jobs I use. They have my paths in them, so edit before loading. The notifier reads its topic from `NTFY_TOPIC`.

What is not here: the scripts that scan job boards, evaluate postings and build the CVs. Those are in a private repo. The site's side of that contract is documented in `CLAUDE.md` under "Job postings" (the routes, the fields, what a producer may and may not overwrite), which is enough to write your own.

## Running the built Worker locally

`npm run dev` is the quick loop. To run the real build with KV and the Durable Object emulated:

```bash
npm run build
npx wrangler dev .output/server/index.mjs --assets .output/public --local
```

Put the Notion values in `.dev.vars` for this one, since `.env` is only read by the Nuxt dev server. There is no Access in front of a local server, so do not expose it.

## When something looks wrong

- **Blank cards or an empty board after a deploy.** `/api/stats` is cached at the edge for 5 minutes, keyed by `SCHEMA_VERSION` in `server/utils/config.ts`. If you change the shape of that payload, bump the version.
- **A change does not show up for a few seconds after deploying.** A new version takes a little while to reach every Cloudflare location. I once sent a request 24 seconds after a deploy and the old version answered it.
- **A Notion 404.** The integration is not connected to that database, or the id is a view's.
- **KV errors in the afternoon.** The free plan's daily limits do not slow you down, they fail. Listings here read one index document for that reason, so if you add a script that polls, have it use the list endpoints and not its own key scan.
