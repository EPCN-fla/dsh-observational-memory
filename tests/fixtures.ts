import { hashId } from '../src/ids.ts'
import type { EventView } from '../src/serialize.ts'
import type { Observation, Relevance } from '../src/ledger/types.ts'

export function makeObservation(overrides: Partial<Observation> = {}): Observation {
  const content = overrides.content ?? 'User stated they use Postgres for the project database.'
  return {
    id: overrides.id ?? hashId(content),
    content,
    timestamp: overrides.timestamp ?? '2026-01-15 14:30',
    relevance: overrides.relevance ?? ('medium' as Relevance),
    sourceEventSeqs: overrides.sourceEventSeqs ?? [1],
    tokenCount: overrides.tokenCount ?? 20,
  }
}

export function makeReflection(content: string, supportingObservationIds: string[] = ['a1b2c3d4e5f6']) {
  return {
    id: hashId(content),
    content,
    supportingObservationIds,
    tokenCount: Math.ceil(content.length / 4),
  }
}

let seqCounter = 0

/** Reset the auto seq counter for deterministic tests. */
export function resetSeqs(): void {
  seqCounter = 0
}

export function userEvent(text: string, seq?: number): EventView {
  return {
    seq: seq ?? seqCounter++,
    type: 'user/message',
    time: Date.parse('2026-01-15T14:30:00'),
    data: {
      id: `m-${seq ?? seqCounter}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
}

export function assistantEvent(text: string, seq?: number): EventView {
  return {
    seq: seq ?? seqCounter++,
    type: 'assistant/message',
    time: Date.parse('2026-01-15T14:31:00'),
    data: {
      turn: 0,
      step: 0,
      message: {
        id: `m-${seq ?? seqCounter}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      },
      stream: [],
    },
  }
}

export function toolCallEvent(callId: string, name: string, args: string, seq?: number): EventView {
  return {
    seq: seq ?? seqCounter++,
    type: 'tool/call',
    time: Date.parse('2026-01-15T14:31:30'),
    data: { turn: 0, step: 0, callId, name, arguments: args },
  }
}

export function toolResultEvent(callId: string, text: string, seq?: number): EventView {
  return {
    seq: seq ?? seqCounter++,
    type: 'tool/result',
    time: Date.parse('2026-01-15T14:32:00'),
    data: {
      turn: 0,
      step: 0,
      message: {
        id: `m-${seq ?? seqCounter}`,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
        source: { kind: 'tool', callId },
      },
    },
  }
}

export function turnEndEvent(seq?: number): EventView {
  return {
    seq: seq ?? seqCounter++,
    type: 'turn/end',
    time: Date.parse('2026-01-15T14:33:00'),
    data: { turn: 0, reason: { kind: 'completed' } },
  }
}
