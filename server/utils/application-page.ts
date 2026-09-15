/**
 * The Notion application page, organised the way his pages were before the
 * site existed — and the way the ones "Mark applied" created were not.
 *
 * Until 2026-09-15 `createApplication` set the row's properties and nothing
 * else, so every application sent from the site had an empty page: no JD, no
 * record of what was sent, no evaluation. His hand-built pages (Insignia
 * Software is the model) carry a summary line, a Timeline, an index of
 * sub-pages, and then the sub-pages themselves:
 *
 *   📋 Job Description   the posting as it read when he applied
 *   📦 Apply Pack        what was sent: the CV and cover letter, the form's answers
 *   📊 Analytics         career-ops's evaluation: fit, strengths, gaps, comp
 *
 * (Interview Prep, round transcripts and reviews come later in a process and
 * stay his to add.)
 *
 * **It only ever adds, and never touches his writing.** The summary and
 * Timeline are written only to a page with no content yet; a sub-page is
 * created only when no child page of that name exists. So it is safe to run
 * again whenever something new arrives — a JD captured after he applied, a
 * pack that finished later — and it fills in exactly what is missing.
 */
import type { PostingMeta, PostingAnalysis, PostingQuestions, PostingArtifact } from '../../shared/types'
import type { AppEnv, KVNamespace } from './notion'
import { getJD, getAnalysis, getQuestions } from './postings'
import { channelOf } from '../../shared/postings'
import { localDate } from './ei-week'
import { markdownToBlocks, appendBlocks, createSubpage, listChildren, type Block } from './notion-blocks'

const SITE = 'https://jobs.codertheory.dev'

const PAGES = {
  jd: { title: 'Job Description', emoji: '📋', match: 'job description', blurb: 'the posting as it read when you applied' },
  pack: { title: 'Apply Pack', emoji: '📦', match: 'apply pack', blurb: 'what was sent: the CV, cover letter and form answers' },
  analytics: { title: 'Analytics', emoji: '📊', match: 'analytics', blurb: 'the career-ops evaluation: fit, strengths, gaps, comp' },
} as const
type PageKey = keyof typeof PAGES

export interface SyncResult {
  ok: boolean
  created: string[]
  wroteSummary: boolean
  error?: string
}

const titleOf = (b: Block) => String(b?.child_page?.title ?? '').toLowerCase()
const isBlankParagraph = (b: Block) =>
  b.type === 'paragraph' && !(b.paragraph?.rich_text ?? []).some((r: any) => String(r?.plain_text ?? r?.text?.content ?? '').trim())

function via(meta: PostingMeta): string {
  const channel = channelOf(meta.url)
  return channel || new URL(meta.url).hostname.replace(/^www\./, '')
}

const esc = (s: string) => s.replace(/\*\*/g, '').replace(/\n+/g, ' ').trim()

// ---- the sub-pages ----

