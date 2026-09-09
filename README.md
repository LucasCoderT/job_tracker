# Job Pipeline

A private, single-page dashboard for Lucas's Notion job-tracker database ("DB Applications"): Sankey pipeline view, response rate, interview rate, and offer rate. Notion remains the source of truth; this Worker only reads and aggregates.

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
- **Applied** rows older than `STALE_DAYS` (default 30) count as **No Answer**; fresher ones are **Awaiting Reply**. With your current data: 70 stale / 33 awaiting.
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
cd job-pipeline
npm install -g wrangler   # if you don't have it
wrangler login

# Set your custom domain in wrangler.toml first (routes → pattern),
# using a hostname in a zone on your Cloudflare account.

wrangler secret put NOTION_TOKEN         # paste the integration secret
wrangler secret put NOTION_DATABASE_ID   # paste the database ID
wrangler deploy
```

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


## v2 features

- **Needs attention** — a strip at the top surfacing rows with `Next Action = Follow up` plus Awaiting rows aged 10+ days (the "old enough to nudge, not yet ghosted" window). Follow-ups first, then oldest first. Cards link to the Notion page.
- **Velocity** — applications per week (from Application Date) with the eventually-got-a-reply portion overlaid. Hover any week for numbers.
- **Reply rate by source** — Reference Link domains bucketed (ca.indeed.com → indeed.com), top 6 by volume plus "other", each showing reply rate. This is the resume-hours-allocation chart.
- **Kanban search** — filters cards by company/position; column badges show matched/total while filtering.
- **Daily snapshots (optional)** — a cron trigger writes daily counts+metrics to KV so trends (response rate over time, pipeline composition) can be charted later; Notion alone can't reconstruct history because statuses mutate in place. Setup: `wrangler kv namespace create SNAPSHOTS`, paste the id into the commented block in `wrangler.toml`, redeploy. `/api/history` returns the accumulated series. Without the binding, everything else works and snapshots are skipped.

## Files

- `src/index.js` — the whole app: Notion query, aggregation, dashboard HTML
- `wrangler.toml` — Worker config (set your custom domain here)
