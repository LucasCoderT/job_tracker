/**
 * Link postings to the Notion rows they became.
 *
 * The site only learns that a posting was applied to when "Mark applied" is
 * pressed on it, and that button is not how most applications happen — the
 * good ones are sent on the employer's own careers page, and the Notion row is
 * written there and then. So the site's `state` has been quietly wrong: of 107
 * postings it called untouched, 14 had been applied to, including every one
 * scoring 4.0 or better. Anything reasoned from that field — "what should I
 * apply to today", or any measurement of which recommendations converted — was
 * reasoning from a field that does not know.
 *
 * This reconciles the two. It never creates anything in Notion; it links a
 * posting to a row that already exists, which keeps the invariant the applied
 * state was given in the first place: `applied` is a consequence of the Notion
 * row existing, never a claim made without one.
 *
 * **The match is exact or it does not happen.** A Notion row's `Job Posting`
 * URL runs through the same `normalizeUrl` + sha256 the posting id is derived
 * from, so a match means both sides resolved the identical posting URL. The
 * obvious alternative — company plus role — is what produced a confident wrong
 * answer when this drift was first investigated: two Sophos roles and two
 * Mozilla roles collapsed onto one tracker row each, and the conclusion drawn
 * from it was false. A name is not a key. Postings whose Notion row carries no
 * URL stay unmatched and are reported, which is the honest outcome.
 */
import type { NotionPage, AppEnv, KVNamespace } from './notion'
import type { PostingMeta } from '../../shared/types'
import { queryAllPages, readUrl, readTitle, readRichText, readStatus, readDateMs } from './notion'
import { SOURCE_PROP, POSITION_PROP } from './config'
import { listPostings, postingIdFor, getMeta, putMeta } from './postings'

export interface ReconcileLink {
  postingId: string
  company: string
  role: string
  state: string
  notionPageId: string
  notionCompany: string
  notionRole: string
  notionStatus: string | null
  appliedAt: string | null
  /** `url` — both sides resolved the same posting URL. `title` — same company
   *  and an identical role title, each unique on both sides. */
  matchedOn: 'url' | 'title'
}

export interface ReconcileReport {
  /** Postings that can be linked to a Notion row and are not linked yet. */
  links: ReconcileLink[]
  /** Already carrying a notionPageId — nothing to do. */
  alreadyLinked: number
  /** Notion rows whose URL matched more than one row; never guessed at. */
  ambiguous: string[]
  /** Notion rows carrying no Job Posting URL, so nothing can be matched to them. */
  notionWithoutUrl: number
  /** Postings with no Notion row pointing at their URL. */
  unmatchedPostings: number
  /**
   * Same company, similar-but-not-identical role. Reported and never written:
   * these are exactly the pairs that produce a confident wrong answer. Sophos
   * has three open roles whose titles share most of their words, and "Applied
   * AI Engineer (P4)" against "AI Engineer (P3)" is one token short of a
   * perfect score and a different job.
   */
  probable: ReconcileLink[]
  applied: number
}

/** Company names differ by a suffix far more often than they differ by identity. */
const normCompany = (s: string) =>
  String(s || '')
    .toLowerCase()
    .replace(/\b(inc|ltd|limited|llc|corp|corporation|co|gmbh|labs|technologies|technology)\b/g, '')
    .replace(/[^a-z0-9]/g, '')

/**
 * Titles are normalised for punctuation and spacing only. Parenthetical parts
 * stay: "(P4)" against "(P3)" is the entire difference between two real roles,
 * and a normaliser that dropped it would link an application to the wrong one.
 */
const normTitle = (s: string) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9()+/]+/g, ' ')
    .trim()

// The separator has to be something no company or title contains, or "Acme"
// + "Engineer" and "Acme Engineer" + "" would become the same key.
const pairKey = (company: string, title: string) => `${normCompany(company)}|||${normTitle(title)}`

