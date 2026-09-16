import {
  isObservationsDroppedRecord,
  isObservationsRecordedRecord,
  isReflectionsRecordedRecord,
  type LedgerEntry,
  type Observation,
  type Reflection,
} from './types.ts'

export type FoldLedgerOptions = {
  /**
   * Fold only memory records whose `coversUpToSeq` is at or before this
   * session seq. Omit to fold through the ledger tip.
   */
  upToSeq?: number
}

export type FoldedLedger = {
  /** All first-valid observation records through the fold boundary, including dropped ones. */
  observations: Observation[]
  /** Observation records not tombstoned by a folded drop record. */
  activeObservations: Observation[]
  /** Tombstoned observation ids, including ids without a folded observation. */
  droppedObservationIds: Set<string>
  /** All first-valid reflection records through the fold boundary. */
  reflections: Reflection[]
  observationsById: Map<string, Observation>
  reflectionsById: Map<string, Reflection>
}

/**
 * Fold valid memory ledger records in ledger order.
 *
 * Records past the `upToSeq` watermark boundary, unknown kinds, and invalid
 * shapes are ignored. Observations and reflections use first-valid-record-wins
 * semantics; drops are tombstones retained even when the dropped id is unknown
 * at fold time. `visible-memory` bookkeeping records carry no memory content
 * and never participate in the fold.
 */
export function foldLedger(entries: readonly LedgerEntry[], options: FoldLedgerOptions = {}): FoldedLedger {
  const observationsById = new Map<string, Observation>()
  const reflectionsById = new Map<string, Reflection>()
  const droppedObservationIds = new Set<string>()
  const upToSeq = options.upToSeq

  for (const entry of entries) {
    if (isObservationsRecordedRecord(entry)) {
      if (upToSeq !== undefined && entry.coversUpToSeq > upToSeq) continue
      for (const observation of entry.observations) {
        if (!observationsById.has(observation.id)) observationsById.set(observation.id, observation)
      }
      continue
    }

    if (isReflectionsRecordedRecord(entry)) {
      if (upToSeq !== undefined && entry.coversUpToSeq > upToSeq) continue
      for (const reflection of entry.reflections) {
        if (!reflectionsById.has(reflection.id)) reflectionsById.set(reflection.id, reflection)
      }
      continue
    }

    if (isObservationsDroppedRecord(entry)) {
      if (upToSeq !== undefined && entry.coversUpToSeq > upToSeq) continue
      for (const observationId of entry.observationIds) droppedObservationIds.add(observationId)
    }
  }

  const observations = Array.from(observationsById.values())
  const activeObservations = observations.filter((observation) => !droppedObservationIds.has(observation.id))
  const reflections = Array.from(reflectionsById.values())

  return {
    observations,
    activeObservations,
    droppedObservationIds,
    reflections,
    observationsById,
    reflectionsById,
  }
}
