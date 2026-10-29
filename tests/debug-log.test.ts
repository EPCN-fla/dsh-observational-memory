import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DebugLog } from '../src/debug-log.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'om-debug-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('DebugLog', () => {
  it('contains serialization failures instead of throwing into memory work', () => {
    const errors: string[] = []
    const log = new DebugLog(dir, message => errors.push(message))
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => log.log('s1', 'bigint', { value: 1n })).not.toThrow()
    expect(() => log.log('s1', 'circular', circular)).not.toThrow()
    expect(errors).toHaveLength(2)
    expect(errors.every(message => message.includes('serialization failed'))).toBe(true)
  })
})
