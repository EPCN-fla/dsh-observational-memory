import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LedgerStore, ledgerFileName } from '../src/ledger/store.ts'
import type { LedgerEntry } from '../src/ledger/types.ts'
import { makeObservation } from './fixtures.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'om-ledger-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function record(content: string, seq: number): LedgerEntry {
  return {
    kind: 'observations-recorded',
    observations: [makeObservation({ content })],
    coversUpToSeq: seq,
  }
}

describe('LedgerStore', () => {
  it('starts empty for unknown sessions', async () => {
    const store = new LedgerStore(dir)
    expect(await store.load('s1')).toEqual([])
  })

  it('does not cache never-written sessions (probe loads stay uncached)', async () => {
    const store = new LedgerStore(dir)
    await store.load('probe')
    expect(store.entries('probe')).toEqual([])
    // A write after probing still persists and caches.
    await store.append('probe', record('fact', 1))
    await store.flush()
    expect(await new LedgerStore(dir).load('probe')).toHaveLength(1)
    // Concurrent first-writes after a probe share one array and lose nothing.
    const raced = new LedgerStore(dir)
    await raced.load('s2')
    await Promise.all([raced.append('s2', record('a', 1)), raced.append('s2', record('b', 2))])
    await raced.flush()
    expect(await new LedgerStore(dir).load('s2')).toHaveLength(2)
  })

  it('persists appended records across reloads', async () => {
    const store = new LedgerStore(dir)
    await store.append('s1', record('fact one', 1))
    await store.append('s1', record('fact two', 2))
    await store.flush()

    const fresh = new LedgerStore(dir)
    const entries = await fresh.load('s1')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'observations-recorded', coversUpToSeq: 1 })
    expect(entries[1]).toMatchObject({ coversUpToSeq: 2 })
  })

  it('serializes concurrent appends without losing records', async () => {
    const store = new LedgerStore(dir)
    await Promise.all([
      store.append('s1', record('a', 1)),
      store.append('s1', record('b', 2)),
      store.append('s1', record('c', 3)),
    ])
    await store.flush()
    expect(await new LedgerStore(dir).load('s1')).toHaveLength(3)
  })

  it('skips invalid lines on load and reports them', async () => {
    const store = new LedgerStore(dir)
    await store.append('s1', record('valid', 1))
    await store.flush()

    const file = join(dir, ledgerFileName('s1'))
    const existing = await readFile(file, 'utf8')
    const errors: string[] = []
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(file, `${existing}{"kind":"nope"}\nnot json\n`, 'utf8'),
    )

    const fresh = new LedgerStore(dir, { onError: (message) => errors.push(message) })
    const entries = await fresh.load('s1')
    expect(entries).toHaveLength(1)
    expect(errors.length).toBe(2)
  })

  it('sanitizes session ids into safe file names', () => {
    expect(ledgerFileName('abc-123_OK')).toBe('abc-123_OK.jsonl')
    expect(ledgerFileName('a/b:c')).toBe('a_2f_b_3a_c.jsonl')
  })
})
