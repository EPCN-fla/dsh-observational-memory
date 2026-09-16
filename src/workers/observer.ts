/**
 * The observer: compresses a chunk of recent conversation into timestamped,
 * rated observations through the `record_observations` tool. Code owns
 * deterministic ids, source-seq validation, and per-observation token counts;
 * the model owns judgment.
 */
import type { Context } from '@deepseek-ai/cordis'
import { hashId } from '../ids.ts'
import { nowTimestamp, truncateRecordContent } from '../serialize.ts'
import { observationLineTokenCount } from '../tokens.ts'
import { isRelevance, type Observation, type Relevance } from '../ledger/types.ts'
import { runWorkerLoop, type WorkerTool } from './loop.ts'
import { OBSERVER_SYSTEM } from './prompts.ts'

export interface WorkerModelTarget {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

export interface RunObserverOptions {
  target: WorkerModelTarget
  priorReflections: string[]
  priorObservations: string[]
  chunk: string
  allowedSourceEventSeqs: number[]
  maxTurns: number
  signal?: AbortSignal
}

export const OBSERVATION_TIMESTAMP_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$'

const RECORD_OBSERVATIONS_SCHEMA = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      description: 'Batch of new observations. May be empty only if the tool is not called at all.',
      items: {
        type: 'object',
        properties: {
          timestamp: {
            type: 'string',
            pattern: OBSERVATION_TIMESTAMP_PATTERN,
            description: "Observation time in local 'YYYY-MM-DD HH:MM' format.",
          },
          content: {
            type: 'string',
            minLength: 1,
            description: 'Single-line plain prose. No markdown, no tags, no embedded timestamp.',
          },
          relevance: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          sourceEventSeqs: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 1,
            description:
              'Exact source event seqs from the chunk that directly support this observation. ' +
              "Use only seqs shown in '[Source event seq: ...]' labels; never invent seqs.",
          },
        },
        required: ['timestamp', 'content', 'relevance', 'sourceEventSeqs'],
        additionalProperties: false,
      },
    },
  },
  required: ['observations'],
  additionalProperties: false,
}

type ProposedObservation = {
  timestamp?: unknown
  content?: unknown
  relevance?: unknown
  sourceEventSeqs?: unknown
}

/**
 * Keep only seqs the chunk actually carried, deduplicated and sorted into
 * chunk order. Returns undefined when any cited seq is foreign or none remain.
 */
export function normalizeSourceEventSeqs(
  sourceEventSeqs: readonly unknown[] | undefined,
  allowedSourceEventSeqs: readonly number[],
): number[] | undefined {
  if (!sourceEventSeqs || sourceEventSeqs.length === 0) return undefined
  const allowedOrder = new Map<number, number>()
  for (let i = 0; i < allowedSourceEventSeqs.length; i++) allowedOrder.set(allowedSourceEventSeqs[i], i)

  const seen = new Set<number>()
  for (const seq of sourceEventSeqs) {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined
    if (!allowedOrder.has(seq)) return undefined
    seen.add(seq)
  }
  if (seen.size === 0) return undefined
  return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0))
}

function joinOrEmpty(items: string[]): string {
  return items.length ? items.join('\n') : '(none yet)'
}

export async function runObserver(ctx: Context, options: RunObserverOptions): Promise<Observation[] | undefined> {
  const conversation = options.chunk.trim()
  if (!conversation) return undefined

  const accumulated = new Map<string, Observation>()

  const recordObservations: WorkerTool = {
    schema: {
      name: 'record_observations',
      description:
        'Record a batch of new observations distilled from the conversation chunk. ' +
        'Call this multiple times as you work through the chunk. Stop calling when coverage is complete, ' +
        'then emit a short plain-text confirmation to end the run.',
      parameters: RECORD_OBSERVATIONS_SCHEMA,
    },
    execute(args: unknown): string {
      const proposals = (args as { observations?: ProposedObservation[] } | undefined)?.observations
      let added = 0
      let duplicates = 0
      let rejected = 0
      for (const proposal of Array.isArray(proposals) ? proposals : []) {
        const sourceEventSeqs = normalizeSourceEventSeqs(
          proposal.sourceEventSeqs as unknown[] | undefined,
          options.allowedSourceEventSeqs,
        )
        const content = typeof proposal.content === 'string' ? truncateRecordContent(proposal.content) : undefined
        const timestamp = typeof proposal.timestamp === 'string' ? proposal.timestamp : undefined
        const relevance: Relevance | undefined = isRelevance(proposal.relevance) ? proposal.relevance : undefined
        if (!sourceEventSeqs || !content || !timestamp || !relevance) {
          rejected++
          continue
        }
        const id = hashId(content)
        if (accumulated.has(id)) {
          duplicates++
          continue
        }
        accumulated.set(id, {
          id,
          content,
          timestamp,
          relevance,
          sourceEventSeqs,
          tokenCount: observationLineTokenCount({ id, timestamp, relevance, content }),
        })
        added++
      }
      const rejectedPart =
        rejected > 0 ? ` ${rejected} observation${rejected === 1 ? '' : 's'} rejected for missing or invalid fields/sourceEventSeqs.` : ''
      return (
        `Recorded ${added} new observation${added === 1 ? '' : 's'} ` +
        (duplicates > 0 ? `(${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped).` : '.') +
        rejectedPart +
        ` Total so far this run: ${accumulated.size}. ` +
        `Continue if the chunk still has uncovered content; otherwise stop calling the tool and emit a short plain-text confirmation.`
      )
    },
  }

  const now = nowTimestamp()
  const userText = `Current local time: ${now}

CURRENT REFLECTIONS:
${joinOrEmpty(options.priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(options.priorObservations)}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.

NEW CONVERSATION CHUNK:
${conversation}`

  await runWorkerLoop(ctx, {
    provider: options.target.provider,
    model: options.target.model,
    system: OBSERVER_SYSTEM,
    userText,
    tools: [recordObservations],
    maxTurns: options.maxTurns,
    ...(options.target.maxTokens !== undefined ? { maxTokens: options.target.maxTokens } : {}),
    ...(options.target.reasoningEffort !== undefined ? { reasoningEffort: options.target.reasoningEffort } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })

  if (accumulated.size === 0) return undefined
  return Array.from(accumulated.values())
}
