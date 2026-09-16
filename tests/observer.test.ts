import { describe, expect, it } from 'vitest'
import { normalizeSourceEventSeqs, runObserver } from '../src/workers/observer.ts'
import { WorkerStreamError } from '../src/workers/loop.ts'
import { fakeLlmCtx } from './fake-llm.ts'

const TARGET = { provider: 'p', model: 'm' }

function observeTurn(observations: unknown[], thenText = 'done') {
  return [
    {
      toolCalls: [
        { id: 'c1', name: 'record_observations', arguments: JSON.stringify({ observations }) },
      ],
    },
    { text: thenText },
  ]
}

describe('normalizeSourceEventSeqs', () => {
  it('dedupes, sorts into chunk order, and rejects foreign seqs', () => {
    expect(normalizeSourceEventSeqs([5, 2, 5], [2, 5, 9])).toEqual([2, 5])
    expect(normalizeSourceEventSeqs([7], [2, 5, 9])).toBeUndefined()
    expect(normalizeSourceEventSeqs([], [2])).toBeUndefined()
    expect(normalizeSourceEventSeqs(undefined, [2])).toBeUndefined()
    expect(normalizeSourceEventSeqs([1.5], [1])).toBeUndefined()
    expect(normalizeSourceEventSeqs([-1], [1])).toBeUndefined()
  })
})

describe('runObserver', () => {
  it('records validated observations with deterministic ids and token counts', async () => {
    const { ctx } = fakeLlmCtx(
      observeTurn([
        {
          timestamp: '2026-01-15 14:30',
          content: 'User stated they use Postgres.',
          relevance: 'high',
          sourceEventSeqs: [2, 0],
        },
        {
          timestamp: '2026-01-15 14:31',
          content: 'Foreign seq gets rejected.',
          relevance: 'low',
          sourceEventSeqs: [99],
        },
      ]),
    )

    const result = await runObserver(ctx, {
      target: TARGET,
      priorReflections: [],
      priorObservations: [],
      chunk: '[Source event seq: 0]\n...',
      allowedSourceEventSeqs: [0, 2, 4],
      maxTurns: 4,
    })

    expect(result).toHaveLength(1)
    const observation = result![0]
    expect(observation.content).toBe('User stated they use Postgres.')
    expect(observation.sourceEventSeqs).toEqual([0, 2])
    expect(observation.id).toMatch(/^[a-f0-9]{12}$/)
    expect(observation.tokenCount).toBeGreaterThan(0)
  })

  it('returns undefined when the model records nothing', async () => {
    const { ctx } = fakeLlmCtx([{ text: 'nothing worth recording' }])
    const result = await runObserver(ctx, {
      target: TARGET,
      priorReflections: [],
      priorObservations: [],
      chunk: 'chunk',
      allowedSourceEventSeqs: [0],
      maxTurns: 2,
    })
    expect(result).toBeUndefined()
  })

  it('propagates stream failures as WorkerStreamError', async () => {
    const { ctx } = fakeLlmCtx([{ finish: 'error' }])
    await expect(
      runObserver(ctx, {
        target: TARGET,
        priorReflections: [],
        priorObservations: [],
        chunk: 'chunk',
        allowedSourceEventSeqs: [0],
        maxTurns: 2,
      }),
    ).rejects.toBeInstanceOf(WorkerStreamError)
  })
})
