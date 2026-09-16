import { describe, expect, it } from 'vitest'
import {
  earlierSeq,
  latestCoverageSeq,
  rawTokensSinceObservationCoverage,
  rawTokensSinceReflectionCoverage,
  sourceEventsAfter,
} from '../src/ledger/progress.ts'
import type { LedgerEntry } from '../src/ledger/types.ts'
import { assistantEvent, resetSeqs, turnEndEvent, userEvent } from './fixtures.ts'

describe('progress clocks', () => {
  it('counts estimated source tokens after the latest observation watermark', () => {
    resetSeqs()
    const events = [userEvent('hello there'), assistantEvent('hi!'), turnEndEvent(), userEvent('more work')]
    const entries: LedgerEntry[] = [
      {
        kind: 'observations-recorded',
        observations: [
          {
            id: 'a1b2c3d4e5f6',
            content: 'x',
            timestamp: '2026-01-15 14:30',
            relevance: 'low',
            sourceEventSeqs: [0],
            tokenCount: 5,
          },
        ],
        coversUpToSeq: 1,
      },
    ]

    expect(latestCoverageSeq(entries, 'observations-recorded')).toBe(1)
    const progress = rawTokensSinceObservationCoverage(events, entries)
    // Only source events with seq > 1 count: the second user message.
    const expected = Math.ceil('[User @ 2026-01-15 14:30]: more work'.length / 4)
    expect(progress).toBe(expected)
    // Reflection clock has no coverage: counts everything source.
    expect(rawTokensSinceReflectionCoverage(events, entries)).toBeGreaterThan(progress)
  })

  it('ignores non-source events when slicing', () => {
    resetSeqs()
    const events = [userEvent('a'), turnEndEvent(), assistantEvent('b')]
    expect(sourceEventsAfter(events, -1).map((event) => event.type)).toEqual([
      'user/message',
      'assistant/message',
    ])
    expect(sourceEventsAfter(events, 0).map((event) => event.type)).toEqual(['assistant/message'])
  })

  it('picks the earlier of two watermarks', () => {
    expect(earlierSeq(3, 7)).toBe(3)
    expect(earlierSeq(9, 2)).toBe(2)
    expect(earlierSeq(undefined, 4)).toBe(4)
    expect(earlierSeq(4, undefined)).toBe(4)
    expect(earlierSeq(undefined, undefined)).toBeUndefined()
  })
})
