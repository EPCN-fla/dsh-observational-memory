/**
 * Progress clocks: how much unprocessed source text each memory worker has.
 *
 * Watermarks are session event seqs carried on ledger records
 * (`coversUpToSeq`). A worker's raw progress is the estimated token count of
 * source events with `seq` greater than its latest watermark. Ledger records
 * themselves are not session events and never add progress.
 */
import { estimateEventsTokens, isSourceEvent, type EventView } from '../serialize.ts'
import type { LedgerEntry } from './types.ts'

type MemoryKind = 'observations-recorded' | 'reflections-recorded' | 'observations-dropped'

/** Latest progress watermark for one ledger record kind, or -1 when uncovered. */
export function latestCoverageSeq(entries: readonly LedgerEntry[], kind: MemoryKind): number {
  let latest = -1
  for (const entry of entries) {
    if (entry.kind !== kind) continue
    if (entry.coversUpToSeq > latest) latest = entry.coversUpToSeq
  }
  return latest
}

/** Estimated source tokens after `seq` (pass -1 to count from the log start). */
export function rawTokensAfterSeq(events: readonly EventView[], seq: number): number {
  // Keep non-source events in the range: they carry the tool-call names used
  // in tool-result labels; the estimator only counts source-event content.
  return estimateEventsTokens(events.filter((event) => event.seq > seq))
}

export function rawTokensSinceCoverage(
  events: readonly EventView[],
  entries: readonly LedgerEntry[],
  kind: MemoryKind,
): number {
  return rawTokensAfterSeq(events, latestCoverageSeq(entries, kind))
}

export function rawTokensSinceObservationCoverage(
  events: readonly EventView[],
  entries: readonly LedgerEntry[],
): number {
  return rawTokensSinceCoverage(events, entries, 'observations-recorded')
}

export function rawTokensSinceReflectionCoverage(
  events: readonly EventView[],
  entries: readonly LedgerEntry[],
): number {
  return rawTokensSinceCoverage(events, entries, 'reflections-recorded')
}

/** Events after `seq`, oldest first, non-source events kept for tool-name resolution. */
export function eventsAfter(events: readonly EventView[], seq: number): EventView[] {
  return events.filter((event) => event.seq > seq)
}

/** Source events after `seq`, oldest first, with non-source events dropped. */
export function sourceEventsAfter(events: readonly EventView[], seq: number): EventView[] {
  return events.filter((event) => event.seq > seq && isSourceEvent(event))
}

/** The smaller (earlier) of two coverage watermarks; undefined propagates. */
export function earlierSeq(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  return first <= second ? first : second
}
