import { foldLedger } from './fold.ts'
import {
  isVisibleMemoryRecord,
  type LedgerEntry,
  type Observation,
  type Reflection,
  type VisibleMemoryRecord,
} from './types.ts'

export type Projection = {
  observations: Observation[]
  reflections: Reflection[]
}

export type ProjectionDiff = {
  observationsOnlyInFull: Observation[]
  reflectionsOnlyInFull: Reflection[]
  droppedOnlyInFull: Observation[]
}

export type CompactionProjectionConfig = {
  observationsPoolMaxTokens: number
}

export type CompactionProjection = Projection & {
  fullFold: boolean
}

/** No boundary: the record kind folds through the ledger tip. */
const TIP = Number.POSITIVE_INFINITY
/** A boundary that admits nothing (reflection/drop state before the first full fold). */
const NONE = -1

function foldBounded(
  entries: readonly LedgerEntry[],
  boundaries: { observationsSeq: number; reflectionsSeq: number; dropsSeq: number },
): Projection {
  // foldLedger applies one shared boundary, so fold the reflection/drop state
  // separately and merge: observations/drops come from their own folds.
  const observationFold = foldLedger(entries, { upToSeq: boundaries.observationsSeq })
  const reflectionFold = foldLedger(entries, { upToSeq: boundaries.reflectionsSeq })
  const dropFold = foldLedger(entries, { upToSeq: boundaries.dropsSeq })

  const dropped = new Set(
    [...dropFold.droppedObservationIds].filter((id) => observationFold.observationsById.has(id)),
  )
  return {
    observations: observationFold.observations.filter((observation) => !dropped.has(observation.id)),
    reflections: reflectionFold.reflections,
  }
}

/** Full ledger truth folded through `upToSeq` (default: ledger tip). */
export function fullProjection(entries: readonly LedgerEntry[], upToSeq?: number): Projection {
  const boundary = upToSeq ?? TIP
  return foldBounded(entries, {
    observationsSeq: boundary,
    reflectionsSeq: boundary,
    dropsSeq: boundary,
  })
}

/** The latest visible-memory bookkeeping record, if any. */
export function latestVisibleMemory(entries: readonly LedgerEntry[]): VisibleMemoryRecord | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (isVisibleMemoryRecord(entry)) return entry
  }
  return undefined
}

/**
 * Visible memory: what the latest memory-backed compaction made visible to
 * the agent. Empty before the first such compaction.
 */
export function visibleProjection(entries: readonly LedgerEntry[]): Projection {
  const visible = latestVisibleMemory(entries)
  if (!visible) return { observations: [], reflections: [] }
  return { observations: [...visible.observations], reflections: [...visible.reflections] }
}

/** Session seq of the latest full-fold visible memory, if any. */
export function latestFullFoldSeq(entries: readonly LedgerEntry[]): number | undefined {
  const visible = latestVisibleMemory(entries)
  return visible && visible.fullFold ? visible.upToSeq : undefined
}

/**
 * Build the projection a compaction should make visible when the session has
 * reached `tipSeq`.
 *
 * Normal compactions fold observations through the tip but hold reflection and
 * drop effects stable at the latest full-fold boundary, so visible memory does
 * not reshuffle every compaction. When the normal projection's active
 * observation tokens reach `observationsPoolMaxTokens`, a full fold applies
 * reflections and drops through the tip instead.
 */
export function buildCompactionProjection(
  entries: readonly LedgerEntry[],
  tipSeq: number,
  config: CompactionProjectionConfig,
): CompactionProjection {
  const fullFoldSeq = latestFullFoldSeq(entries)
  const maintenanceSeq = fullFoldSeq ?? NONE
  const normalProjection = foldBounded(entries, {
    observationsSeq: tipSeq,
    reflectionsSeq: maintenanceSeq,
    dropsSeq: maintenanceSeq,
  })
  const observationTokens = normalProjection.observations.reduce(
    (total, observation) => total + observation.tokenCount,
    0,
  )
  const fullFold = observationTokens >= config.observationsPoolMaxTokens
  const projection = fullFold ? fullProjection(entries, tipSeq) : normalProjection
  return {
    fullFold,
    observations: projection.observations,
    reflections: projection.reflections,
  }
}

/** Visible-vs-full drift, for status reporting. */
export function diffProjection(visible: Projection, full: Projection): ProjectionDiff {
  const visibleObservationIds = new Set(visible.observations.map((observation) => observation.id))
  const fullObservationIds = new Set(full.observations.map((observation) => observation.id))
  const visibleReflectionIds = new Set(visible.reflections.map((reflection) => reflection.id))

  return {
    observationsOnlyInFull: full.observations.filter((observation) => !visibleObservationIds.has(observation.id)),
    reflectionsOnlyInFull: full.reflections.filter((reflection) => !visibleReflectionIds.has(reflection.id)),
    droppedOnlyInFull: visible.observations.filter((observation) => !fullObservationIds.has(observation.id)),
  }
}
