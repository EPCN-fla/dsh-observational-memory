import { describe, expect, it } from 'vitest'
import { findRollbackAnchor, forkRollbackSession, hasAttachments, userTextOf, type RollbackSessions } from '../src/client/rollback.ts'

const turn = (n: number, seq: number) => [
  { seq, type: 'turn/start' },
  { seq: seq + 1, type: 'user/message' },
  { seq: seq + 2, type: 'assistant/message' },
  { seq: seq + 3, type: 'turn/end' },
]

describe('findRollbackAnchor', () => {
  const events = [...turn(0, 0), ...turn(1, 10), ...turn(2, 20)]

  it('anchors at the last turn/end strictly before the message', () => {
    expect(findRollbackAnchor(events, 11)).toBe(3)
    expect(findRollbackAnchor(events, 21)).toBe(13)
  })

  it('has no anchor for a first-turn message', () => {
    expect(findRollbackAnchor(events, 1)).toBeUndefined()
  })

  it('ignores boundaries at or after the message seq', () => {
    expect(findRollbackAnchor(events, 3)).toBeUndefined()
    expect(findRollbackAnchor(events, 13)).toBe(3)
  })

  it('tolerates non-turn events interleaved between turns', () => {
    const withMarkers = [
      { seq: 0, type: 'turn/start' },
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'turn/end' },
      { seq: 3, type: 'session/label' },
      { seq: 4, type: 'turn/start' },
      { seq: 5, type: 'user/message' },
    ]
    expect(findRollbackAnchor(withMarkers, 5)).toBe(2)
  })
})

describe('userTextOf', () => {
  it('joins text blocks exactly like the copy action', () => {
    expect(userTextOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(userTextOf('not an array')).toBe('')
    expect(userTextOf([])).toBe('')
  })
})

describe('hasAttachments', () => {
  it('detects image and file blocks', () => {
    expect(hasAttachments([{ type: 'image', attachment: {} }])).toBe(true)
    expect(hasAttachments([{ type: 'file', attachment: {} }])).toBe(true)
    expect(hasAttachments([{ type: 'text', text: 'x' }])).toBe(false)
    expect(hasAttachments('nope')).toBe(false)
  })
})

describe('forkRollbackSession', () => {
  it('retains the child before restoring the draft and opening it', async () => {
    const order: string[] = []
    let retained = false
    const scope = { id: 'child-scope' }
    const sessions: RollbackSessions = {
      fork: async ({ onCreated }) => {
        onCreated?.('child')
        return 'child'
      },
      retainAgentScope: id => {
        order.push(`retain:${id}`)
        retained = true
        return { release: () => { order.push('release'); retained = false } }
      },
      scope: () => retained ? scope : undefined,
      open: id => { order.push(`open:${id}`) },
    }
    await forkRollbackSession(sessions, 'source', 3, 'original text', (received, text) => {
      expect(received).toBe(scope)
      order.push(`draft:${text}`)
    }, () => { throw new Error('unexpected failure') })
    expect(order).toEqual(['retain:child', 'draft:original text', 'open:child', 'release'])
  })

  it('continues with a child created before a later fork-step failure', async () => {
    const opened: string[] = []
    const drafts: string[] = []
    const failures: string[] = []
    const scope = {}
    const sessions: RollbackSessions = {
      fork: async ({ onCreated }) => {
        onCreated?.('child')
        throw new Error('rename failed')
      },
      retainAgentScope: () => ({ release: () => {} }),
      scope: () => scope,
      open: id => { opened.push(id) },
    }
    await forkRollbackSession(sessions, 'source', 3, 'original text', (_scope, text) => {
      drafts.push(text)
    }, failure => { failures.push(failure) })
    expect(drafts).toEqual(['original text'])
    expect(opened).toEqual(['child'])
    expect(failures).toEqual([])
  })

  it('reports an unavailable child scope instead of silently dropping the draft', async () => {
    const failures: string[] = []
    let released = false
    const sessions: RollbackSessions = {
      fork: async () => 'child',
      retainAgentScope: () => ({ release: () => { released = true } }),
      scope: () => undefined,
      open: () => { throw new Error('must not open without a draft') },
    }
    await forkRollbackSession(sessions, 'source', 3, 'original text', () => {}, failure => { failures.push(failure) })
    expect(failures).toEqual(['restore'])
    expect(released).toBe(true)
  })
})
