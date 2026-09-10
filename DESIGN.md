# DESIGN.md — the design prompt for Job Pipeline

Paste this (or `@DESIGN.md`) at the top of any session that touches how the site
**looks, reads, or feels** — restyling a panel, adding a section, designing a
brand-new feature. `CLAUDE.md` says how the app is built; this says what it
should look like when you're done, and what "better" means here.

---

## 1. The brief

You are the designer of a **single-user analytics instrument**. One reader
(Lucas), two contexts: a laptop while job-hunting, and a phone in a hallway ten
minutes before an interview. Nobody is being sold anything. There is no landing
page, no onboarding, no empty-state marketing. Every element earns its place by
answering one of exactly three questions:

1. **Is this working?** (reply rate, interview rate, velocity)
2. **Where should I spend my next hour?** (postings preview, source breakdown)
3. **What do I need in front of me right now?** (a pack's cards, a job's link)

If a proposed element answers none of those, cut it. A design change that makes
the page prettier and slower to read is a regression.

**The target aesthetic**, in one line: *a well-set financial terminal with an
editorial eye* — dark, dense, quiet, borders instead of shadows, one accent
colour doing real semantic work, numbers in tabular mono, nothing decorative.
Not a SaaS dashboard: no glassmorphism, no gradient headers, no illustrated
empty states, no card that exists to hold a single number and an icon.

---

## 2. The system as built (read before changing anything)

### Tokens — `app/assets/css/main.css :root`

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#141416` | page ground |
| `--panel` | `#1c1c20` | section surface (`.sec`) |
| `--card` | `#232329` | item surface inside a section |
| `--panel-edge` | `#2a2a31` | every border, every hairline |
| `--text` | `#e9e7e2` | primary ink (warm off-white, never `#fff`) |
| `--muted` | `#8d8c96` | labels, secondary ink |
| `--faint` | `#5b5a63` | timestamps, counts, tertiary ink |
| `--amber` | `#c2a24b` | **the accent.** Reply / attention / primary action |
| `--blue` | `#517ea6` | interview stage, pack "building" |
| `--green` | `#57b784` | still open, accepted, pack "done" |
| `--olive` `--plum` `--teal` `--rust` `--stone` | | pipeline stage categories (see below) |
| `--danger` | `#d98a7f` | errors, failed builds, armed destructive actions |

Three surfaces, three inks, one accent. That ramp is also the PrimeVue surface
ramp in `theme/primevue-preset.ts` — **change a token there too, or the two
systems drift.**

### Colour is semantic, not decorative

The palette maps to the funnel and is shared by `BUCKET_SPEC`
(`server/utils/config.ts`), the Sankey nodes, and the board columns. Same
concept ⇒ same colour, everywhere:

```
amber  awaiting reply / needs you        olive  interviewed
blue   pending (a human replied)         plum   progressing
green  still open / offer accepted       teal   offers
rust   rejected / offer declined         stone  no answer / neutral volume
```

Never pick a colour because it looks good in that spot. Pick the one the
concept already owns. If a new feature introduces a genuinely new concept,
propose the token — don't inline a hex.

### Type

- **Instrument Sans** 500/600 for everything textual; **Spline Sans Mono** for
  every number the eye compares (`.mono` also sets `tabular-nums`). This rule
  is currently followed everywhere — keep it that way.
- Section label: `13px / 600 / uppercase / 0.04em / --muted` (`.sec h2`).
- Body: 12.5–14px. Tertiary: 11–11.5px. Page title: 20px.
- Never more than three type sizes visible in one panel.

### Space, shape, elevation

- Grid gap and section rhythm: **14px**. Section padding: **18px 20px**.
- Radius: **14px** panels, **10px** cards/items, **999px** pills.
- **Elevation is a border, not a shadow.** The only `box-shadow` in the app is
  the floating tooltip, which is genuinely above the page. `.sec.p-card`
  explicitly sets `box-shadow: none`. Keep it that way.
- Hover/focus = **border-colour change over 120ms**, nothing else moving.
  `:focus-visible` gets a real 2px outline with 2px offset.

### Component roles — the split is deliberate

- **PrimeVue (`Prime*` prefix) is the shell**: containers, buttons, inputs,
  tables, tags, spinners, messages. Reach for it first for anything with
  states and keyboard behaviour — you will not out-engineer it in an evening.
- **Bespoke marks are the dataviz**: the conversion strip and phone funnel,
  stat bars and sparklines, velocity bars, source/role/salary bars, and the
  rich `AppTooltip`. No chart library — most of it is a div with a width.
