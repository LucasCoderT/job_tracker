/**
 * Light Markdown → Notion blocks, and the two calls that write them.
 *
 * Only what the application sub-pages use: ## / ### headings, - and 1.
 * lists, > quotes, --- dividers, paragraphs, and inline **bold**, `code` and
 * [links](url). Anything else comes through as a plain paragraph, which is the
 * right failure: the words survive even when the formatting does not.
 *
 * Notion's limits shape the writer: 2000 characters per rich-text element,
 * 100 elements per rich-text array, 100 blocks per append. Long text is
 * chunked rather than truncated — a job description is not ours to shorten.
 */
import { NOTION_VERSION } from './config'

type RichText = { type: 'text'; text: { content: string; link?: { url: string } | null }; annotations?: Record<string, boolean> }
export type Block = Record<string, any>

export async function notionCall(token: string, path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Notion ${res.status}: ${String(data?.message || res.status).slice(0, 200)}`)
  return data
}

function pieces(content: string, annotations?: Record<string, boolean>, link?: string): RichText[] {
  const out: RichText[] = []
  for (let i = 0; i < content.length; i += 2000) {
    out.push({
      type: 'text',
      text: { content: content.slice(i, i + 2000), ...(link ? { link: { url: link } } : {}) },
      ...(annotations ? { annotations } : {}),
    })
  }
  return out
}

/**
 * Inline **bold**, *italic*, `code` and [text](https://…). A link inside
 * italics keeps its link and loses the slant — nothing nests.
 */
export function inline(text: string): RichText[] {
  const out: RichText[] = []
  const re = /\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(...pieces(text.slice(last, m.index)))
    if (m[1]) out.push(...pieces(m[1], { bold: true }))
    else if (m[2]) out.push(...inline(m[2]).map((r) => (r.text.link ? r : { ...r, annotations: { ...r.annotations, italic: true } })))
    else if (m[3]) out.push(...pieces(m[3], { code: true }))
    else out.push(...pieces(m[4]!, undefined, m[5]))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(...pieces(text.slice(last)))
  return out.slice(0, 100)
}

const block = (type: string, text: string): Block => ({ object: 'block', type, [type]: { rich_text: inline(text) } })

export function markdownToBlocks(md: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (!para.length) return
    const text = para.join(' ').trim()
    // A paragraph longer than one rich-text array can hold becomes several.
    for (let i = 0; i < text.length; i += 190_000) blocks.push(block('paragraph', text.slice(i, i + 190_000)))
    para = []
  }
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()
    const t = line.trim()
    if (!t) { flush(); continue }
    let m: RegExpMatchArray | null
    if ((m = t.match(/^#{1,2}\s+(.*)$/))) { flush(); blocks.push(block('heading_2', m[1]!)); continue }
    if ((m = t.match(/^#{3,6}\s+(.*)$/))) { flush(); blocks.push(block('heading_3', m[1]!)); continue }
    if (/^(-{3,}|\*{3,})$/.test(t)) { flush(); blocks.push({ object: 'block', type: 'divider', divider: {} }); continue }
    if ((m = t.match(/^[-*•]\s+(.*)$/))) { flush(); blocks.push(block('bulleted_list_item', m[1]!)); continue }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { flush(); blocks.push(block('numbered_list_item', m[1]!)); continue }
    if ((m = t.match(/^>\s?(.*)$/))) { flush(); blocks.push(block('quote', m[1]!)); continue }
    para.push(t)
  }
  flush()
  return blocks
}

/** Append blocks to a page, 100 at a time, in order. */
export async function appendBlocks(token: string, parentId: string, blocks: Block[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += 100) {
    await notionCall(token, `/blocks/${parentId}/children`, 'PATCH', { children: blocks.slice(i, i + 100) })
  }
}

/** Create a child page under `parentId` holding `blocks`. */
export async function createSubpage(token: string, parentId: string, title: string, emoji: string, blocks: Block[]): Promise<string> {
  const page = await notionCall(token, '/pages', 'POST', {
    parent: { page_id: parentId },
    icon: { type: 'emoji', emoji },
    properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
    children: blocks.slice(0, 100),
  })
  if (blocks.length > 100) await appendBlocks(token, page.id, blocks.slice(100))
  return page.id
}

/** Every direct child block of a page. */
export async function listChildren(token: string, pageId: string): Promise<Block[]> {
  const out: Block[] = []
  let cursor: string | undefined
  do {
    const res = await notionCall(token, `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`, 'GET')
    out.push(...(res.results ?? []))
    cursor = res.has_more ? res.next_cursor : undefined
  } while (cursor)
  return out
}
