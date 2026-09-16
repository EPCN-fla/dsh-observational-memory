import { describe, expect, it } from 'vitest'
import { recallMemorySources } from '../src/ledger/recall.ts'
import type { LedgerEntry } from '../src/ledger/types.ts'
import { makeObservation, makeReflection, resetSeqs, userEvent } from './fixtures.ts'

describe('recallMemorySources', () => {
  it('returns not_found for unknown ids', () => {
    expect(recallMemorySources([], [], 'a1b2c3d4e5f6').status).toBe('not_found')
  })

  it('recalls an active observation with its source events', () => {
    resetSeqs()
    const source = userEvent('We use Postgres, right?')
    const observation = makeObservation({ content: 'User stated they use Postgres.', sourceEventSeqs: [source.seq] })
    const entries: LedgerEntry[] = [
      { kind: 'observations-recorded', observations: [observation], coversUpToSeq: source.seq },
    ]

    const result = recallMemorySources(entries, [source], observation.id)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.kind).toBe('observation')
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0].status).toBe('active')
    expect(result.sourceEvents.map((event) => event.seq)).toEqual([source.seq])
    expect(result.partial).toBe(false)
  })

  it('marks dropped observations and keeps them recallable', () => {
    resetSeqs()
    const source = userEvent('old fact')
    const observation = makeObservation({ content: 'old fact', sourceEventSeqs: [source.seq] })
    const entries: LedgerEntry[] = [
      { kind: 'observations-recorded', observations: [observation], coversUpToSeq: source.seq },
      { kind: 'observations-dropped', observationIds: [observation.id], coversUpToSeq: source.seq },
    ]

    const result = recallMemorySources(entries, [source], observation.id)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.observations[0].status).toBe('dropped')
  })

  it('recalls a reflection with supporting observations and their sources', () => {
    resetSeqs()
    const source = userEvent('we picked GraphQL')
    const observation = makeObservation({ content: 'User chose GraphQL.', sourceEventSeqs: [source.seq] })
    const reflection = makeReflection('The public API uses GraphQL.', [observation.id])
    const entries: LedgerEntry[] = [
      { kind: 'observations-recorded', observations: [observation], coversUpToSeq: source.seq },
      { kind: 'reflections-recorded', reflections: [reflection], coversUpToSeq: source.seq },
    ]

    const result = recallMemorySources(entries, [source], reflection.id)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.kind).toBe('reflection')
    expect(result.reflections.map((match) => match.reflection.id)).toEqual([reflection.id])
    expect(result.observations.map((match) => match.observation.id)).toEqual([observation.id])
    expect(result.sourceEvents.map((event) => event.seq)).toEqual([source.seq])
  })

  it('reports missing and non-source evidence as partial', () => {
    resetSeqs()
    const source = userEvent('kept')
    const observation = makeObservation({
      content: 'mixed evidence',
      sourceEventSeqs: [source.seq, 999],
    })
    const entries: LedgerEntry[] = [
      { kind: 'observations-recorded', observations: [observation], coversUpToSeq: source.seq },
    ]

    const result = recallMemorySources(entries, [source], observation.id)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.partial).toBe(true)
    expect(result.missingSourceEventSeqs).toEqual([999])
    expect(result.sourceEvents.map((event) => event.seq)).toEqual([source.seq])
  })

  it('reports missing supporting observations as partial', () => {
    const reflection = makeReflection('unsupported reflection', ['a1b2c3d4e5f6'])
    const entries: LedgerEntry[] = [
      { kind: 'reflections-recorded', reflections: [reflection], coversUpToSeq: 3 },
    ]
    const result = recallMemorySources(entries, [], reflection.id)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.missingSupportingObservationIds).toEqual(['a1b2c3d4e5f6'])
    expect(result.partial).toBe(true)
  })
})
