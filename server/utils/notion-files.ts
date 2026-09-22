/**
 * Put the built files *into* Notion, not just links to them.
 *
 * The Apply Pack sub-page has always listed the CV and cover letter as links
 * back to jobs.codertheory.dev. That is fine while the site exists, and worth
 * nothing the day it does not: KV is a cache with a paid plan behind it, and
 * the one place these should survive is the Notion page for the application
 * they belong to. Notion's own words for what happens after an upload is
 * attached: "the file becomes a permanent part of your workspace".
 *
 * Three calls, per Notion's file-upload API:
 *   1. POST /v1/file_uploads            → { id, upload_url }
 *   2. POST /v1/file_uploads/:id/send   → the bytes, multipart, field "file"
 *   3. PATCH /v1/blocks/:page/children  → a `file` block referencing the id
 *
 * **Why this uses a different Notion-Version from everything else.** The rest
 * of the app is pinned to 2022-06-28, and it should stay there: 2025-09-03
 * changed how databases and page parents are shaped, which is exactly what
 * `applications-notion.ts` and `aggregate.ts` read. The file-upload endpoints
 * did not exist then, so these three calls — and only these — use the version
 * that knows about them. Two versions is worth it against re-testing every
 * property reader in the app.
 *
 * Limits that matter here: 20MB per single-part upload (a tailored CV is about
 * 110KB), and an upload id must be attached within an hour of being created,
 * which is not a constraint when both happen in the same request.
 */
import type { AppEnv } from './notion'

/** Only the file-upload calls speak this version. See the note above. */
const NOTION_FILES_VERSION = '2026-03-11'
const API = 'https://api.notion.com/v1'

/** Notion's single-part ceiling. Anything larger needs the multi-part flow. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export interface UploadedFile {
  name: string
  uploadId: string
}

async function notionJson(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_FILES_VERSION,
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Notion ${res.status} on ${path}: ${String((body as any)?.message ?? '').slice(0, 200)}`)
  }
  return body
}

/**
 * Upload one file and return the id to attach it by.
 *
 * Deliberately no retry: this runs inside a request that is already doing
 * several Notion round trips, and a failed upload is reported and skipped
 * rather than holding up the ones that worked.
 */
export async function uploadFile(
  env: AppEnv,
  file: { name: string; contentType: string; bytes: ArrayBuffer },
): Promise<UploadedFile> {
  const token = env.NOTION_TOKEN
  if (!token) throw new Error('No NOTION_TOKEN')
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`${file.name} is ${Math.round(file.bytes.byteLength / 1024 / 1024)}MB — over Notion's 20MB single-part limit`)
  }

  const created = await notionJson(token, '/file_uploads', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, content_type: file.contentType }),
  })
  const id = String(created?.id ?? '')
  if (!id) throw new Error(`Notion accepted the upload request for ${file.name} but returned no id`)

  // The bytes go as multipart with the field named "file" — the one shape the
  // send endpoint accepts. FormData/Blob are both available in workerd.
  const form = new FormData()
  form.append('file', new Blob([file.bytes], { type: file.contentType }), file.name)
  await notionJson(token, `/file_uploads/${id}/send`, { method: 'POST', body: form })

  return { name: file.name, uploadId: id }
}

/** Append each uploaded file to a page as its own file block. */
export async function attachFiles(env: AppEnv, pageId: string, files: UploadedFile[]): Promise<void> {
  const token = env.NOTION_TOKEN
  if (!token || !files.length) return
  await notionJson(token, `/blocks/${pageId}/children`, {
    method: 'PATCH',
    body: JSON.stringify({
      children: files.map((f) => ({
        object: 'block',
        type: 'file',
        file: {
          type: 'file_upload',
          file_upload: { id: f.uploadId },
          // The caption is what makes this idempotent: the filename is read
          // back from it to decide whether a file is already attached.
          caption: [{ type: 'text', text: { content: f.name } }],
        },
      })),
    }),
  })
}

/**
 * Filenames already attached to a page, from whichever field carries them.
 *
 * Notion returns an attached file under `file.name` on some versions and only
 * in the caption on others, and the block is read back through the *old*
 * version elsewhere in the app. Reading all three is cheaper than being wrong
 * and uploading a second copy of a CV every time the page is synced.
 */
export function attachedFilenames(children: any[]): Set<string> {
  const names = new Set<string>()
  for (const b of children) {
    if (b?.type !== 'file') continue
    const f = b.file ?? {}
    const caption = (f.caption ?? []).map((r: any) => String(r?.plain_text ?? r?.text?.content ?? '')).join('')
    for (const candidate of [f.name, caption, f?.file?.url ? decodeURIComponent(String(f.file.url).split('/').pop()!.split('?')[0]!) : '']) {
      const n = String(candidate ?? '').trim()
      if (n) names.add(n)
    }
  }
  return names
}
