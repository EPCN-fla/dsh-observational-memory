/**
 * The `recall` agent tool: recover exact source evidence behind a compacted
 * memory id (observation or reflection) in the current session. Exact lookup,
 * not search — the model cites a 12-character id it saw in rendered memory.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { recallMemorySources, type RecallResult } from '../ledger/index.ts'
import { renderRecallSourceEvents, toolNameByCallId } from '../serialize.ts'
import type { OmRuntime } from '../runtime.ts'

const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/
/** Maximum evidence characters per model-visible recall page. */
export const RECALL_PAGE_CHARS = 50_000

export function recallPage(text: string, offset = 0): string {
  const end = Math.min(text.length, offset + RECALL_PAGE_CHARS)
  const page = text.slice(offset, end)
  if (end >= text.length) return page
  return `${page}\n\n[Recall output truncated at character ${end} of ${text.length}. Call recall again with the same id and offset ${end} for the next page.]`
}

function renderFound(result: Extract<RecallResult, { status: 'found' }>, toolNames: ReadonlyMap<string, string>): string {
  const sections: string[] = []
  if (result.collision) {
    sections.push(`Memory id ${result.memoryId} matched multiple observations/reflections; returning all available evidence from the current session.`)
  }
  if (result.reflections.length > 0) {
    sections.push(`Reflections:\n${result.reflections.map((match) => `[${match.reflection.id}] ${match.reflection.content}`).join('\n')}`)
  }
  if (result.observations.length > 0) {
    sections.push(
      `Observations:\n${result.observations
        .map((match) => {
          const status = match.status === 'dropped' ? ' [dropped]' : ''
          return `[${match.observation.id}]${status} ${match.observation.timestamp} [${match.observation.relevance}] ${match.observation.content}`
        })
        .join('\n')}`,
    )
  }
  if (result.missingSupportingObservationIds.length > 0) {
    sections.push(
      `Unavailable supporting observations:\n${result.missingSupportingObservationIds
        .map((id) => `Supporting observation ${id} is unavailable in this session's memory.`)
        .join('\n')}`,
    )
  }
  if (result.missingSourceEventSeqs.length > 0 || result.nonSourceEventSeqs.length > 0) {
    const parts: string[] = []
    if (result.missingSourceEventSeqs.length > 0) parts.push(`missing: ${result.missingSourceEventSeqs.join(', ')}`)
    if (result.nonSourceEventSeqs.length > 0) parts.push(`non-source: ${result.nonSourceEventSeqs.join(', ')}`)
    sections.push(`Unavailable source events: ${parts.join('; ')}`)
  }
  const sourceText = renderRecallSourceEvents(result.sourceEvents, toolNames)
  if (sourceText.trim()) sections.push(`Sources:\n${sourceText}`)
  if (sections.length === 0) sections.push(`Memory ${result.memoryId} was found, but no source evidence rendered.`)
  return sections.join('\n\n')
}

export function registerRecallTool(ctx: Context, runtime: OmRuntime): void {
  ctx.tools.register(
    defineTool({
      name: 'recall',
      description:
        'Recover exact evidence and source context behind a compacted observational-memory observation or reflection id in the current session. ' +
        'Use when compressed memory is important and original source context is needed before acting.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description:
            '12-character lowercase hex observation or reflection id shown in compacted memory or a previous recall result. Must be a specific id; this tool does not search by topic.',
        },
        offset: {
          type: 'number',
          description: `Zero-based character offset for continuation when a previous result was truncated. Each page is at most ${RECALL_PAGE_CHARS} source characters.`,
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const memoryId = args.id
        const offset = args.offset ?? 0
        if (!Number.isSafeInteger(offset) || offset < 0) return 'Recall offset must be a non-negative safe integer.'
        if (!MEMORY_ID_PATTERN.test(memoryId)) {
          return 'Memory id must be exactly 12 lowercase hex characters.'
        }
        const agent = exec.agent
        if (!agent) return 'recall is unavailable outside an agent session.'
        const sessionId: string = agent.session.id
        const events = agent.session.snapshotEvents()
        await runtime.ensureInherited(ctx, agent.session)
        const entries = await runtime.store.load(sessionId)
        const result = recallMemorySources(entries, events, memoryId)
        if (result.status === 'not_found') {
          return `No observation or reflection with id ${memoryId} was found in this session's memory.`
        }
        const rendered = renderFound(result, toolNameByCallId(events))
        if (offset >= rendered.length && offset > 0) return `Recall offset ${offset} is beyond the ${rendered.length}-character result.`
        return recallPage(rendered, offset)
      },
    }),
  )
}
