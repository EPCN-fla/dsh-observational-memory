import { describe, expect, it } from 'vitest'
import {
  estimateEventsTokens,
  renderRecallSourceEvents,
  serializeSourceAddressedEventChunks,
  serializeSourceEvents,
} from '../src/serialize.ts'
import {
  assistantEvent,
  resetSeqs,
  toolCallEvent,
  toolResultEvent,
  turnEndEvent,
  userEvent,
} from './fixtures.ts'

describe('serializeSourceEvents', () => {
  it('renders user, assistant and tool-result events with labels and times', () => {
    resetSeqs()
    const events = [
      userEvent('Please migrate the API.'),
      assistantEvent('On it.'),
      toolCallEvent('c1', 'bash', '{"command":"ls"}'),
      toolResultEvent('c1', 'README.md'),
      turnEndEvent(),
    ]
    const text = serializeSourceEvents(events)
    expect(text).toContain('[User @ 2026-01-15 14:30]: Please migrate the API.')
    expect(text).toContain('[Assistant @ 2026-01-15 14:31]: On it.')
    expect(text).toContain('[Tool result for bash @ 2026-01-15 14:32]: README.md')
    expect(text).not.toContain('turn')
  })

  it('resolves the tool name from the 0.1.5 user-role tool-result shape', () => {
    resetSeqs()
    // DSH 0.1.5: role 'user', call id only at source.callId (no top-level field).
    const legacy = toolResultEvent('c1', 'README.md')
    const data = legacy.data as { message: Record<string, unknown> }
    delete data.message.toolCallId
    data.message.role = 'user'
    const text = serializeSourceEvents([toolCallEvent('c1', 'bash', '{}'), legacy])
    expect(text).toContain('[Tool result for bash @ 2026-01-15 14:32]: README.md')
  })

  it('renders assistant tool calls and thinking as placeholders', () => {
    resetSeqs()
    const event = assistantEvent('Working on it.')
    ;(event.data as { message: { content: unknown[] } }).message.content = [
      { type: 'reasoning', text: 'first inspect, then edit' },
      { type: 'tool-call', id: 'c9', name: 'read', arguments: '{"path":"a.ts"}' },
    ]
    const text = serializeSourceEvents([event])
    expect(text).toContain('[thinking: first inspect, then edit]')
    expect(text).toContain('[read({"path":"a.ts"})]')
  })
})

describe('serializeSourceAddressedEventChunks', () => {
  it('labels events and groups them into bounded chunks', () => {
    resetSeqs()
    const events = [userEvent('one'), userEvent('two'), userEvent('three')]
    const chunks = serializeSourceAddressedEventChunks(events, { maxTokens: 24 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flatMap(chunk => chunk.sourceEventSeqs)).toEqual(events.map(event => event.seq))
    expect(chunks[0].text).toContain(`[Source event seq: ${events[0].seq}]`)
    expect(chunks.every(chunk => chunk.estimatedTokens <= 24)).toBe(true)
  })

  it('splits an oversized event losslessly within every chunk budget', () => {
    resetSeqs()
    const big = userEvent(`HEAD${'a'.repeat(1200)}MIDDLE${'b'.repeat(1200)}TAIL`)
    const chunks = serializeSourceAddressedEventChunks([big], { maxTokens: 200 })
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every(chunk => chunk.estimatedTokens <= 200)).toBe(true)
    expect(chunks.every(chunk => chunk.sourceEventSeqs.join(',') === String(big.seq))).toBe(true)
    const text = chunks.map(chunk => chunk.text).join('\n')
    expect(text).toContain('HEAD')
    expect(text).toContain('MIDDLE')
    expect(text).toContain('TAIL')
    expect(text).not.toContain('middle omitted')
  })

  it('estimates token totals for a mixed range', () => {
    resetSeqs()
    const events = [userEvent('hello'), assistantEvent('world'), turnEndEvent()]
    const tokens = estimateEventsTokens(events)
    expect(tokens).toBeGreaterThan(0)
    // turn/end is not a source event and contributes nothing.
    expect(tokens).toBe(
      Math.ceil('[User @ 2026-01-15 14:30]: hello'.length / 4) +
        Math.ceil('[Assistant @ 2026-01-15 14:31]: world'.length / 4),
    )
  })
})

describe('renderRecallSourceEvents', () => {
  it('renders only source events', () => {
    resetSeqs()
    const events = [userEvent('evidence'), turnEndEvent()]
    const text = renderRecallSourceEvents(events)
    expect(text).toContain('evidence')
  })
})