function jdMarkdown(meta: PostingMeta, jd: string): string {
  const from =
    meta.jdSource === 'pasted' ? 'pasted from the posting'
    : meta.jdSource === 'career-ops' || !meta.jdSource ? `archived by career-ops${meta.reportNum ? ` (report #${meta.reportNum})` : ''}`
    : `captured from ${meta.jdSource}${meta.jdCapturedAt ? ` on ${localDate(meta.jdCapturedAt)}` : ''}`
  const facts = [
    `**Source:** [${via(meta)} posting](${meta.url}) · ${from}`,
    meta.location ? `**Location:** ${esc(meta.location)}` : '',
    meta.comp ? `**Comp:** ${esc(meta.comp)}` : '',
  ].filter(Boolean)
  return `${facts.join('\n\n')}\n\n---\n\n${jd}`
}

const ARTIFACT_LABEL: Record<PostingArtifact['kind'], string> = {
  cv: 'tailored CV',
  'cover-letter': 'cover letter',
  notes: 'apply notes',
  other: 'file',
}

function packMarkdown(meta: PostingMeta, questions: PostingQuestions | null): string | null {
  const answered = (questions?.questions ?? []).filter((q) => q.answer.trim())
  if (!meta.artifacts.length && !answered.length) return null
  const lines: string[] = [
    [
      meta.appliedAt ? `**Applied:** ${localDate(meta.appliedAt)}` : '',
      `**Discovered via:** [${via(meta)}](${meta.url})`,
    ].filter(Boolean).join(' · '),
  ]
  const where = [meta.location && `**Location:** ${esc(meta.location)}`, meta.comp && `**Salary:** ${esc(meta.comp)}`].filter(Boolean)
  if (where.length) lines.push(where.join(' · '))
  lines.push('---')
  if (meta.artifacts.length) {
    lines.push('## Files sent')
    for (const a of meta.artifacts) {
      const kb = Math.max(1, Math.round(a.bytes / 1024))
      lines.push(`- [${a.name}](${SITE}/api/postings/${meta.id}/artifacts/${encodeURIComponent(a.name)}) — ${ARTIFACT_LABEL[a.kind]} (${kb} KB)`)
    }
  }
  if (answered.length) {
    lines.push('## Application questions')
    for (const q of answered) lines.push(`### ${esc(q.question)}`, q.answer.trim())
  }
  if (meta.packNote) lines.push('## Notes', `- ${esc(meta.packNote)}`)
  lines.push('---', `*Files are kept on jobs.codertheory.dev; the links open there. [The posting on the site](${SITE}/postings/${meta.id}).*`)
  return lines.join('\n\n')
}

function analyticsMarkdown(meta: PostingMeta, a: PostingAnalysis): string | null {
  const s: string[] = []
  // Items are built below with the data already passed through esc(); only
  // tidy them here, or the **bold** added around a score would be stripped.
  const list = (title: string, items: string[]) => {
    const kept = items.map((i) => i.replace(/\n+/g, ' ').trim()).filter(Boolean)
    if (kept.length) s.push(`## ${title}`, ...kept.map((i) => `- ${i}`))
  }
  list('Score / fit', [
    meta.score !== null ? `**${meta.score.toFixed(1)}/5**${a.archetype ? ` · Archetype: ${esc(a.archetype)}` : ''}` : a.archetype ? `Archetype: ${esc(a.archetype)}` : '',
    a.finalDecision ? `Verdict: ${esc(a.finalDecision)}` : '',
    [a.legitimacy && `Legitimacy: ${esc(a.legitimacy)}`, a.riskLevel && `Risk: ${esc(a.riskLevel)}`, a.confidence && `Confidence: ${esc(a.confidence)}`].filter(Boolean).join(' · '),
    a.workAuth ? `Work authorization: ${esc(a.workAuth)}` : '',
  ])
  list('Why', [esc(meta.why)])
  list('Why strong', a.topStrengths.map(esc))
  list('Watch-outs / gaps', [...a.hardStops.map((h) => `**Hard stop:** ${esc(h)}`), ...a.softGaps.map(esc)])
  list(
    'Requirements',
    a.requirements.slice(0, 25).map((r) => `**${esc(r.requirement)}**${r.match ? ` — ${esc(r.match)}` : ''}${r.importance ? ` (${esc(r.importance)})` : ''}`),
  )
  const comp = a.advertisedComp || meta.comp
  list('Comp', [comp ? `Advertised: ${esc(comp)}` : ''])
  list('Recommendation', [esc(a.nextAction ?? '')])
  if (!s.length) return null
  s.push('---', `*Synthesized from the career-ops evaluation${meta.reportNum ? ` (report #${meta.reportNum})` : ''}.*`)
  return s.join('\n\n')
}

// ---- the page itself ----

function summaryMarkdown(meta: PostingMeta, present: PageKey[]): string {
  const applied = meta.appliedAt ? localDate(meta.appliedAt) : null
  const headline = [
    '**career-ops**',
    meta.score !== null ? `Fit ${meta.score.toFixed(1)}/5` : '',
    applied ? `Applied ${applied} via ${via(meta)}` : '',
  ].filter(Boolean).join(' · ')
  const sent = meta.artifacts.some((a) => a.kind === 'cv') ? ' with a tailored CV' + (meta.artifacts.some((a) => a.kind === 'cover-letter') ? ' and cover letter' : '') : ''
  const lines = [`> ${headline}`, '## Timeline', applied ? `- **${applied}** — Applied via ${via(meta)}${sent}` : '- Added from jobs.codertheory.dev']
  if (present.length) {
    lines.push('## Sub-pages', ...present.map((k) => `- ${PAGES[k].emoji} **${PAGES[k].title}** — ${PAGES[k].blurb}`))
  }
  lines.push('---', '*Set up from jobs.codertheory.dev. Interview prep, transcripts and round reviews go below as the process goes on.*')
  return lines.join('\n\n')
}

export async function syncApplicationPage(env: AppEnv, kv: KVNamespace, meta: PostingMeta): Promise<SyncResult> {
  const token = env.NOTION_TOKEN
  const pageId = meta.notionPageId
  if (!token || !pageId) return { ok: false, created: [], wroteSummary: false, error: 'No Notion page for this posting yet.' }

  try {
    const [children, jd, analysis, questions] = await Promise.all([
      listChildren(token, pageId),
      meta.hasJD ? getJD(kv, meta.id) : Promise.resolve(null),
      meta.hasAnalysis ? getAnalysis(kv, meta.id) : Promise.resolve(null),
      meta.questions > 0 ? getQuestions(kv, meta.id) : Promise.resolve(null),
    ])
    const existing = new Set(children.filter((b) => b.type === 'child_page').map(titleOf))
    const has = (k: PageKey) => [...existing].some((t) => t.includes(PAGES[k].match))

    const bodies: Record<PageKey, string | null> = {
      jd: jd ? jdMarkdown(meta, jd) : null,
      pack: packMarkdown(meta, questions),
      analytics: analysis ? analyticsMarkdown(meta, analysis) : null,
    }
    const order: PageKey[] = ['jd', 'pack', 'analytics']
    const toCreate = order.filter((k) => bodies[k] && !has(k))
    const present = order.filter((k) => has(k) || toCreate.includes(k))

    // The summary first, so the sub-pages created after it sit beneath it —
    // the same order his own pages have. Only onto an empty page.
    const wroteSummary = children.every((b) => b.type === 'child_page' || isBlankParagraph(b))
    if (wroteSummary) await appendBlocks(token, pageId, markdownToBlocks(summaryMarkdown(meta, present)))

    const created: string[] = []
    for (const k of toCreate) {
      await createSubpage(token, pageId, PAGES[k].title, PAGES[k].emoji, markdownToBlocks(bodies[k]!))
      created.push(PAGES[k].title)
    }
    return { ok: true, created, wroteSummary }
  } catch (err) {
    return { ok: false, created: [], wroteSummary: false, error: String((err as Error)?.message ?? err).slice(0, 300) }
  }
}
