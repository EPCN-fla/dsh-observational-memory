/**
 * Worker model resolution: the override → routed-header → agent-options →
 * default chain, and the suspension counter behind
 * `modelFallbackAfterFailures`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { PlainConfig } from '../src/config.ts'
import { OmRuntime } from '../src/runtime.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'om-model-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fakeCtx(calls: string[]): Context {
  return {
    llm: {
      resolveModelInfo: async (provider: string, model: string) => {
        calls.push(`${provider}/${model}`)
        if (provider === 'bad') throw new Error('no such route')
        return { context: { contextWindow: 200_000 } }
      },
    },
  } as unknown as Context
}

const session = { id: 's1', requestHeader: () => ({ config: { provider: 'good', model: 'live' } }) } as unknown as Session

describe('OmRuntime.resolveModel override suspension', () => {
  it('counts override resolution failures toward the suspension streak', async () => {
    const warnings: string[] = []
    const runtime = new OmRuntime(
      PlainConfig({ storageDir: dir, model: { provider: 'bad', id: 'dead' }, modelFallbackAfterFailures: 2 }),
      { onError: (message) => warnings.push(message) },
    )
    const calls: string[] = []
    const ctx = fakeCtx(calls)

    // Run 1: override attempted, fails, falls back; streak 1 (< 2).
    const first = await runtime.resolveModel(ctx, session, undefined)
    expect(first.ok && first.viaOverride).toBe(false)

    // Run 2: streak 1 still below the threshold; one more failed attempt.
    await runtime.resolveModel(ctx, session, undefined)

    // Run 3: streak reached the threshold — the override is suspended, no
    // further attempt, one suspension notice instead of per-run warnings.
    const third = await runtime.resolveModel(ctx, session, undefined)
    expect(third.ok && third.viaOverride).toBe(false)

    expect(calls.filter((route) => route === 'bad/dead')).toHaveLength(2)
    expect(calls.filter((route) => route === 'good/live')).toHaveLength(3)
    expect(warnings.filter((message) => message.includes('is unavailable'))).toHaveLength(2)
    expect(warnings.filter((message) => message.includes('suspended'))).toHaveLength(1)
  })

  it('memoizes session context windows per route', async () => {
    const runtime = new OmRuntime(PlainConfig({ storageDir: dir }), { onError: () => {} })
    const calls: string[] = []
    const ctx = fakeCtx(calls)
    const first = await runtime.sessionContextWindow(ctx, session, undefined)
    const second = await runtime.sessionContextWindow(ctx, session, undefined)
    expect(first).toBe(200_000)
    expect(second).toBe(200_000)
    expect(calls).toHaveLength(1)
  })
})
