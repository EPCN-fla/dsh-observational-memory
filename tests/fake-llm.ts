import type { StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm'

/** One scripted model response: optional tool calls, then a finish reason. */
export type ScriptedTurn = {
  toolCalls?: { id: string; name: string; arguments: string }[]
  text?: string
  finish?: 'stop' | 'tool-calls' | 'error' | 'max-tokens'
}

export function turnChunks(turn: ScriptedTurn): StreamChunk[] {
  const chunks: StreamChunk[] = []
  let index = 0
  if (turn.text !== undefined) {
    chunks.push({ type: 'block-start', index, blockType: 'text' })
    chunks.push({ type: 'text-delta', index, text: turn.text })
    chunks.push({ type: 'block-end', index, block: { type: 'text', text: turn.text } })
    index++
  }
  for (const call of turn.toolCalls ?? []) {
    const block: ToolCallBlock = { type: 'tool-call', id: call.id as never, name: call.name, arguments: call.arguments }
    chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
    chunks.push({ type: 'tool-call-delta', index, id: call.id as never, name: call.name, argumentsDelta: call.arguments })
    chunks.push({ type: 'block-end', index, block })
    index++
  }
  const kind = turn.finish ?? (turn.toolCalls?.length ? 'tool-calls' : 'stop')
  if (kind === 'error') {
    chunks.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } })
  } else {
    chunks.push({ type: 'finish', reason: { kind } })
  }
  return chunks
}

/**
 * A fake `ctx` whose `llm.stream` plays scripted turns in order and records
 * every request's messages for assertions.
 */
export function fakeLlmCtx(turns: ScriptedTurn[]) {
  const requests: { messages: unknown[]; system?: string; tools?: unknown[] }[] = []
  let call = 0
  const ctx = {
    llm: {
      async *stream(options: { messages: unknown[]; system?: string; tools?: unknown[] }) {
        // Snapshot: the worker loop reuses one mutable messages array.
        requests.push({ messages: [...options.messages], system: options.system, tools: options.tools })
        const turn = turns[Math.min(call, turns.length - 1)]
        call++
        for (const chunk of turnChunks(turn)) yield chunk
      },
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { ctx, requests, callCount: () => call }
}
