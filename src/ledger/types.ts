/**
 * Memory ledger vocabulary. The ledger is the source of truth for a session's
 * observational memory: an append-only list of records held in plugin-owned
 * storage (one JSONL file per session), folded into projections on read.
 *
 * Progress watermarks reference session event sequence numbers
 * (`coversUpToSeq`), because DSH session events carry a monotonic `seq`.
 */

export const RELEVANCE_VALUES = ['low', 'medium', 'high', 'critical'] as const
export type Relevance = (typeof RELEVANCE_VALUES)[number]

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/

/** A timestamped, source-backed event record distilled by the observer. */
export type Observation = {
  /** Deterministic 12-character lowercase hex id (content hash). */
  id: string
  /** Single-line plain prose. */
  content: string
  /** `YYYY-MM-DD HH:MM` local time. */
  timestamp: string
  relevance: Relevance
  /** Session event seqs that support this observation. */
  sourceEventSeqs: number[]
  /** Estimated tokens of the rendered summary line. */
  tokenCount: number
}

/** A durable conclusion distilled from observations by the reflector. */
export type Reflection = {
  id: string
  content: string
  /** Evidence observation ids; downstream dropper coverage evidence. */
  supportingObservationIds: string[]
  tokenCount: number
}

/** Observer output plus its progress watermark. */
export type ObservationsRecordedRecord = {
  kind: 'observations-recorded'
  observations: Observation[]
  coversUpToSeq: number
}

/** Reflector output plus its progress watermark. */
export type ReflectionsRecordedRecord = {
  kind: 'reflections-recorded'
  reflections: Reflection[]
  coversUpToSeq: number
}

/** Dropper tombstones plus its progress watermark. */
export type ObservationsDroppedRecord = {
  kind: 'observations-dropped'
  observationIds: string[]
  coversUpToSeq: number
}

/**
 * Bookkeeping record written when a compaction lands memory-rendered visible
 * state: what the agent now sees, through which session seq the fold ran, and
 * whether the fold applied reflection/drop effects (full fold). The folded
 * arrays make later visible projections self-contained (the DSH port of
 * pi-observational-memory's `om.folded` compaction details).
 */
export type VisibleMemoryRecord = {
  kind: 'visible-memory'
  /** The exact rendered memory text the compaction made visible. */
  text: string
  /** Session seq the rendering folded memory through. */
  upToSeq: number
  fullFold: boolean
  compactionId?: string
  observations: Observation[]
  reflections: Reflection[]
}

export type LedgerEntry =
  | ObservationsRecordedRecord
  | ReflectionsRecordedRecord
  | ObservationsDroppedRecord
  | VisibleMemoryRecord

export type MemoryLedgerEntry = Exclude<LedgerEntry, VisibleMemoryRecord>

export function isRelevance(value: unknown): value is Relevance {
  return typeof value === 'string' && (RELEVANCE_VALUES as readonly string[]).includes(value)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)
}

export function isMemoryId(value: unknown): value is string {
  return typeof value === 'string' && MEMORY_ID_PATTERN.test(value)
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSeqArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(isSeq)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isObservation(value: unknown): value is Observation {
  if (!isPlainRecord(value)) return false
  return (
    isMemoryId(value.id) &&
    isNonEmptyString(value.content) &&
    isNonEmptyString(value.timestamp) &&
    isRelevance(value.relevance) &&
    isSeqArray(value.sourceEventSeqs) &&
    isTokenCount(value.tokenCount)
  )
}

export function isReflection(value: unknown): value is Reflection {
  if (!isPlainRecord(value)) return false
  return (
    isMemoryId(value.id) &&
    isNonEmptyString(value.content) &&
    !/\r|\n/.test(value.content) &&
    isNonEmptyStringArray(value.supportingObservationIds) &&
    isTokenCount(value.tokenCount)
  )
}

export function isObservationsRecordedRecord(value: unknown): value is ObservationsRecordedRecord {
  if (!isPlainRecord(value)) return false
  return (
    value.kind === 'observations-recorded' &&
    Array.isArray(value.observations) &&
    value.observations.length > 0 &&
    value.observations.every(isObservation) &&
    isSeq(value.coversUpToSeq)
  )
}

export function isReflectionsRecordedRecord(value: unknown): value is ReflectionsRecordedRecord {
  if (!isPlainRecord(value)) return false
  return (
    value.kind === 'reflections-recorded' &&
    Array.isArray(value.reflections) &&
    value.reflections.length > 0 &&
    value.reflections.every(isReflection) &&
    isSeq(value.coversUpToSeq)
  )
}

export function isObservationsDroppedRecord(value: unknown): value is ObservationsDroppedRecord {
  if (!isPlainRecord(value)) return false
  return (
    value.kind === 'observations-dropped' &&
    isNonEmptyStringArray(value.observationIds) &&
    isSeq(value.coversUpToSeq)
  )
}

export function isVisibleMemoryRecord(value: unknown): value is VisibleMemoryRecord {
  if (!isPlainRecord(value)) return false
  return (
    value.kind === 'visible-memory' &&
    typeof value.text === 'string' &&
    isSeq(value.upToSeq) &&
    typeof value.fullFold === 'boolean' &&
    (value.compactionId === undefined || typeof value.compactionId === 'string') &&
    Array.isArray(value.observations) &&
    value.observations.every(isObservation) &&
    Array.isArray(value.reflections) &&
    value.reflections.every(isReflection)
  )
}

export function isLedgerEntry(value: unknown): value is LedgerEntry {
  return (
    isObservationsRecordedRecord(value) ||
    isReflectionsRecordedRecord(value) ||
    isObservationsDroppedRecord(value) ||
    isVisibleMemoryRecord(value)
  )
}

/** Build an observer record; empty observation batches never enter the ledger. */
export function buildObservationsRecorded(
  observations: Observation[],
  coversUpToSeq: number,
): ObservationsRecordedRecord | undefined {
  if (observations.length === 0 || !isSeq(coversUpToSeq)) return undefined
  return { kind: 'observations-recorded', observations, coversUpToSeq }
}

export function buildReflectionsRecorded(
  reflections: Reflection[],
  coversUpToSeq: number,
): ReflectionsRecordedRecord | undefined {
  if (reflections.length === 0 || !isSeq(coversUpToSeq)) return undefined
  return { kind: 'reflections-recorded', reflections, coversUpToSeq }
}

export function buildObservationsDropped(
  observationIds: string[],
  coversUpToSeq: number,
): ObservationsDroppedRecord | undefined {
  if (observationIds.length === 0 || !isSeq(coversUpToSeq)) return undefined
  return { kind: 'observations-dropped', observationIds, coversUpToSeq }
}
