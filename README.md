# Job Pipeline

This is the site I run my job search from. It started as a dashboard over the Notion database where I track applications, and it grew into the front end for the whole thing: finding postings, deciding which to apply to, building the CV and cover letter, answering the application form, preparing for the first call, and keeping count of how any of it is going.

It is built for one person (me), and it shows. There is no sign-up, no multi-user anything, and a few parts only make sense next to two other repos of mine that are private. I am leaving it public because the code is real and in daily use, and because the write-up of how the pieces fit might be useful to someone building their own.

The site itself is a Nuxt 4 app deployed as a single Cloudflare Worker. Cloudflare Access sits in front of it, so there is no auth code in here at all.

## The pipeline

A job goes through these steps. The site is where I look at and decide things. The slow work (anything that needs a model, a browser or my mail) happens on my Mac, on a schedule.

```
  on the Mac (scheduled)                the site                     me, usually on a phone

  1. scan job boards, score each  ->  postings list            ->  read, dismiss, or open one
  2. full evaluation of the       ->  the brief: fit, gaps,
     better ones                      requirements, hard stops  ->  decide whether to apply
  3. tailor a CV and cover        <-  "Build pack"             <-  press the button
     letter, upload them          ->  files to download        ->  send the application
  4. draft the form's questions   <-  "Draft answers"          <-  paste the questions
                                  ->  answers to edit and copy ->  paste them into the form
  5.                                  "Mark applied"           ->  a row in Notion
  6. read my mail, date replies   ->  funnel and rates         ->  see where it leaks
  7. build interview talking      <-  "Build pack" on a job    <-  an interview gets booked
     points from my own notes     ->  cards to read and edit   ->  prep, then the call
```

Each step in a bit more detail:

1. **Find.** A morning scan on the Mac goes through job boards and saved alerts and gives every posting a quick score. Anything worth a look is pushed to the site.
2. **Evaluate.** Postings that score well get a full evaluation: how my background matches each requirement, what the gaps are, and any hard stops (a work authorization requirement, a listing that has closed). Only evaluated postings show up in the main list. The rest sit in their own view until I ask for one to be evaluated.
3. **Build an apply pack.** One button queues the Mac to tailor a CV and cover letter to that job description. It takes a while (the median was around 40 minutes), so the site sends a phone notification when it lands. The cover letter also comes as plain text, for forms that want it pasted into a box.
4. **Answer the form.** I paste the application's questions in, and the Mac drafts answers from my CV and the job description. I edit them and copy them out. One answer can be redrafted on its own, with a note, without touching the others.
5. **Apply.** I send the application myself on the employer's site. "Mark applied" then creates the row in Notion and sets up that application's page (job description, what was sent, the evaluation).
6. **Track.** The dashboard reads the Notion database and shows the funnel: how many applications got any reply, how many reached a first call, and where they stopped. A daily pass over my mail folder dates each rejection and interview invite onto its row.
7. **Interview.** For a booked interview, the site queues an interview pack: talking points pulled from answers I have already written, for a macOS app of mine that ticks them off while I talk. There is a separate page of prep for the first screening call.

## What is on the site

- **Dashboard.** The funnel with the conversion rate at each step, reply rate by where the application was sent, applications per week, and the tracker board. One panel compares outcomes by evaluation score, by channel, and by whether a tailored pack went with the application, counting only applications old enough to have an outcome.
- **Postings.** The ranked list with saved views (new, ready to send, local, not evaluated, closed), and the brief for each one.
- **Application questions.** Paste, draft, edit, copy.
- **Screen prep.** The questions every first call opens with (my answers carry forward from one company to the next), plus questions built from that posting's evaluation, plus questions I was really asked on earlier calls.
- **Interview packs.** The cards for one interview, editable from a phone. An edit is written back to my answer bank in Notion.
- **Activity log.** A page that turns what I did on the site that day into entries for my EI job-search record. It only suggests rows for things I did myself, and I set the hours.

## Things I decided on purpose

**Notion is the record.** The site reads it and writes to it in a few narrow places (a new application, a status change, an edited answer). If the site disappeared tomorrow, everything that matters would still be in Notion.

**Nothing here writes my answers for me in an interview.** The interview cards and the screen prep hold my own words. The site stores and checks them, it does not generate them. The application-form drafts are the exception, and I read and edit every one before it goes anywhere.

**When matching is uncertain, it does nothing.** Linking a posting to the application it became, or a reply email to its row, only happens on an exact match. A looser match once joined two different roles at the same company into one row. A missed link costs me a tap. A wrong one puts bad data into a record I rely on.

**Compare like with like.** Reply rates are only compared across applications that are at least 30 days old. Mixing in recent ones made a month look terrible when it was just young, and a wrong conclusion came out of that before it was fixed.

**The models stay on the Mac.** The Worker never calls one. It queues work, and a script on my Mac picks it up, does it, and uploads the result. That keeps credentials out of prompts and makes "did it upload" something I can check.

## How it is built

- **Nuxt 4 + Nitro**, `cloudflare_module` preset, deployed with `wrangler deploy`. Pages are server-rendered.
- **PrimeVue 4** for containers and controls. The charts are plain CSS bars and a little inline SVG, so they render on the server and there is no charting dependency.
- **Cloudflare KV** for postings, packs, built files and daily snapshots. Listings come from one index document per store instead of a key scan. An earlier version scanned, and five scheduled scripts polling it used up the free plan's daily read quota by mid-afternoon.
- **A Durable Object** for live updates, so a page waiting on a build refreshes when it lands. Pages also poll while something is pending, because a socket on a phone is not something to depend on.
- **Cloudflare Access** in front of the custom domain. `workers_dev` is off, since the `*.workers.dev` hostname would bypass Access.
- **Notion API** for the applications database, the answer bank and the activity log.

The scripts under `scripts/` run on my Mac from launchd: capturing job descriptions from sources that block Cloudflare's addresses, linking postings to Notion rows, and sending the phone notifications. The job scanning, evaluation and CV building live in a separate private repo, and the interview app is another.

## Running it

It will run without any of my setup, on fake data:

```bash
npm install
npm run dev
```

With no `.env`, the server serves a mock dataset, so the dashboard renders offline. To point it at a real Notion database, copy `.env.example` to `.env` and fill in an internal integration token and the database id.

Deploying your own copy needs a Cloudflare account, a domain on it, and a few things created first:

```bash
wrangler kv namespace create SNAPSHOTS
wrangler kv namespace create PACKS
wrangler kv namespace create POSTINGS     # put the ids in wrangler.toml
wrangler secret put NOTION_TOKEN
wrangler secret put NOTION_DATABASE_ID
npm run deploy                            # nuxt build, then wrangler deploy
```

Set your own hostname in `wrangler.toml`, and put Cloudflare Access in front of it before you deploy anything real. Without Access the site is open to anyone, because it has no login of its own.

`SETUP.md` has the full steps, including the Access service token the scripts need.

The Notion database it expects has `Company`, `Position`, `Status`, `Application Date`, `Job Posting`, `Next Action`, `Furthest Stage`, `Interviewed` and `Replied` properties. The dashboard half works with just the first four.

## What is missing

There is no test suite. The aggregation and the trickier merge rules are pure functions that I check with throwaway scripts, which is not the same thing. TypeScript is not type-checked in the build either, and that has let at least one bug through.

A lot of it is shaped around my own search (Edmonton, Canadian job boards, my Notion layout), so treat it as a worked example more than something to install.

## More detail

`CLAUDE.md` is the long version: every feature, why it works the way it does, and the mistakes along the way. `DESIGN.md` covers how the site is meant to look and read.

MIT licensed.
