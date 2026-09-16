import { describe, expect, it } from 'vitest'
import {
  buildCompactionProjection,
  diffProjection,
  fullProjection,
  latestFullFoldSeq,
  visibleProjection,
} from '../src/ledger/projection.ts'
import type { LedgerEntry } from '../src/ledger/types.ts'
import { makeObservation, makeReflection } from './fixtures.ts'

const OBSERVED = makeObservation({ content: 'observed fact', sourceEventSeqs: [2] })
const REFLECTED = makeReflection('durable fact', [OBSERVED.id])

function baseEntries(): LedgerEntry[] {
  return [
    { kind: 'observations-recorded', observations: [OBSERVED], coversUpToSeq: 5 },
    { kind: 'reflections-recorded', reflections: [REFLECTED], coversUpToSeq: 5 },
    { kind: 'observations-dropped', observationIds: [OBSERVED.id], coversUpToSeq: 6 },
  ]
}

describe('fullProjection', () => {
  it('folds everything at the tip', () => {
    const projection = fullProjection(baseEntries())
    expect(projection.reflections).toEqual([REFLECTED])
    expect(projection.observations).toEqual([]) // dropped
  })

  it('respects the boundary seq', () => {
    const projection = fullProjection(baseEntries(), 5)
    expect(projection.reflections).toEqual([REFLECTED])
    expect(projection.observations).toEqual([OBSERVED]) // drop is at 6 > 5
  })
})

describe('visibleProjection', () => {
  it('is empty before the first memory-backed compaction', () => {
    expect(visibleProjection(baseEntries())).toEqual({ observations: [], reflections: [] })
  })

  it('reads the latest visible-memory record', () => {
    const entries: LedgerEntry[] = [
      ...baseEntries(),
      {
        kind: 'visible-memory',
        text: 'rendered',
        upToSeq: 6,
        fullFold: true,
        observations: [],
        reflections: [REFLECTED],
      },
    ]
    const projection = visibleProjection(entries)
    expect(projection.reflections).toEqual([REFLECTED])
    expect(projection.observations).toEqual([])
  })
})

describe('buildCompactionProjection', () => {
  it('holds reflections and drops at the last full-fold boundary on normal folds', () => {
    const entries: LedgerEntry[] = [
      ...baseEntries(),
      {
        kind: 'visible-memory',
        text: 'old',
        upToSeq: 4,
        fullFold: true,
        observations: [OBSERVED],
        reflections: [],
      },
    ]
    // Observation tokens below pool max → normal fold: observations through
    // tip, reflections/drops held at seq 4 (both recorded at 5/6 → excluded).
    const projection = buildCompactionProjection(entries, 10, { observationsPoolMaxTokens: 1000 })
    expect(projection.fullFold).toBe(false)
    expect(projection.observations).toEqual([OBSERVED])
    expect(projection.reflections).toEqual([])
  })

  it('full-folds when the observation pool reaches the max budget', () => {
    const projection = buildCompactionProjection(baseEntries(), 10, { observationsPoolMaxTokens: 1 })
    expect(projection.fullFold).toBe(true)
    expect(projection.reflections).toEqual([REFLECTED])
    expect(projection.observations).toEqual([]) // drop applied
  })
})

describe('latestFullFoldSeq / diffProjection', () => {
  it('tracks the full-fold boundary and visible/full drift', () => {
    const entries: LedgerEntry[] = [
      ...baseEntries(),
      {
        kind: 'visible-memory',
        text: 'rendered',
        upToSeq: 6,
        fullFold: true,
        observations: [],
        reflections: [REFLECTED],
      },
    ]
    expect(latestFullFoldSeq(entries)).toBe(6)

    const extra = makeObservation({ content: 'newer observation', sourceEventSeqs: [8] })
    entries.push({ kind: 'observations-recorded', observations: [extra], coversUpToSeq: 9 })
    const diff = diffProjection(visibleProjection(entries), fullProjection(entries))
    expect(diff.observationsOnlyInFull.map((o) => o.id)).toEqual([extra.id])
    expect(diff.reflectionsOnlyInFull).toEqual([])
    expect(diff.droppedOnlyInFull).toEqual([])
  })
})
