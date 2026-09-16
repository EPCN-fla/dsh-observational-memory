import { describe, expect, it } from 'vitest'
import { normalizeSupportingObservationIds, runReflector } from '../src/workers/reflector.ts'
import { fakeLlmCtx } from './fake-llm.ts'
import { makeObservation } from './fixtures.ts'

const TARGET = { provider: 'p', model: 'm' }

describe('normalizeSupportingObservationIds', () => {
  it('keeps valid active ids in pool order and rejects unknown ones', () => {
    expect(normalizeSupportingObservationIds(['b', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b'])
    expect(normalizeSupportingObservationIds(['zzz'], ['a'])).toBeUndefined()
    expect(normalizeSupportingObservationIds([], ['a'])).toBeUndefined()
  })
})

describe('runReflector', () => {
  const observation = makeObservation({ id: 'a1b2c3d4e5f6', content: 'User stated they use Postgres.' })

  it('records reflections with valid support ids', async () => {
    const { ctx } = fakeLlmCtx([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'record_reflections',
            arguments: JSON.stringify({
              reflections: [
                { content: 'User uses Postgres for the project database.', supportingObservationIds: [observation.id] },
                { content: 'Bogus support is rejected.', supportingObservationIds: ['ffffffffffff'] },
              ],
            }),
          },
        ],
      },
      { text: 'done' },
    ])

    const result = await runReflector(ctx, {
      target: TARGET,
      reflections: [],
      observations: [observation],
      maxTurns: 4,
    })
    expect(result).toHaveLength(1)
    expect(result![0].content).toBe('User uses Postgres for the project database.')
    expect(result![0].supportingObservationIds).toEqual([observation.id])
    expect(result![0].id).toMatch(/^[a-f0-9]{12}$/)
  })

  it('returns undefined when nothing is stable enough (no tool call)', async () => {
    const { ctx } = fakeLlmCtx([{ text: 'nothing durable yet' }])
    const result = await runReflector(ctx, { target: TARGET, reflections: [], observations: [observation], maxTurns: 2 })
    expect(result).toBeUndefined()
  })

  it('skips multi-line reflection content', async () => {
    const { ctx } = fakeLlmCtx([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'record_reflections',
            arguments: JSON.stringify({
              reflections: [{ content: 'line one\nline two', supportingObservationIds: [observation.id] }],
            }),
          },
        ],
      },
      { text: 'done' },
    ])
    const result = await runReflector(ctx, { target: TARGET, reflections: [], observations: [observation], maxTurns: 3 })
    expect(result).toBeUndefined()
  })
})
