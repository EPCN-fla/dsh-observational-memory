import { describe, expect, it } from 'vitest'
import { foldLedger } from '../src/ledger/fold.ts'
import type { LedgerEntry } from '../src/ledger/types.ts'
import { makeObservation, makeReflection } from './fixtures.ts'

describe('foldLedger', () => {
  it('folds observations and reflections, first record wins', () => {
    const first = makeObservation({ content: 'first fact' })
    const duplicate = { ...makeObservation({ content: 'first fact' }), content: 'first fact' }
    const reflection = makeReflection('User prefers pnpm.')
    const entries: LedgerEntry[] = [
      { kind: 'observations-recorded', observations: [first], coversUpToSeq: 3 },
      { kind: 'observations-recorded', observations: [duplicate], coversUpToSeq: 5 },
      { kind: 'reflections-recorded', reflections: [reflection], coversUpToSeq: 5 },
    ]

    const folded = foldLedger(entries)
    expect(folded.observations).toEqual([first])
    expect(folded.activeObservations).toEqual([first])
    expect(folded.reflections).toEqual([reflection])
  })

  it('applies drops as tombstones without deleting history', () => {
    const keep = makeObservation({ content: 'keep me' })
    const drop = makeObservation({ content: 'drop me' })
    const entries: LedgerEntry[] = [
      { kind: 'observations-recorded', observations: [keep, drop], coversUpToSeq: 4 },
      { kind: 'observations-dropped', observationIds: [drop.id], coversUpToSeq: 4 },
    ]

    const folded = foldLedger(entries)
    expect(folded.observations).toHaveLength(2)
    expect(folded.activeObservations).toEqual([keep])
    expect(folded.droppedObservationIds.has(drop.id)).toBe(true)
  })

  it('ignores invalid records and visible-memory bookkeeping', () => {
    const observation = makeObservation({})
    const entries: LedgerEntry[] = [
      { kind: 'observations-recorded', observations: [observation], coversUpToSeq: 2 },
      // Invalid shapes and bookkeeping records:
      { kind: 'observations-recorded', observations: [], coversUpToSeq: 3 } as unknown as LedgerEntry,
      {
        kind: 'visible-memory',
        text: 'rendered',
        upToSeq: 2,
        fullFold: true,
        observations: [observation],
        reflections: [],
      },
      { kind: 'something-else', data: {} } as unknown as LedgerEntry,
    ]

    const folded = foldLedger(entries)
    expect(folded.observations).toEqual([observation])
    expect(folded.reflections).toEqual([])
  })

  it('honors the upToSeq watermark boundary per record', () => {
    const early = makeObservation({ content: 'early' })
    const late = makeObservation({ content: 'late' })
    const reflection = makeReflection('durable fact')
    const entries: LedgerEntry[] = [
      { kind: 'observations-recorded', observations: [early], coversUpToSeq: 2 },
      { kind: 'observations-recorded', observations: [late], coversUpToSeq: 9 },
      { kind: 'reflections-recorded', reflections: [reflection], coversUpToSeq: 2 },
      { kind: 'observations-dropped', observationIds: [early.id], coversUpToSeq: 9 },
    ]

    const folded = foldLedger(entries, { upToSeq: 5 })
    expect(folded.observations.map((o) => o.content)).toEqual(['early'])
    expect(folded.activeObservations.map((o) => o.content)).toEqual(['early'])
    expect(folded.reflections).toEqual([reflection])
  })
})
