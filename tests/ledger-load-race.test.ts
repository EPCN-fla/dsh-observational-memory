import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

let target = ''
let gateRead = false
let entered = () => {}
let release = () => {}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async readFile(path: Parameters<typeof actual.readFile>[0], options: Parameters<typeof actual.readFile>[1]) {
      const result = await actual.readFile(path, options)
      if (gateRead && String(path) === target) {
        gateRead = false
        entered()
        await new Promise<void>(resolve => { release = resolve })
      }
      return result
    },
  }
})

import { LedgerStore, ledgerFileName } from '../src/ledger/store.ts'
import { makeObservation } from './fixtures.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'om-load-race-')) })
afterEach(async () => {
  gateRead = false
  release()
  await rm(dir, { recursive: true, force: true })
})

test('a delayed read cannot overwrite a newer strict cache', async () => {
  target = join(dir, ledgerFileName('s1'))
  await writeFile(target, '', 'utf8')
  const store = new LedgerStore(dir)
  const reading = new Promise<void>(resolve => { entered = resolve })
  gateRead = true
  const stale = store.load('s1')
  await reading
  await store.appendAllStrict('s1', [{
    kind: 'observations-recorded', observations: [makeObservation()], coversUpToSeq: 1,
  }])
  release()
  await stale
  expect(store.entries('s1')).toHaveLength(1)
  expect(await new LedgerStore(dir).loadStrict('s1')).toHaveLength(1)
})
