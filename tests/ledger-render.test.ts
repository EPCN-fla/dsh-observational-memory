import { describe, expect, it } from 'vitest'
import {
  observationToSummaryLine,
  reflectionToSummaryLine,
  renderSummary,
} from '../src/ledger/render.ts'
import { makeObservation, makeReflection } from './fixtures.ts'

describe('renderSummary', () => {
  it('renders an empty string when there is nothing to show', () => {
    expect(renderSummary([], [])).toBe('')
  })

  it('renders instructions plus reflection and observation sections', () => {
    const observation = makeObservation({
      id: 'd4e5f6a1b2c3',
      timestamp: '2026-01-15 14:30',
      relevance: 'high',
      content: 'User decided to switch from REST to GraphQL.',
    })
    const reflection = makeReflection('User works at Acme Corp.')
    const text = renderSummary([reflection], [observation])

    expect(text).toContain('These are condensed memories from earlier in this session.')
    expect(text).toContain('use the recall tool')
    expect(text).toContain('## Reflections')
    expect(text).toContain(reflectionToSummaryLine(reflection))
    expect(text).toContain('## Observations')
    expect(text).toContain('[d4e5f6a1b2c3] 2026-01-15 14:30 [high] User decided to switch from REST to GraphQL.')
  })

  it('omits empty sections', () => {
    const observation = makeObservation({})
    const text = renderSummary([], [observation])
    expect(text).not.toContain('## Reflections')
    expect(text).toContain('## Observations')
    expect(text).toContain(observationToSummaryLine(observation))
  })
})
