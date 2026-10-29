/**
 * Serialization of DSH session events into observer/recall text.
 *
 * `EventView` is a structural subset of `SessionEvent` so the memory core
 * stays free of runtime imports and is unit-testable with plain fixtures.
 * Source events are the model-visible conversation record: `user/message`,
 * `assistant/message`, and `tool/result` (the compaction checkpoint summary
 * rides a `user/message`, so compacted history stays observable).
 */
import { estimateStringTokens } from './tokens.ts'

export type EventView = {
  /** Monotonic session sequence number — the source address of this event. */
  seq: number
  type: string
  /** Unix epoch milliseconds. */
  time?: number
  data?: unknown
}

const SOURCE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

export function isSourceEvent(event: EventView): boolean {
  return SOURCE_EVENT_TYPES.has(event.type)
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatTimestamp(v: number | string | undefined): string {
  if (v === undefined) return '????-??-?? ??:??'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '????-??-?? ??:??' : fmtLocal(d)
}

export function nowTimestamp(): string {
  return fmtLocal(new Date())
}

// ---------------------------------------------------------------------------
// Content rendering
// ---------------------------------------------------------------------------

type ContentBlockView = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }

function contentBlocks(content: unknown): ContentBlockView[] {
  return Array.isArray(content) ? (content as ContentBlockView[]) : []
}

/**
 * Render message content to text with placeholders for non-text blocks.
 * Reasoning renders as `[thinking: …]` so the observer sees the assistant's
 * stated rationale; images/files collapse to placeholders.
 */
function textAndPlaceholders(content: unknown, options: { includeThinking?: boolean } = {}): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return '[non-text content omitted]'

  const parts: string[] = []
  for (const block of contentBlocks(content)) {
    if (!block || typeof block !== 'object') {
      parts.push('[non-text content omitted]')
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'reasoning') {
      if (options.includeThinking && typeof block.text === 'string') {
        parts.push(`[thinking: ${block.text}]`)
        continue
      }
      parts.push('[non-text content omitted]')
      continue
    }
    if (block.type === 'tool-call' && typeof block.name === 'string') {
      parts.push(`[${block.name}(${typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})})]`)
      continue
    }
    parts.push('[non-text content omitted]')
  }
  return parts.join('\n')
}

