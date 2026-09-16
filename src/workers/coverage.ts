/**
 * Reflection coverage: how many current reflections cite each observation.
 * Coverage tiers annotate reflector and dropper input as review context —
 * never as an automatic reflect/drop rule.
 */
import type { Observation, Reflection } from '../ledger/types.ts'

export const REFLECTION_COVERAGE_TIERS = ['none', 'partial', 'strong'] as const
export type ReflectionCoverageTier = (typeof REFLECTION_COVERAGE_TIERS)[number]

/** Drop-candidate ordering rank: better-covered observations drop first. */
export const REFLECTION_COVERAGE_DROP_RANK: Record<ReflectionCoverageTier, number> = {
  strong: 0,
  partial: 1,
  none: 2,
}

/** How many reflections cite each observation id. */
export function reflectionSupportCounts(reflections: readonly Reflection[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const reflection of reflections) {
    const uniqueIds = new Set(reflection.supportingObservationIds)
    for (const id of uniqueIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

export function reflectionCoverageTierForCount(count: number): ReflectionCoverageTier {
  if (count <= 0) return 'none'
  if (count === 1) return 'partial'
  return 'strong'
}

export function reflectionCoverageMap(
  observations: readonly Observation[],
  reflections: readonly Reflection[],
): Map<string, ReflectionCoverageTier> {
  const counts = reflectionSupportCounts(reflections)
  return new Map(
    observations.map((observation) => [
      observation.id,
      reflectionCoverageTierForCount(counts.get(observation.id) ?? 0),
    ]),
  )
}

export function coverageTierForObservation(
  observation: Observation,
  coverageById: ReadonlyMap<string, ReflectionCoverageTier>,
): ReflectionCoverageTier {
  return coverageById.get(observation.id) ?? 'none'
}

/** Observation line with a coverage annotation, for reflector/dropper input. */
export function observationToCoverageLine(
  observation: Observation,
  coverage: ReflectionCoverageTier,
): string {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`
}