- Dense clickable rows (job cards, posting preview cards, pack rows) stay
  themed anchors. `PrimeCard` is too heavy for a 40px item.

---

## 3. House rules

1. **Density is a feature.** The reader wants the whole pipeline in one screen.
   Prefer tightening to adding whitespace; prefer a row to a card.
2. **One accent per view.** Amber means "look here / a human replied". If three
   things are amber, none of them are.
3. **Ink follows importance, not decoration.** `--text` for the thing you're
   meant to read, `--muted` for its label, `--faint` for provenance. If
   everything is `--text` the panel is flat.
4. **Label the mark, not the axis.** No gridlines, no axis furniture, no
   legends you can avoid by labelling the bar. Chart junk is the enemy.
5. **The tooltip is the second layer, never the first.** Anything a decision
   depends on must be visible without hovering — a phone has no hover.
6. **Numbers are mono, always**, including inside SVG `<text>`.
7. **Honest statistics.** `n` travels with every median and rate. Don't round a
   3-of-129 into a headline percentage without the fraction beside it. Never
   collapse "heard back" (includes rejections, ~20%) and "interview rate"
   (~2%) — see CLAUDE.md; that distinction is the whole point of the page.
8. **Empty and error states say what to do next**, in one plain sentence, in
   `--muted`. No illustrations, no apology, no exclamation marks.
9. **No browser dialogs, ever.** Destructive actions arm, then confirm within
   4s (the pack page's convention). `alert()`/`confirm()` block automation and
   screen readers alike.
10. **Motion is confirmation, not decoration.** 120–140ms on colour, one
    700ms draw-in for the Sankey ribbons, all inside
    `@media (prefers-reduced-motion: no-preference)`.

---

## 4. Non-negotiables (these outrank taste)

- **Tokens only.** No new inline hex. Today's one-off hexes (`#26262c`,
  `#d98a7f`, `#c98a8a`, the `.pack-chip` border tints) are debt to pay down,
  not precedent to follow.
- **Dark only.** `<html class="dark">` is permanent; there's no light mode to
  keep in sync, so don't add `prefers-color-scheme` branches.
- **Everything renders in SSR.** No `<ClientOnly>` around charts. The only
  legitimate `<ClientOnly>` is locale/timezone-dependent text.
- **`.attr` on every dynamically-bound SVG geometry attribute**
  (`x`, `y`, `width`, `height`, `cx`, `cy`, `r`, `viewBox`, `transform`) —
  see the hydration section in CLAUDE.md. Non-negotiable, silently breaks
  hydration otherwise.
- **`cssLayer: true` stays**, and `main.css` stays un-layered. That's the whole
  override mechanism.
- **No new runtime dependency for visual polish.** No Chart.js, no animation
  library, no icon set beyond `primeicons`, no second font family. The Worker
  bundle is the budget.
- **Works at 360px.** The pack pages are read and edited on a phone; the
  dashboard is checked on one. Body must never scroll horizontally — only
  a table, a board, or a chart may, each inside its own scroll container.
- **Accessible by default:** `:focus-visible` on every interactive element,
  `aria-label` on every section and chart, 4.5:1 on body text
  (`--faint` on `--panel` is ~3.4:1 — tertiary/decorative use only, never for
  something that must be read).

---

## 5. Recipe for a new section or feature

1. **State the question it answers** (one of the three in §1) in a sentence.
   If you can't, say so and stop.
2. **Shape the payload first.** Add the type to `shared/types.ts`, aggregate
   server-side in `server/utils/aggregate.ts`, bump `SCHEMA_VERSION`. The
   client never computes analytics and never sees raw Notion.
3. **Pick the mark before the markup.** Comparison → bars. Composition of a
   whole → the Sankey or a stacked bar. One ratio → donut. Change over time →
   the velocity treatment. Ranked list with a rate → the `.src-row` pattern
   (name / bar / rate) — it's the most reusable thing in the app; reuse it
   instead of inventing a fourth bar style.
   The `.pack-row` / `.posting-row` grid (a leading figure, a name/role stack,
   clamped facts, then tags) is the app's list idiom — reuse it for any new
   list of records rather than inventing a fourth row shape.
4. **Wrap it in the standard shell:**
   ```vue
   <PrimeCard class="sec" aria-label="Plain description">
     <template #content>
       <h2>Section label</h2>
       <YourComponent :data="stats.thing" />
     </template>
   </PrimeCard>
   ```
