/**
 * Recall: recover exact source evidence behind a memory id.
 *
 * Memory ids index into the session's ledger; observation sources resolve to
 * session events by seq. Recall is exact lookup, not search.
 */
import { isSourceEvent, type EventView } from '../serialize.ts'
import type { LedgerEntry, Observation, Reflection } from './types.ts'

export type RecalledObservation = {
  observation: Observation
  /** Index of the ledger record carrying this observation. */
  ledgerIndex: number
  /** Index of the observation within that record. */
  recordIndex: number
  status: 'active' | 'dropped'
  sourceEventSeqs: number[]
  sourceEvents: EventView[]
  missingSourceEventSeqs: number[]
  nonSourceEventSeqs: number[]
}

export type RecalledReflection = {
  reflection: Reflection
  ledgerIndex: number
  recordIndex: number
}

export type RecallResult =
  | {
      status: 'not_found'
      memoryId: string
      kind: undefined
      reflections: []
      observations: []
      sourceEvents: []
      missingSourceEventSeqs: []
      nonSourceEventSeqs: []
      missingSupportingObservationIds: []
      collision: false
      partial: false
    }
  | {
      status: 'found'
      memoryId: string
      kind: 'observation' | 'reflection' | 'mixed'
      reflections: RecalledReflection[]
      observations: RecalledObservation[]
      sourceEvents: EventView[]
      missingSourceEventSeqs: number[]
      nonSourceEventSeqs: number[]
      missingSupportingObservationIds: string[]
      collision: boolean
      partial: boolean
    }

type IndexedObservation = { observation: Observation; ledgerIndex: number; recordIndex: number }
type IndexedReflection = { reflection: Reflection; ledgerIndex: number; recordIndex: number }

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values))
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function uniqueBySeq(events: EventView[]): EventView[] {
  const seen = new Set<number>()
  const result: EventView[] = []
  for (const event of events) {
    if (seen.has(event.seq)) continue
    seen.add(event.seq)
    result.push(event)
  }
  return result
}

function indexLedger(entries: readonly LedgerEntry[]): {
  observations: IndexedObservation[]
  reflections: IndexedReflection[]
  droppedIds: Set<string>
} {
  const observations: IndexedObservation[] = []
  const reflections: IndexedReflection[] = []
  const droppedIds = new Set<string>()

  for (let ledgerIndex = 0; ledgerIndex < entries.length; ledgerIndex++) {
    const entry = entries[ledgerIndex]
    if (entry.kind === 'observations-recorded') {
      entry.observations.forEach((observation, recordIndex) => {
        observations.push({ observation, ledgerIndex, recordIndex })
      })
      continue
    }
    if (entry.kind === 'reflections-recorded') {
      entry.reflections.forEach((reflection, recordIndex) => {
        reflections.push({ reflection, ledgerIndex, recordIndex })
      })
      continue
    }
    if (entry.kind === 'observations-dropped') {
      for (const id of entry.observationIds) droppedIds.add(id)
    }
  }

  return { observations, reflections, droppedIds }
}

function resolveObservationSources(
  events: readonly EventView[],
  observation: Observation,
  location: { ledgerIndex: number; recordIndex: number },
): RecalledObservation {
  const sourceEventSeqs = uniqueNumbers(observation.sourceEventSeqs)
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const sourceEvents: EventView[] = []
  const missingSourceEventSeqs: number[] = []
  const nonSourceEventSeqs: number[] = []

  for (const seq of sourceEventSeqs) {
    const sourceEvent = bySeq.get(seq)
    if (!sourceEvent) {
      missingSourceEventSeqs.push(seq)
      continue
    }
    if (!isSourceEvent(sourceEvent)) {
      nonSourceEventSeqs.push(seq)
      continue
    }
    sourceEvents.push(sourceEvent)
  }

  return {
    observation,
    ledgerIndex: location.ledgerIndex,
    recordIndex: location.recordIndex,
    status: 'active',
    sourceEventSeqs,
    sourceEvents,
    missingSourceEventSeqs,
    nonSourceEventSeqs,
  }
}

function notFound(memoryId: string): RecallResult {
  return {
    status: 'not_found',
    memoryId,
    kind: undefined,
    reflections: [],
    observations: [],
    sourceEvents: [],
    missingSourceEventSeqs: [],
    nonSourceEventSeqs: [],
    missingSupportingObservationIds: [],
    collision: false,
    partial: false,
  }
}

export function recallMemorySources(
  entries: readonly LedgerEntry[],
  events: readonly EventView[],
  memoryId: string,
): RecallResult {
  const { observations: indexedObservations, reflections: indexedReflections, droppedIds } = indexLedger(entries)
  const directObservationMatches = indexedObservations.filter(({ observation }) => observation.id === memoryId)
  const reflectionMatches = indexedReflections.filter(({ reflection }) => reflection.id === memoryId)

  if (directObservationMatches.length === 0 && reflectionMatches.length === 0) return notFound(memoryId)

  const observationsById = new Map<string, IndexedObservation>()
  for (const indexed of indexedObservations) {
    if (!observationsById.has(indexed.observation.id)) observationsById.set(indexed.observation.id, indexed)
  }

  const recalledByKey = new Map<string, RecalledObservation>()
  const missingSupportingObservationIds: string[] = []

  function addObservation(indexed: IndexedObservation): void {
    const key = `${indexed.ledgerIndex}:${indexed.recordIndex}`
    if (recalledByKey.has(key)) return
    const recalled = resolveObservationSources(events, indexed.observation, indexed)
    recalled.status = droppedIds.has(indexed.observation.id) ? 'dropped' : 'active'
    recalledByKey.set(key, recalled)
  }

  for (const match of directObservationMatches) addObservation(match)

  for (const { reflection } of reflectionMatches) {
    for (const observationId of uniqueStrings(reflection.supportingObservationIds)) {
      const indexed = observationsById.get(observationId)
      if (!indexed) {
        missingSupportingObservationIds.push(observationId)
        continue
      }
      addObservation(indexed)
    }
  }

  const recalledObservations = Array.from(recalledByKey.values())
  const recalledReflections: RecalledReflection[] = reflectionMatches.map(({ reflection, ledgerIndex, recordIndex }) => ({
    reflection,
    ledgerIndex,
    recordIndex,
  }))
  const sourceEvents = uniqueBySeq(recalledObservations.flatMap((match) => match.sourceEvents))
  const missingSourceEventSeqs = uniqueNumbers(recalledObservations.flatMap((match) => match.missingSourceEventSeqs))
  const nonSourceEventSeqs = uniqueNumbers(recalledObservations.flatMap((match) => match.nonSourceEventSeqs))
  const uniqueMissingSupportingObservationIds = uniqueStrings(missingSupportingObservationIds)
  const matchCount = directObservationMatches.length + reflectionMatches.length

  return {
    status: 'found',
    memoryId,
    kind:
      directObservationMatches.length > 0 && reflectionMatches.length > 0
        ? 'mixed'
        : reflectionMatches.length > 0
          ? 'reflection'
          : 'observation',
    reflections: recalledReflections,
    observations: recalledObservations,
    sourceEvents,
    missingSourceEventSeqs,
    nonSourceEventSeqs,
    missingSupportingObservationIds: uniqueMissingSupportingObservationIds,
    collision: matchCount > 1,
    partial:
      missingSourceEventSeqs.length > 0 ||
      nonSourceEventSeqs.length > 0 ||
      uniqueMissingSupportingObservationIds.length > 0,
  }
}
