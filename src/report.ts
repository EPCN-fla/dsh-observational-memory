/**
 * Human-facing memory reports, ported from pi-observational-memory's
 * `/om:status` and `/om:view` commands and adapted to DSH's separation of
 * domains: the ledger is plugin-owned, and compaction progress is measured
 * context pressure (the trigger's own domain) rather than raw source tokens.
 *
 * These builders are pure: the Remote service gathers the inputs, the Memory
 * tab renders the text. Lines stay English like pi's commands; the tab's
 * section chrome carries the locale.
 */
import { resolveCompactAfterTokens, resolveObservationsPoolTargetTokens, type ResolvedConfig } from './config.ts'
import {
  diffProjection,
  foldLedger,
  fullProjection,
  observationToSummaryLine,
  rawTokensSinceObservationCoverage,
  rawTokensSinceReflectionCoverage,
  reflectionToSummaryLine,
  visibleProjection,
  type LedgerEntry,
  type Projection,
} from './ledger/index.ts'
import { observationPoolMetrics } from './workers/pool.ts'
import type { EventView } from './serialize.ts'

function pct(current: number, total: number): number {
  return total > 0 ? Math.round((current / total) * 100) : 0
}

function tokenSum(items: readonly { tokenCount: number }[]): number {
  return items.reduce((sum, item) => sum + item.tokenCount, 0)
}

function addedSuffix(count: number): string | undefined {
  return count > 0 ? `+${count.toLocaleString()}` : undefined
}

function removedSuffix(count: number): string | undefined {
  return count > 0 ? `-${count.toLocaleString()}` : undefined
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
  const rendered = suffixes.filter((suffix): suffix is string => suffix !== undefined)
  return rendered.length > 0 ? `${line} ${rendered.join(' ')}` : line
}

/** Inputs the status report cannot derive from the ledger alone. */
export interface StatusContext {
  config: ResolvedConfig
  /** Session model's context window, when resolvable (ratio-mode threshold). */
  contextWindow: number | undefined
  /**
   * Measured context pressure from the token meter — the same quantity the
   * proactive trigger compares against the threshold. Undefined when the
   * meter is unavailable.
   */
  measuredTokens: number | undefined
  consolidationInFlight: boolean
  compactionInFlight: boolean
  lastObserverError: string | undefined
  lastReflectorError: string | undefined
  lastDropperError: string | undefined
}

/** `/om:status`: memory inventory, worker progress, in-flight runs, errors. */
export function buildStatusText(
  entries: readonly LedgerEntry[],
  events: readonly EventView[],
  status: StatusContext,
): string {
  const { config } = status
  const folded = foldLedger(entries)
  const visible = visibleProjection(entries)
  const full = fullProjection(entries)
  const drift = diffProjection(visible, full)

  const visibleObservationTokens = tokenSum(visible.observations)
  const visibleReflectionTokens = tokenSum(visible.reflections)
  const targetTokens = resolveObservationsPoolTargetTokens(config)
  const activeObservationPool = observationPoolMetrics(folded.activeObservations, targetTokens)
  const observationLine = appendSuffixes(
    `Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
    [addedSuffix(drift.observationsOnlyInFull.length), removedSuffix(drift.droppedOnlyInFull.length)],
  )
  const reflectionLine = appendSuffixes(
    `Reflections:  ${folded.reflections.length} recorded / ${visible.reflections.length} visible`,
    [addedSuffix(drift.reflectionsOnlyInFull.length)],
  )

  const obsProgress = rawTokensSinceObservationCoverage(events, entries)
  const reflectionProgress = rawTokensSinceReflectionCoverage(events, entries)
  const compactThreshold = resolveCompactAfterTokens(config, status.contextWindow)
  const ratioResolved =
    status.contextWindow !== undefined
    && status.contextWindow > 0
    && config.compactAfterTokensRatio > 0
    && config.compactAfterTokensRatio < 1
  const thresholdNote =
    config.compactAfterTokensMode === 'ratio'
      ? ratioResolved
        ? ` (ratio ${config.compactAfterTokensRatio} × ${status.contextWindow?.toLocaleString()})`
        : ' (ratio mode, window or ratio unusable — trigger disabled)'
      : ''

  const compactionLine =
    compactThreshold <= 0
      ? `Next compaction:  proactive trigger disabled; DSH native compaction policy drives${thresholdNote}`
      : status.measuredTokens === undefined
        ? `Next compaction:  threshold ${compactThreshold.toLocaleString()} estimated tokens${thresholdNote} (context meter unavailable)`
        : `Next compaction:  ~${status.measuredTokens.toLocaleString()} / ${compactThreshold.toLocaleString()} estimated tokens (${pct(status.measuredTokens, compactThreshold)}%)${thresholdNote}`

  const passiveLines =
    config.passive === true
      ? [
        '── Mode ──',
        'Passive: automatic memory workers and auto-compaction disabled; manual/DSH compaction and recall remain active',
        '',
      ]
      : []

  const lines = [
    ...passiveLines,
    '── Memory ──',
    observationLine,
    reflectionLine,
    '',
    '── Activity ──',
    `Next observation: ~${obsProgress.toLocaleString()} / ${config.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, config.observeAfterTokens)}%)`,
    `Next reflection:  ~${reflectionProgress.toLocaleString()} / ${config.reflectAfterTokens.toLocaleString()} tokens (${pct(reflectionProgress, config.reflectAfterTokens)}%)`,
    compactionLine,
    `Visible observation pool: ~${visibleObservationTokens.toLocaleString()} / ${config.observationsPoolMaxTokens.toLocaleString()} tokens (${pct(visibleObservationTokens, config.observationsPoolMaxTokens)}%)`,
    `Active observation pool: ~${activeObservationPool.observationTokens.toLocaleString()} / ${targetTokens.toLocaleString()} target tokens (${pct(activeObservationPool.observationTokens, targetTokens)}%)`,
    `Reflection pool:         ~${visibleReflectionTokens.toLocaleString()} tokens`,
  ]

  if (status.consolidationInFlight || status.compactionInFlight) {
    lines.push('', '── In flight ──')
    if (status.consolidationInFlight) lines.push('Consolidation: running')
    if (status.compactionInFlight) lines.push('Auto-compaction: running')
  }

  if (status.lastObserverError || status.lastReflectorError || status.lastDropperError) {
    lines.push('', '── Last error ──')
    if (status.lastObserverError) lines.push(`Observer: ${status.lastObserverError}`)
    if (status.lastReflectorError) lines.push(`Reflector: ${status.lastReflectorError}`)
    if (status.lastDropperError) lines.push(`Dropper: ${status.lastDropperError}`)
  }

  return lines.join('\n')
}

export type ViewMode = 'visible' | 'full'

function renderList<T>(items: readonly T[], render: (item: T) => string, empty: string): string {
  return items.length > 0 ? items.map(render).join('\n') : empty
}

/** `/om:view`: memory content lines — visible by default, full for recorded. */
export function buildViewText(entries: readonly LedgerEntry[], mode: ViewMode): string {
  const projection: Projection = mode === 'full' ? fullProjection(entries) : visibleProjection(entries)
  const emptyScope = mode === 'full' ? 'recorded' : 'visible'
  return [
    '── Reflections ──',
    renderList(projection.reflections, reflectionToSummaryLine, `No ${emptyScope} reflections.`),
    '',
    '── Observations ──',
    renderList(projection.observations, observationToSummaryLine, `No ${emptyScope} observations.`),
  ].join('\n')
}