5. **Design the four states**: loading (don't shift layout), error, empty
   (`.empty-col` voice), and *sparse* — the state where there are three rows
   and every rate is 0% or 100%. Sparse is the one that gets forgotten and the
   one the app is usually in.
6. **Check it at 360px and at 1600px**, then run §6.

---

## 6. Self-review rubric — run before you call it done

- [ ] Every colour is a token; nothing new was inlined.
- [ ] Colour meanings match `BUCKET_SPEC` / §2.
- [ ] Numbers are `.mono`; every rate carries its fraction or `n`.
- [ ] Three type sizes or fewer in the panel; label is 13px uppercase muted.
- [ ] 14px gaps, 18/20 padding, 14px or 10px radius — nothing bespoke.
- [ ] No shadow. Hover = border colour, 120ms.
- [ ] `:focus-visible` visible on every interactive element; tab order sane.
- [ ] Nothing important is hover-only.
- [ ] Loading / error / empty / sparse all designed.
- [ ] Renders in SSR; SVG geometry uses `.attr`; no hydration warnings in the
      console.
- [ ] 360px: no horizontal body scroll, no text under 11px, no crushed chart.
- [ ] Reduced-motion respected.
- [ ] Nothing else on the page moved.

---

## 7. Standing improvement list — the honest critique

These are known weak spots as of 2026-09-09, worth picking up whenever you're
in the area. They're ordered by how much they hurt.

1. **Charts collapse on a phone.** Mostly paid: the Sankey is gone, and
   `ConversionStrip` renders a real stacked funnel under 880px. `VelocityChart`
   still uses a fixed 640×150 viewBox scaled by CSS, so its 10px week labels
   render around 5px on a 360px screen — the same defect, less acute. It wants
   fewer labels and larger type at narrow widths.
2. ~~**The page is a pile of panels, not an argument.**~~ Shipped: a lede
   states the finding in words, sources leads the second row at 1.6fr, and
   role-type + salary share one quiet footnote panel.
3. ~~**The donut is the wrong mark for a 2% ratio.**~~ Shipped: a bar on a
   shared 0–100 scale, with the fraction and a 30-day sparkline.
4. **Font-size zoo.** 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 18, 20, 22px are
   all in use. Propose a 6-step scale as tokens (`--fs-xs`…`--fs-xl`) and
   migrate opportunistically.
5. **Off-token colours.** Half-paid: the two error reds are now one
   `--danger` token. Still hand-mixed: `#26262c`, `#35353d`, and the tinted
   borders `#3a3323`, `#4a3f1f`, `#23364a`, `#1f4a34`, `#4a2a25`. Those want a
   documented recipe (accent at ~30% over `--panel`, ideally
   `color-mix(in srgb, var(--amber) 30%, var(--panel))`) rather than five
   more hexes.
6. **Stage colours are close in luminance.** olive / plum / teal / rust on
   `--bg` are hard to separate in the middle of the Sankey, and untested for
   colour-vision deficiency. Ribbons should not rely on hue alone — position
   and label already help; verify with a CVD simulation before adding a ninth
   category colour.
7. **Inconsistent focus colour.** `.attn-card` outlines amber, `.card-main`
   outlines blue. Pick one (amber) and make it a token.
8. ~~**No skeletons.**~~ Shipped: panel-shaped skeletons at the real
   dimensions on the dashboard. The packs and postings pages still spin.
9. ~~**Scroll containers hide content silently.**~~ Shipped: the top slot is
   a wrapping grid, and board columns now fade the last card and say "N more
   ↓". On a phone the column scroll still fights the page scroll.
10. ~~**The history API has no UI.**~~ Shipped: each `StatCard` carries a
    30-day sparkline and a points delta. A trend panel off the same data —
    pipeline composition over time — is still unbuilt.
11. **`prep.html` has no print stylesheet** — it's the one surface likely to be
    printed or PDF'd before an interview.

---

## 8. How to respond to a design request

1. **Say what you're changing and why**, in 2–4 sentences, before writing code.
   Name the rule or the item from §7 it serves.
2. **Show the smallest diff that does it.** Don't restyle adjacent panels
   because you were in the file.
3. **If it needs a new token**, propose it explicitly with its semantic name
   and where else it should apply.
4. **Flag any rule you're deliberately breaking** and why — the rules are
   defaults with reasons, not laws, but breaking one silently is how a system
   dies.
5. **Verify, don't assert.** Run `npm run dev` (mock data works with no
   `.env`), look at it at 360px and desktop, and check the console for
   hydration warnings before saying it's done.
