/**
 * The base CV the pack test sends, in the POSTINGS KV.
 *
 *   basecv:meta   { startedAt, name, bytes, updatedAt }
 *   basecv:file   the PDF
 *
 * The test starts the first time a base CV is uploaded and `startedAt` never
 * moves after that, so replacing the file (a typo fixed) does not restart it.
 * See shared/pack-test.ts for what the test is.
 */
import type { PackTestInfo } from '../../shared/types'
import type { KVNamespace } from './notion'

const META = 'basecv:meta'
const FILE = 'basecv:file'

export async function getPackTest(kv: KVNamespace): Promise<PackTestInfo | null> {
  return ((await kv.get(META, 'json')) as PackTestInfo | null) ?? null
}

export async function getBaseCv(kv: KVNamespace): Promise<ArrayBuffer | null> {
  return (await kv.get(FILE, 'arrayBuffer')) as ArrayBuffer | null
}

export async function putBaseCv(kv: KVNamespace, name: string, body: ArrayBuffer): Promise<PackTestInfo> {
  const existing = await getPackTest(kv)
  const stamp = new Date().toISOString()
  const info: PackTestInfo = { startedAt: existing?.startedAt ?? stamp, name, bytes: body.byteLength, updatedAt: stamp }
  await kv.put(FILE, body)
  await kv.put(META, JSON.stringify(info))
  return info
}
