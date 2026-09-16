/**
 * The dropper: post-reflection maintenance that prunes the active observation
 * pool toward its target. The model proposes safe drops through
 * `drop_observations`; code caps and ranks the candidates — reflection
 * coverage first, then relevance resistance, then age — so the model's
 * judgment stays bounded by deterministic evidence.
 */
import type { Context } from '@deepseek-ai/cordis'
import { reflectionToSummaryLine, type Observation, type Reflection } from '../ledger/index.ts'
import {
  coverageTierForObservation,
  observationToCoverageLine,
  REFLECTION_COVERAGE_DROP_RANK,
  reflectionCoverageMap,
} from './coverage.ts'
import { runWorkerLoop, type WorkerTool } from './loop.ts'
import { observationPoolMetrics } from './pool.ts'
import { DROPPER_SYSTEM } from './prompts.ts'
import type { WorkerModelTarget } from './observer.ts'

export interface RunDropperOptions {
  target: WorkerModelTarget
  reflections: Reflection[]
  observations: Observation[]
  targetTokens: number
  maxTurns: number
  signal?: AbortSignal
}

const RELEVANCE_DROP_RANK: Record<Observation['relevance'], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
}

const DROP_OBSERVATIONS_SCHEMA = {
  type: 'object',
  properties: {
    ids: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      description: 'Active observation ids that are safe to remove from compacted memory.',
    },
    reason: { type: 'string' },
  },
  required: ['ids'],
  additionalProperties: false,
}

function joinOrEmpty(items: string[]): string {
  return items.length ? items.join('\n') : '(none yet)'
}

/** Keep ids that name active observations, deduplicated, proposal order kept. */
export function normalizeDropObservationIds(
  ids: readonly unknown[] | undefined,
  observations: readonly Observation[],
): string[] | undefined {
  if (!ids || ids.length === 0) return undefined
  const allowed = new Map(observations.map((observation) => [observation.id, observation]))
  const result: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string') continue
    const observation = allowed.get(id)
    if (!observation) continue
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result.length > 0 ? result : undefined
}

function timestampRank(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

/**
 * Deterministically pick the final drop set from the model's proposals:
 * strongest reflection coverage first, then lowest relevance resistance, then
 * oldest, then earliest proposal — capped at `maxDrops`.
 */
export function selectDropCandidates(
  ids: readonly string[],
  observations: readonly Observation[],
  maxDrops: number,
  reflections: readonly Reflection[] = [],
): string[] {
  if (maxDrops <= 0 || ids.length === 0) return []

  const byId = new Map(observations.map((observation) => [observation.id, observation]))
  const coverageById = reflectionCoverageMap(observations, reflections)
  const firstProposalIndex = new Map<string, number>()
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    if (!firstProposalIndex.has(id)) firstProposalIndex.set(id, i)
  }

  return Array.from(firstProposalIndex.entries())
    .map(([id, index]) => ({ id, index, observation: byId.get(id) }))
    .filter((candidate): candidate is { id: string; index: number; observation: Observation } => candidate.observation !== undefined)
    .sort((a, b) => {
      const coverageDelta =
        REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverageById)] -
        REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverageById)]
      const relevanceDelta = RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance]
      const ageDelta = timestampRank(a.observation.timestamp) - timestampRank(b.observation.timestamp)
      return coverageDelta || relevanceDelta || ageDelta || a.index - b.index
    })
    .slice(0, maxDrops)
    .map((candidate) => candidate.id)
}

export async function runDropper(ctx: Context, options: RunDropperOptions): Promise<string[] | undefined> {
  const { reflections, observations, targetTokens } = options
  if (observations.length === 0) return undefined

  const metrics = observationPoolMetrics(observations, targetTokens)
  const { observationTokens, fullness, tokensOverTarget, maxDropsAllowed } = metrics
  if (maxDropsAllowed <= 0) return undefined

  const coverageById = reflectionCoverageMap(observations, reflections)
  const proposedDropIds: string[] = []
  const proposed = new Set<string>()
  const allowed = new Set(observations.map((observation) => observation.id))

  const dropObservations: WorkerTool = {
    schema: {
      name: 'drop_observations',
      description: 'Propose active observation ids that are safe to remove from compacted memory.',
      parameters: DROP_OBSERVATIONS_SCHEMA,
    },
    execute(args: unknown): string {
      const ids = (args as { ids?: unknown[] } | undefined)?.ids
      let added = 0
      for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id !== 'string') continue
        if (!allowed.has(id)) continue
        if (proposed.has(id)) continue
        proposed.add(id)
        proposedDropIds.push(id)
        added++
      }
      return `Queued ${added} drop candidate${added === 1 ? '' : 's'}. Candidates this run: ${proposedDropIds.length}. Maximum drops allowed: ${maxDropsAllowed}.`
    },
  }

  const fullnessPercent = Math.round(fullness * 100)
  const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nCURRENT OBSERVATIONS:\n${joinOrEmpty(
    observations.map((observation) =>
      observationToCoverageLine(observation, coverageTierForObservation(observation, coverageById)),
    ),
  )}\n\nActive observation pool: ~${observationTokens.toLocaleString()} tokens; target: ~${targetTokens.toLocaleString()} tokens; fullness against target: ~${fullnessPercent.toLocaleString()}%; over target by ~${tokensOverTarget.toLocaleString()} tokens.\nMaximum drops allowed this run: ${maxDropsAllowed.toLocaleString()} observation${maxDropsAllowed === 1 ? '' : 's'}. This maximum is sized to move the active pool toward the target if every proposed drop is clearly safe.\nThis maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.`

  await runWorkerLoop(ctx, {
    provider: options.target.provider,
    model: options.target.model,
    system: DROPPER_SYSTEM,
    userText,
    tools: [dropObservations],
    maxTurns: options.maxTurns,
    ...(options.target.maxTokens !== undefined ? { maxTokens: options.target.maxTokens } : {}),
    ...(options.target.reasoningEffort !== undefined ? { reasoningEffort: options.target.reasoningEffort } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })

  const droppedIds = selectDropCandidates(proposedDropIds, observations, maxDropsAllowed, reflections)
  return droppedIds.length > 0 ? droppedIds : undefined
}
