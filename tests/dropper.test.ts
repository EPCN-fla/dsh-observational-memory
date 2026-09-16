import { describe, expect, it } from 'vitest'
import { normalizeDropObservationIds, runDropper, selectDropCandidates } from '../src/workers/dropper.ts'
import { observationPoolMetrics } from '../src/workers/pool.ts'
import { fakeLlmCtx } from './fake-llm.ts'
import { makeObservation, makeReflection } from './fixtures.ts'

const TARGET = { provider: 'p', model: 'm' }

function obs(id: string, relevance: 'low' | 'medium' | 'high' | 'critical', timestamp: string, contentLength = 0) {
  // Pool budgets price the full rendered line; pad content to control size.
  const content = `observation ${id}${contentLength > 0 ? ' ' + 'x'.repeat(contentLength) : ''}`
  return makeObservation({ id, content, relevance, timestamp })
}

describe('observationPoolMetrics', () => {
  it('reports readiness only when over target with drops allowed', () => {
    // Two ~429-token lines (id + timestamp + relevance + 1600 chars of content).
    const observations = [obs('aaaaaaaaaaaa', 'low', '2026-01-01 10:00', 1600), obs('bbbbbbbbbbbb', 'low', '2026-01-01 10:01', 1600)]
    const over = observationPoolMetrics(observations, 500)
    expect(over.overTarget).toBe(true)
    expect(over.ready).toBe(true)
    expect(over.maxDropsAllowed).toBe(1)

    const under = observationPoolMetrics(observations, 5000)
    expect(under.ready).toBe(false)
    expect(under.maxDropsAllowed).toBe(0)
  })
})

describe('selectDropCandidates', () => {
  const observations = [
    obs('aaaaaaaaaaaa', 'critical', '2026-01-01 10:00'),
    obs('bbbbbbbbbbbb', 'low', '2026-01-03 10:00'),
    obs('cccccccccccc', 'high', '2026-01-02 10:00'),
  ]

  it('ranks by coverage, then relevance, then age, capped at maxDrops', () => {
    const reflection = makeReflection('covers b and c', ['bbbbbbbbbbbb', 'cccccccccccc'])
    const picked = selectDropCandidates(['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'], observations, 2, [reflection])
    // b and c are covered (partial), a is not — covered first; within coverage,
    // low relevance (b) before high (c).
    expect(picked).toEqual(['bbbbbbbbbbbb', 'cccccccccccc'])
  })

  it('returns empty when maxDrops is zero', () => {
    expect(selectDropCandidates(['aaaaaaaaaaaa'], observations, 0)).toEqual([])
  })
})

describe('runDropper', () => {
  it('returns undefined when the pool is under target', async () => {
    const { ctx, callCount } = fakeLlmCtx([{ text: 'should not run' }])
    const result = await runDropper(ctx, {
      target: TARGET,
      reflections: [],
      observations: [obs('aaaaaaaaaaaa', 'low', '2026-01-01 10:00', 10)],
      targetTokens: 1000,
      maxTurns: 2,
    })
    expect(result).toBeUndefined()
    expect(callCount()).toBe(0)
  })

  it('drops only model-proposed ids within the cap', async () => {
    const observations = [
      obs('aaaaaaaaaaaa', 'low', '2026-01-01 10:00', 1600),
      obs('bbbbbbbbbbbb', 'medium', '2026-01-01 11:00', 1600),
      obs('cccccccccccc', 'critical', '2026-01-01 12:00', 1600),
    ]
    const { ctx } = fakeLlmCtx([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'drop_observations',
            arguments: JSON.stringify({ ids: ['cccccccccccc', 'aaaaaaaaaaaa', 'ffffffffffff'] }),
          },
        ],
      },
      { text: 'done' },
    ])
    const result = await runDropper(ctx, {
      target: TARGET,
      reflections: [],
      observations,
      targetTokens: 500,
      maxTurns: 3,
    })
    // ~1287 tokens over the 500 target at ~429 tokens each → 2 drops allowed;
    // the foreign id is filtered; low relevance drops before critical.
    expect(result).toEqual(['aaaaaaaaaaaa', 'cccccccccccc'])
  })
})

describe('normalizeDropObservationIds', () => {
  it('keeps only known ids, deduped', () => {
    const observations = [obs('aaaaaaaaaaaa', 'low', '2026-01-01 10:00')]
    expect(normalizeDropObservationIds(['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'aaaaaaaaaaaa'], observations)).toEqual([
      'aaaaaaaaaaaa',
    ])
    expect(normalizeDropObservationIds(['bbbbbbbbbbbb'], observations)).toBeUndefined()
  })
})
