# Push to GitHub

From this folder:

```bash
git init
git add -A
git commit -m "Job Pipeline: Notion-backed job-hunt dashboard on a Cloudflare Worker"

# create the repo (pick one)
gh repo create job-pipeline --private --source=. --push        # GitHub CLI
# — or — make an empty repo on github.com, then:
git remote add origin git@github.com:lucascodert/job-pipeline.git
git branch -M main
git push -u origin main
```

## Before you commit — one edit

`wrangler.toml` ships with a placeholder domain (`jobs.example.dev`). Either:
- set it to your real hostname and commit that (it's not a secret), or
- keep the placeholder in the repo and override locally.

**No secrets are in the repo.** `NOTION_TOKEN` / `NOTION_DATABASE_ID` live in `wrangler secret` (production) or `.dev.vars` (local, gitignored). If you ever committed a real token by accident, rotate it in Notion — git history keeps it otherwise.

## Continue with Claude Code

`CLAUDE.md` has the full architecture, the status-ladder logic, the gotchas, and a next-steps backlog. Claude Code reads it automatically. From the repo:

```bash
claude
```

Then e.g. "add the trend charts off /api/history from the backlog in CLAUDE.md".
