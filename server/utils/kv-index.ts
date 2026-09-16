/**
 * A listing index for a KV store: every record in one document, so listing
 * costs **one read** instead of one per record plus a list request.
 *
 * Both stores here listed the same way — `list({prefix:'meta:'})` then a `get`
 * per key — which at 123 postings is 124 KV operations per call. The callers
 * are machines: five launchd agents poll on top of every page load, which put
 * the site at roughly 118,000 reads and 1,800 list requests a day against a
 * free-plan allowance of 100,000 and 1,000. Exceeding either does not throttle,
 * it **fails every further operation of that type until 00:00 UTC** — the site
 * and both desktop workers would go down mid-afternoon, daily. Through this
 * index the same traffic is a few thousand reads and almost no list requests.
 *
 * **The index is a cache, never the record.** `meta:<id>` stays authoritative
 * and every item route still reads it directly; only listings come from here.
 * That is what makes the failure modes boring: a stale or missing index costs
 * a stale listing, never a lost record.
 *
 * Freshness is *better* than the scan it replaces, not worse: `upsert` patches
 * the index in the same breath as the write, while `list()` trails a write by
 * up to 60s — the reason a just-requested pack could sit invisible to the
 * queue. Two concurrent writers can still drop one patch (read-modify-write,
 * and KV has no compare-and-set); the periodic rebuild heals that, and callers
 * expose `?fresh=1` to force one.
 */
import type { KVNamespace } from './notion'

export interface KvIndexOptions<T> {
  /** The document's key, outside the scanned prefix so it never indexes itself. */
  key: string
  /** Bump to discard every stored index after a shape change. */
  version: number
  /** The prefix a rebuild scans. */
  prefix: string
  idOf: (item: T) => string
  /** Used to keep a just-written record that a lagging `list()` cannot see yet. */
  updatedAtOf: (item: T) => string
  /** The order the listing is served in. Applied on read, so it survives a patch. */
  sort: (items: T[]) => T[]
  /** Rebuilt from the authoritative keys at least this often. */
  maxAgeMs?: number
  /** How recent a write must be to survive a rebuild that cannot see it. */
  graceMs?: number
}

interface IndexDoc<T> {
  version: number
  builtAt: string
  items: T[]
}

export interface KvIndex<T> {
  list(kv: KVNamespace, opts?: { fresh?: boolean }): Promise<T[]>
  upsert(kv: KVNamespace, item: T): Promise<void>
  remove(kv: KVNamespace, id: string): Promise<void>
}

export function createKvIndex<T>(options: KvIndexOptions<T>): KvIndex<T> {
  const { key, version, prefix, idOf, updatedAtOf, sort } = options
  const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000
  const graceMs = options.graceMs ?? 5 * 60 * 1000

  const read = async (kv: KVNamespace): Promise<IndexDoc<T> | null> => {
    const doc = (await kv.get(key, 'json')) as IndexDoc<T> | null
    if (!doc || doc.version !== version || !Array.isArray(doc.items)) return null
    return doc
  }

  const write = (kv: KVNamespace, items: T[], builtAt: string): Promise<void> =>
    kv.put(key, JSON.stringify({ version, builtAt, items } satisfies IndexDoc<T>))

  /** The full scan — the one path that still pays per record. */
  const scan = async (kv: KVNamespace): Promise<T[]> => {
    const items: T[] = []
    let cursor: string | undefined
    do {
      const page = await kv.list({ prefix, limit: 1000, cursor })
      const got = await Promise.all(page.keys.map((k) => kv.get(k.name, 'json')))
      for (const item of got) if (item) items.push(item as T)
      cursor = page.list_complete === false ? page.cursor : undefined
    } while (cursor)
    return items
  }

  const rebuild = async (kv: KVNamespace): Promise<T[]> => {
    const [scanned, previous] = await Promise.all([scan(kv), read(kv)])
    const byId = new Map(scanned.map((item) => [idOf(item), item]))
    // A record written in the last few minutes may not be in `list()` yet. Keep
    // what the index already knew rather than letting a rebuild lose it.
    for (const item of previous?.items ?? []) {
      if (byId.has(idOf(item))) continue
      if (Date.now() - Date.parse(updatedAtOf(item)) < graceMs) byId.set(idOf(item), item)
    }
    const items = sort([...byId.values()])
    await write(kv, items, new Date().toISOString())
    return items
  }

  /**
   * Keep the index in step with a write that already succeeded — best-effort
   * on purpose. The record is stored and authoritative, so an index that could
   * not be patched is a stale listing for up to an hour, never a lost record.
   * Failing his "Build pack" tap because a cache write failed is the worse
   * trade. A missing index is left missing; the next listing rebuilds it.
   */
  const patch = async (kv: KVNamespace, fn: (items: T[]) => T[]): Promise<void> => {
    try {
      const doc = await read(kv)
      if (!doc) return
      await write(kv, sort(fn(doc.items)), doc.builtAt)
    } catch {
      /* the listing self-heals on the next rebuild */
    }
  }

  return {
    async list(kv, opts = {}) {
      if (!opts.fresh) {
        const doc = await read(kv)
        if (doc && Date.now() - Date.parse(doc.builtAt) <= maxAgeMs) return sort(doc.items)
      }
      return await rebuild(kv)
    },
    upsert(kv, item) {
      return patch(kv, (items) => [...items.filter((i) => idOf(i) !== idOf(item)), item])
    },
    remove(kv, id) {
      return patch(kv, (items) => items.filter((i) => idOf(i) !== id))
    },
  }
}