function textOnly(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return contentBlocks(content)
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/** The message payload embedded in a source event, when present. */
function eventMessage(event: EventView): { content?: unknown; source?: unknown } | undefined {
  if (event.type === 'user/message') return (event.data ?? undefined) as { content?: unknown } | undefined
  if (event.type === 'assistant/message' || event.type === 'tool/result') {
    const data = event.data as { message?: unknown } | undefined
    return data?.message as { content?: unknown } | undefined
  }
  return undefined
}

/** Tool call id carried by a tool/result event. */
function toolCallIdOf(event: EventView): string | undefined {
  const message = eventMessage(event) as
    | { toolCallId?: unknown; source?: { callId?: unknown } }
    | undefined
  // DSH ≥0.1.7 carries the id on the tool-role message itself (and mirrors it
  // at source.callId); 0.1.5's user-role tool result only has source.callId.
  if (typeof message?.toolCallId === 'string') return message.toolCallId
  const callId = message?.source?.callId
  return typeof callId === 'string' ? callId : undefined
}

/** callId → tool name index from `tool/call` events, for tool-result labels. */
export function toolNameByCallId(events: readonly EventView[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { callId?: unknown; name?: unknown } | undefined
    if (typeof data?.callId === 'string' && typeof data.name === 'string') names.set(data.callId, data.name)
  }
  return names
}

function renderSourceEvent(event: EventView, toolNames: ReadonlyMap<string, string>): string | null {
  const time = formatTimestamp(event.time)
  const message = eventMessage(event)
  if (event.type === 'user/message') {
    const text = textOnly(message?.content)
    return `[User @ ${time}]: ${text}`
  }
  if (event.type === 'assistant/message') {
    const body = textAndPlaceholders(message?.content, { includeThinking: true })
      .split('\n')
      .filter(Boolean)
      .join('\n')
    if (!body) return null
    return `[Assistant @ ${time}]: ${body}`
  }
  if (event.type === 'tool/result') {
    const callId = toolCallIdOf(event)
    const name = callId === undefined ? undefined : toolNames.get(callId)
    const label = name === undefined ? `Tool result @ ${time}` : `Tool result for ${name} @ ${time}`
    // The message content is a single ToolResultBlock; unwrap its payload.
    const outer = message?.content
    const resultBlock = Array.isArray(outer) ? (outer[0] as { content?: unknown } | undefined) : undefined
    return `[${label}]: ${textAndPlaceholders(resultBlock?.content ?? outer)}`
  }
  return null
}

/** Render source events as conversation text (no source labels). */
export function serializeSourceEvents(events: readonly EventView[]): string {
  const toolNames = toolNameByCallId(events)
  return events
    .map((event) => (isSourceEvent(event) ? renderSourceEvent(event, toolNames) : null))
    .filter((block): block is string => block !== null && block.trim().length > 0)
    .join('\n\n')
}

/** Estimated rendered-token footprint of one source event. */
export function estimateEventTokens(event: EventView): number {
  if (!isSourceEvent(event)) return 0
  const rendered = renderSourceEvent(event, toolNameByCallId([]))
  return rendered === null ? 0 : estimateStringTokens(rendered)
}

/**
 * Estimated tokens of the source events in `events`, with tool-result labels
 * resolved against the same range's `tool/call` events (one pass).
 */
export function estimateEventsTokens(events: readonly EventView[]): number {
  const toolNames = toolNameByCallId(events)
  let total = 0
  for (const event of events) {
    if (!isSourceEvent(event)) continue
    const rendered = renderSourceEvent(event, toolNames)
    if (rendered !== null) total += estimateStringTokens(rendered)
  }
  return total
}

// ---------------------------------------------------------------------------
// Source-addressed serialization (observer chunks)
// ---------------------------------------------------------------------------

export type SourceAddressedSerialization = {
  text: string
  sourceEventSeqs: number[]
  estimatedTokens: number
}

export type SourceAddressedSerializationOptions = {
  /** Maximum estimated tokens in the final source-addressed text. */
  maxTokens?: number
}

/**
 * Lossless observer chunks. Ordinary events are grouped up to the budget;
 * one oversized event is split into ordered excerpts instead of dropping its
 * middle. Callers must process every returned chunk before advancing coverage.
 */
export function serializeSourceAddressedEventChunks(
  events: readonly EventView[],
  options: SourceAddressedSerializationOptions = {},
): SourceAddressedSerialization[] {
  const toolNames = toolNameByCallId(events)
  const maxTokens = options.maxTokens
  const chunks: SourceAddressedSerialization[] = []
  let blocks: string[] = []
  let sourceEventSeqs: number[] = []
  let estimatedTokens = 0

  const flush = (): void => {
    if (blocks.length === 0) return
    const text = blocks.join('\n\n')
    chunks.push({ text, sourceEventSeqs, estimatedTokens: estimateStringTokens(text) })
    blocks = []
    sourceEventSeqs = []
    estimatedTokens = 0
  }

  for (const event of events) {
    if (!isSourceEvent(event)) continue
    const rendered = renderSourceEvent(event, toolNames)
    if (!rendered || !rendered.trim()) continue
    const label = `[Source event seq: ${event.seq}]`
    const block = `${label}\n${rendered}`
    const separatorTokens = blocks.length > 0 ? estimateStringTokens('\n\n') : 0
    const blockTokens = estimateStringTokens(block)

    if (maxTokens !== undefined && blockTokens > maxTokens) {
      flush()
      // The label and part marker consume budget too. Config's minimum is far
      // above this bound; reject pathological direct callers rather than
      // silently returning an over-budget or empty chunk.
      let offset = 0
      let part = 0
      while (offset < rendered.length) {
        part += 1
        const partLabel = `[Source event seq: ${event.seq}; part ${part}]`
        const prefixTokens = estimateStringTokens(`${partLabel}\n`)
        if (prefixTokens >= maxTokens) throw new RangeError(`observer chunk budget ${maxTokens} is too small for source labels`)
        const length = Math.max(1, (maxTokens - prefixTokens) * 4)
        const text = `${partLabel}\n${rendered.slice(offset, offset + length)}`
        if (estimateStringTokens(text) > maxTokens) throw new Error('observer chunk estimator exceeded its budget')
        chunks.push({ text, sourceEventSeqs: [event.seq], estimatedTokens: estimateStringTokens(text) })
        offset += length
      }
      continue
    }

    if (maxTokens !== undefined && estimatedTokens + separatorTokens + blockTokens > maxTokens) flush()
    const separator = blocks.length > 0 ? '\n\n' : ''
    blocks.push(`${separator}${block}`)
    sourceEventSeqs.push(event.seq)
    estimatedTokens += estimateStringTokens(`${separator}${block}`)
  }
  flush()
  return chunks
}

// ---------------------------------------------------------------------------
// Record content helpers
// ---------------------------------------------------------------------------

/** Bound one observation/reflection content string. */
export const MAX_RECORD_CONTENT_CHARS = 10_000

export function truncateRecordContent(content: string): string {
  if (content.length <= MAX_RECORD_CONTENT_CHARS) return content
  const head = content.slice(0, MAX_RECORD_CONTENT_CHARS)
  const dropped = content.length - MAX_RECORD_CONTENT_CHARS
  return `${head} … [truncated ${dropped} chars]`
}

// ---------------------------------------------------------------------------
// Recall rendering
// ---------------------------------------------------------------------------

/** Render one source event for the recall tool, or null when not renderable. */
export function renderRecallSourceEvent(event: EventView, toolNames?: ReadonlyMap<string, string>): string | null {
  if (!isSourceEvent(event)) return null
  return renderSourceEvent(event, toolNames ?? toolNameByCallId([]))
}

export function renderRecallSourceEvents(events: readonly EventView[], toolNames?: ReadonlyMap<string, string>): string {
  return events
    .map((event) => renderRecallSourceEvent(event, toolNames))
    .filter((block): block is string => block !== null && block.trim().length > 0)
    .join('\n\n')
}
