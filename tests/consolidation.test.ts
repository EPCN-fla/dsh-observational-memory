import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config } from '../src/config.ts'
import { maybeLaunchConsolidation } from '../src/hooks/consolidation.ts'
import type { EventView } from '../src/serialize.ts'
import { hashId } from '../src/ids.ts'
import { OmRuntime } from '../src/runtime.ts'
import { fakeLlmCtx } from './fake-llm.ts'
import { resetSeqs, userEvent } from './fixtures.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'om-pipeline-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fakeSession(events: EventView[]): Session {
  return {
    id: 's1',
    header: { origin: undefined },
    seq: events.length,
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  } as unknown as Session
}

function fakeCtx(turns: Parameters<typeof fakeLlmCtx>[0]) {
  const { ctx, requests, callCount } = fakeLlmCtx(turns)
  ctx.agents = { get: () => undefined }
  ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 200_000 } })
  ctx.get = () => undefined
  const warnings: string[] = []
  const infos: string[] = []
  ctx.logger = {
    info: (m: string) => void infos.push(m),
    warn: (m: string) => void warnings.push(m),
  }
  return { ctx, requests, callCount, warnings, infos }
}

function longConversation(length: number): EventView[] {
  resetSeqs()
  return Array.from({ length }, (_, i) => userEvent(`message ${i} ${'content '.repeat(length)}`))
}

describe('consolidation pipeline', () => {
  it('records observations when the observer clock is due', async () => {
    const events = longConversation(20)
    const { ctx } = fakeCtx([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'record_observations',
            arguments: JSON.stringify({
              observations: [
                {
                  timestamp: '2026-01-15 14:30',
                  content: 'User kicked off a long task.',
                  relevance: 'medium',
                  sourceEventSeqs: [0],
                },
              ],
            }),
          },
        ],
      },
      { text: 'done' },
    ])
    const runtime = new OmRuntime(Config({ observeAfterTokens: 10, reflectAfterTokens: 100_000, storageDir: dir }), {
      onError: () => {},
    })

    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events))

    const entries = runtime.store.entries('s1')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'observations-recorded', coversUpToSeq: events.length - 1 })
    if (entries[0].kind !== 'observations-recorded') throw new Error('unexpected')
    expect(entries[0].observations[0].content).toBe('User kicked off a long task.')
  })

  it('does nothing in passive mode', async () => {
    const events = longConversation(20)
    const { ctx, callCount } = fakeCtx([{ text: 'unused' }])
    const runtime = new OmRuntime(Config({ observeAfterTokens: 10, passive: true, storageDir: dir }), { onError: () => {} })

    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events))
    expect(callCount()).toBe(0)
    expect(runtime.store.entries('s1')).toHaveLength(0)
  })

  it('runs reflector and dropper after a successful reflection when the pool is over target', async () => {
    const events = longConversation(20)
    const bigContent = `durable fact ${'x'.repeat(400)}`
    const secondContent = `second ${'y'.repeat(400)}`
    const firstId = hashId(bigContent)
    const secondId = hashId(secondContent)
    const { ctx } = fakeCtx([
      // Observer
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'record_observations',
            arguments: JSON.stringify({
              observations: [
                { timestamp: '2026-01-15 14:30', content: bigContent, relevance: 'high', sourceEventSeqs: [0] },
                { timestamp: '2026-01-15 14:31', content: secondContent, relevance: 'low', sourceEventSeqs: [1] },
              ],
            }),
          },
        ],
      },
      { text: 'observed' },
      // Reflector
      {
        toolCalls: [
          {
            id: 'c2',
            name: 'record_reflections',
            arguments: JSON.stringify({
              reflections: [{ content: 'The task uses durable facts.', supportingObservationIds: [firstId] }],
            }),
          },
        ],
      },
      { text: 'reflected' },
      // Dropper: pool is over target; the low observation is the safe drop.
      {
        toolCalls: [{ id: 'c3', name: 'drop_observations', arguments: JSON.stringify({ ids: [secondId] }) }],
      },
      { text: 'dropped' },
    ])
    const runtime = new OmRuntime(
      Config({
        observeAfterTokens: 10,
        reflectAfterTokens: 10,
        observationsPoolMaxTokens: 100,
        storageDir: dir,
      }),
      { onError: () => {} },
    )

    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events))

    const entries = runtime.store.entries('s1')
    expect(entries.map((entry) => entry.kind)).toEqual([
      'observations-recorded',
      'reflections-recorded',
      'observations-dropped',
    ])
    const drop = entries[2]
    if (drop.kind !== 'observations-dropped') throw new Error('unexpected')
    expect(drop.observationIds).toEqual([secondId])
  })

  it('backs off after a deliberate empty observer run', async () => {
    const events = longConversation(20)
    const { ctx, callCount } = fakeCtx([{ text: 'nothing worth recording' }])
    const runtime = new OmRuntime(Config({ observeAfterTokens: 10, reflectAfterTokens: 100_000, storageDir: dir }), {
      onError: () => {},
    })
    const session = fakeSession(events)

    await maybeLaunchConsolidation(ctx, runtime, session)
    expect(callCount()).toBe(1)
    expect(runtime.store.entries('s1')).toHaveLength(0)

    // Same span, no new tokens: the backoff suppresses a re-fire.
    await maybeLaunchConsolidation(ctx, runtime, session)
    expect(callCount()).toBe(1)
  })

  it('keeps the pipeline alive when a worker stream fails', async () => {
    const events = longConversation(20)
    const { ctx, warnings } = fakeCtx([{ finish: 'error' }])
    const runtime = new OmRuntime(Config({ observeAfterTokens: 10, reflectAfterTokens: 100_000, storageDir: dir }), {
      onError: () => {},
    })

    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events))
    expect(runtime.lastObserverError.get('s1')).toContain('boom')
    expect(warnings.some((m) => m.includes('observer failed'))).toBe(true)
    expect(runtime.store.entries('s1')).toHaveLength(0)
  })
})
