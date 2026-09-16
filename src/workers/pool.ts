/**
 * Active-observation pool accounting for dropper maintenance. Budgets count
 * the full rendered line (id + timestamp + relevance + content), matching
 * what future contexts actually carry.
 */
import { observationLineTokenCount } from '../tokens.ts'
import type { Observation } from '../ledger/types.ts'

export type ObservationPoolMetrics = {
  observationTokens: number
  targetTokens: number
  tokensOverTarget: number
  fullness: number
  activeObservationCount: number
  maxDropsAllowed: number
  overTarget: boolean
  ready: boolean
}

export function observationTokenSum(observations: readonly Observation[]): number {
  return observations.reduce((sum, observation) => sum + observationLineTokenCount(observation), 0)
}

/**
 * Convert tokens-over-target into an approximate drop count: a hard upper
 * bound sized to move the pool toward target if every proposed drop is safe.
 */
export function maxDropCountForPool(
  observations: readonly Observation[],
  observationTokens: number,
  targetTokens: number,
): number {
  const activeObservationCount = observations.length
  if (activeObservationCount === 0) return 0
  if (!Number.isFinite(observationTokens) || observationTokens <= 0) return 0
  if (!Number.isFinite(targetTokens) || targetTokens < 0) return 0

  const tokensOverTarget = observationTokens - targetTokens
  if (tokensOverTarget <= 0) return 0

  const averageObservationTokens = observationTokens / activeObservationCount
  if (!Number.isFinite(averageObservationTokens) || averageObservationTokens <= 0) return 0

  const estimatedDrops = Math.ceil(tokensOverTarget / averageObservationTokens)
  return Math.min(activeObservationCount, Math.max(1, estimatedDrops))
}

export function observationPoolMetrics(
  observations: readonly Observation[],
  targetTokens: number,
): ObservationPoolMetrics {
  const observationTokens = observationTokenSum(observations)
  const fullness =
    !Number.isFinite(observationTokens) || observationTokens <= 0 || !Number.isFinite(targetTokens) || targetTokens <= 0
      ? 0
      : observationTokens / targetTokens
  const activeObservationCount = observations.length
  const tokensOverTarget = Math.max(0, observationTokens - targetTokens)
  const maxDropsAllowed = maxDropCountForPool(observations, observationTokens, targetTokens)
  const overTarget = Number.isFinite(targetTokens) && targetTokens >= 0 && observationTokens > targetTokens
  return {
    observationTokens,
    targetTokens,
    tokensOverTarget,
    fullness,
    activeObservationCount,
    maxDropsAllowed,
    overTarget,
    ready: overTarget && maxDropsAllowed > 0,
  }
}
