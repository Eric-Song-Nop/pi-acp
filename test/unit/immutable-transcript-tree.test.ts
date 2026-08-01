import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const C0_7_TRANSCRIPT_ROOT = new URL('../e2e/transcripts/c0.7/', import.meta.url)
const EXPECTED_TREE_ENTRY_COUNT = 9
const EXPECTED_C1_2_TREE_SHA256 = 'fd8d85afe172a848e45017f2fd59411aaf903f8159e1db2e3e63b2fa82e3781f'

type TreeEntry = { kind: 'directory'; path: string } | { bytes: Buffer; kind: 'file'; path: string }

async function readTreeEntries(directory: URL, prefix = ''): Promise<TreeEntry[]> {
  const children = await readdir(directory, { withFileTypes: true })
  children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))

  const entries: TreeEntry[] = []
  for (const child of children) {
    const path = prefix ? `${prefix}/${child.name}` : child.name
    const childUrl = new URL(`${child.name}${child.isDirectory() ? '/' : ''}`, directory)
    if (child.isDirectory()) {
      entries.push({ kind: 'directory', path })
      entries.push(...(await readTreeEntries(childUrl, path)))
    } else if (child.isFile()) {
      entries.push({ bytes: await readFile(childUrl), kind: 'file', path })
    } else {
      throw new Error(`C0.7 immutable transcript tree contains an unsupported entry: ${path}`)
    }
  }
  return entries
}

function digestTree(entries: readonly TreeEntry[]): string {
  const hash = createHash('sha256')
  for (const entry of entries) {
    const bytes = entry.kind === 'file' ? entry.bytes : Buffer.alloc(0)
    hash.update(`${entry.kind}\0${String(Buffer.byteLength(entry.path))}\0${entry.path}\0${String(bytes.length)}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

test('C0.7 complete transcript directory remains byte-identical to the C1.2 publication tree', async () => {
  const entries = await readTreeEntries(C0_7_TRANSCRIPT_ROOT)
  assert.equal(entries.length, EXPECTED_TREE_ENTRY_COUNT)
  assert.equal(digestTree(entries), EXPECTED_C1_2_TREE_SHA256)
})
