/**
 * The reflector: distills durable, long-lived reflections from active
 * observations through the `record_reflections` tool. Support ids are
 * validated against the active observation pool; coverage tiers annotate the
 * input as review context, never as a quota.
 */
import type { Context } from '@deepseek-ai/cordis'
import { hashId } from '../ids.ts'
import { truncateRecordContent } from '../serialize.ts'
import { estimateStringTokens } from '../tokens.ts'
import { reflectionToSummaryLine, type Observation, type Reflection } from '../ledger/index.ts'
import { coverageTierForObservation, observationToCoverageLine, reflectionCoverageMap } from './coverage.ts'
import { runWorkerLoop, type WorkerTool } from './loop.ts'
import { REFLECTOR_SYSTEM } from './prompts.ts'
import type { WorkerModelTarget } from './observer.ts'

export interface RunReflectorOptions {
  target: WorkerModelTarget
  reflections: Reflection[]
  observations: Observation[]
  maxTurns: number
  signal?: AbortSignal
}

const RECORD_REFLECTIONS_SCHEMA = {
  type: 'object',
  properties: {
    reflections: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1 },
          supportingObservationIds: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
          },
        },
        required: ['content', 'supportingObservationIds'],
        additionalProperties: false,
      },
    },
  },
  required: ['reflections'],
  additionalProperties: false,
}

type ProposedReflection = {
  content?: unknown
  supportingObservationIds?: unknown
}

/** Keep only ids of currently active observations, deduped in pool order. */
export function normalizeSupportingObservationIds(
  supportingObservationIds: readonly unknown[] | undefined,
  allowedObservationIds: readonly string[],
): string[] | undefined {
  if (!supportingObservationIds || supportingObservationIds.length === 0) return undefined
  const allowedOrder = new Map<string, number>()
  for (let i = 0; i < allowedObservationIds.length; i++) {
    if (!allowedOrder.has(allowedObservationIds[i])) allowedOrder.set(allowedObservationIds[i], i)
  }

  const seen = new Set<string>()
  for (const id of supportingObservationIds) {
    if (typeof id !== 'string' || !allowedOrder.has(id)) return undefined
    seen.add(id)
  }
  if (seen.size === 0) return undefined
  return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0))
}

function normalizeReflectionContent(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined
  const normalized = truncateRecordContent(content.trim())
  if (!normalized || /\r|\n/.test(normalized)) return undefined
  return normalized
}

function joinOrEmpty(items: string[]): string {
  return items.length ? items.join('\n') : '(none yet)'
}

export async function runReflector(ctx: Context, options: RunReflectorOptions): Promise<Reflection[] | undefined> {
  const { reflections, observations } = options
  if (observations.length === 0) return undefined

  const coverageById = reflectionCoverageMap(observations, reflections)
  const allowedObservationIds = observations.map((observation) => observation.id)
  const existingReflectionIds = new Set(reflections.map((reflection) => reflection.id))
  const accumulated = new Map<string, Reflection>()

  const recordReflections: WorkerTool = {
    schema: {
      name: 'record_reflections',
      description: 'Record new durable reflections with supporting observation ids.',
      parameters: RECORD_REFLECTIONS_SCHEMA,
    },
    execute(args: unknown): string {
      const proposals = (args as { reflections?: ProposedReflection[] } | undefined)?.reflections
      let added = 0
      let duplicates = 0
      let rejected = 0
      for (const proposal of Array.isArray(proposals) ? proposals : []) {
        const content = normalizeReflectionContent(proposal.content)
        const supportingObservationIds = normalizeSupportingObservationIds(
          proposal.supportingObservationIds as unknown[] | undefined,
          allowedObservationIds,
        )
        if (!content || !supportingObservationIds) {
          rejected++
          continue
        }
        const id = hashId(content)
        if (existingReflectionIds.has(id) || accumulated.has(id)) {
          duplicates++
          continue
        }
        accumulated.set(id, {
          id,
          content,
          supportingObservationIds,
          tokenCount: estimateStringTokens(content),
        })
        added++
      }
      return `Recorded ${added} reflection${added === 1 ? '' : 's'}; ${duplicates} duplicate${duplicates === 1 ? '' : 's'}; ${rejected} rejected. Total this run: ${accumulated.size}.`
    },
  }

  const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nCURRENT OBSERVATIONS:\n${joinOrEmpty(
    observations.map((observation) =>
      observationToCoverageLine(observation, coverageTierForObservation(observation, coverageById)),
    ),
  )}\n\nCrystallize any missing durable facts or patterns into new reflections. If nothing is stable enough, do not call the tool.`

  await runWorkerLoop(ctx, {
    provider: options.target.provider,
    model: options.target.model,
    system: REFLECTOR_SYSTEM,
    userText,
    tools: [recordReflections],
    maxTurns: options.maxTurns,
    ...(options.target.maxTokens !== undefined ? { maxTokens: options.target.maxTokens } : {}),
    ...(options.target.reasoningEffort !== undefined ? { reasoningEffort: options.target.reasoningEffort } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })

  const accepted = Array.from(accumulated.values())
  return accepted.length > 0 ? accepted : undefined
}