/** Notion page id → the posting id its `Job Posting` URL resolves to. */
async function indexNotionByPostingId(pages: NotionPage[]) {
  const byPosting = new Map<string, NotionPage>()
  const ambiguous = new Set<string>()
  let withoutUrl = 0

  for (const page of pages) {
    const url = readUrl(page, SOURCE_PROP)
    if (!url) {
      withoutUrl++
      continue
    }
    const id = await postingIdFor(url)
    if (!id) {
      withoutUrl++
      continue
    }
    const seen = byPosting.get(id)
    if (seen && seen.id !== page.id) {
      // The same posting URL on two rows means he applied twice, or a row was
      // duplicated. Either way the site must not pick one on a coin flip.
      ambiguous.add(id)
      continue
    }
    byPosting.set(id, page)
  }
  return { byPosting, ambiguous, withoutUrl }
}

export async function reconcile(
  env: AppEnv,
  kv: KVNamespace,
  opts: { apply?: boolean } = {},
): Promise<ReconcileReport> {
  const [pages, postings] = await Promise.all([queryAllPages(env), listPostings(kv)])
  const { byPosting, ambiguous, withoutUrl } = await indexNotionByPostingId(pages)

  // Company + identical title, but only where that pair names exactly one row
  // on each side. Sophos alone has three open roles here, so a pair that is not
  // unique is not evidence — it is a coin flip with a company name on it.
  const notionByPair = new Map<string, NotionPage[]>()
  for (const page of pages) {
    const key = pairKey(readTitle(page), readRichText(page, POSITION_PROP))
    notionByPair.set(key, [...(notionByPair.get(key) ?? []), page])
  }
  const postingsByPair = new Map<string, PostingMeta[]>()
  for (const meta of postings) {
    const key = pairKey(meta.company, meta.role)
    postingsByPair.set(key, [...(postingsByPair.get(key) ?? []), meta])
  }

  const linkOf = (meta: PostingMeta, page: NotionPage, matchedOn: 'url' | 'title'): ReconcileLink => {
    const ms = readDateMs(page)
    return {
      postingId: meta.id,
      company: meta.company,
      role: meta.role,
      state: meta.state,
      notionPageId: page.id,
      notionCompany: readTitle(page),
      notionRole: readRichText(page, POSITION_PROP),
      notionStatus: readStatus(page),
      // Notion's own Application Date, never "now". `appliedAt` is one of the
      // timestamps the EI week builds candidate rows from, so stamping today
      // on fourteen historical applications would propose fourteen entries he
      // never made, in a document that has already been through an audit.
      appliedAt: ms === null ? null : new Date(ms).toISOString(),
      matchedOn,
    }
  }

  const links: ReconcileLink[] = []
  const probable: ReconcileLink[] = []
  const claimed = new Set<string>() // Notion pages already spoken for
  let alreadyLinked = 0
  let unmatched = 0

  for (const meta of postings) {
    if (meta.notionPageId) {
      alreadyLinked++
      claimed.add(meta.notionPageId)
      continue
    }
    if (ambiguous.has(meta.id)) continue

    const byUrl = byPosting.get(meta.id)
    if (byUrl) {
      links.push(linkOf(meta, byUrl, 'url'))
      claimed.add(byUrl.id)
      continue
    }

    const key = pairKey(meta.company, meta.role)
    const candidates = (notionByPair.get(key) ?? []).filter((p) => !claimed.has(p.id))
    const sameTitlePostings = postingsByPair.get(key) ?? []
    if (candidates.length === 1 && sameTitlePostings.length === 1) {
      links.push(linkOf(meta, candidates[0]!, 'title'))
      claimed.add(candidates[0]!.id)
      continue
    }
    if (candidates.length) {
      for (const page of candidates) probable.push(linkOf(meta, page, 'title'))
      continue
    }
    unmatched++
  }

  let applied = 0
  if (opts.apply) {
    for (const link of links) {
      // Re-read: the listing came from the index, and the write must be built
      // on the record. A posting could also have been applied through the site
      // between the scan and here, in which case it is already correct.
      const fresh = await getMeta(kv, link.postingId)
      if (!fresh || fresh.notionPageId) continue
      await putMeta(kv, {
        ...fresh,
        state: 'applied',
        notionPageId: link.notionPageId,
        appliedAt: fresh.appliedAt ?? link.appliedAt,
        updatedAt: new Date().toISOString(),
      })
      applied++
    }
  }

  return {
    links,
    alreadyLinked,
    ambiguous: [...ambiguous],
    notionWithoutUrl: withoutUrl,
    unmatchedPostings: unmatched,
    probable,
    applied,
  }
}
