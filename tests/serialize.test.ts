import { describe, expect, it } from 'vitest'
import {
  estimateEventsTokens,
  renderRecallSourceEvents,
  serializeSourceAddressedEvents,
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

describe('serializeSourceAddressedEvents', () => {
  it('labels each event with its source seq and stays under budget', () => {
    resetSeqs()
    const events = [userEvent('one'), userEvent('two'), userEvent('three')]
    const result = serializeSourceAddressedEvents(events, { maxTokens: 24 })
    expect(result.sourceEventSeqs.length).toBeGreaterThan(0)
    expect(result.sourceEventSeqs.length).toBeLessThan(3)
    expect(result.text).toContain(`[Source event seq: ${events[0].seq}]`)
    expect(result.estimatedTokens).toBeLessThanOrEqual(24 + 4)
  })

  it('never stalls on a single oversized first event: emits a marked excerpt', () => {
    resetSeqs()
    const big = userEvent('x'.repeat(4000))
    const result = serializeSourceAddressedEvents([big], { maxTokens: 200 })
    expect(result.sourceEventSeqs).toEqual([big.seq])
    expect(result.truncatedSourceEventSeqs).toEqual([big.seq])
    expect(result.text).toContain('middle omitted')
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
