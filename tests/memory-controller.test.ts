import { describe, expect, it } from 'vitest'
import { OmMemoryController, type ConnectionRpcLike } from '../src/client/memory.ts'

type Handler = (request: Record<string, unknown>) => unknown

/** Fake RPC caller dispatching by endpoint; throws on unexpected endpoints. */
function fakeRpc(handlers: Record<string, Handler>): ConnectionRpcLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async call(_channel, endpoint, payload) {
      calls.push(endpoint)
      const handler = handlers[endpoint]
      if (handler === undefined) return { ok: false, error: { code: 'test/unknown', message: `unknown endpoint ${endpoint}` } }
      const request = (payload as { args: { request: Record<string, unknown> } }).args.request
      return { ok: true, value: handler(request) }
    },
  }
}

describe('OmMemoryController', () => {
  it('pulls status, view and logs on refresh', async () => {
    const rpc = fakeRpc({
      'observationalMemory/status': () => ({ text: 'STATUS' }),
      'observationalMemory/view': () => ({ text: 'VIEW' }),
      'observationalMemory/logs': () => ({ enabled: true, text: 'LOGS' }),
    })
    const controller = new OmMemoryController(rpc, 'session-1')
    await controller.refresh()
    const state = controller.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.statusText).toBe('STATUS')
    expect(state.viewText).toBe('VIEW')
    expect(state.logsEnabled).toBe(true)
    expect(state.logsText).toBe('LOGS')
    expect(state.error).toBeUndefined()
    expect(state.refreshedAt).toBeTypeOf('number')
    expect(rpc.calls).toEqual([
      'observationalMemory/status',
      'observationalMemory/view',
      'observationalMemory/logs',
    ])
  })

  it('keeps working sections on a partial failure and reports the error', async () => {
    const rpc = fakeRpc({
      'observationalMemory/status': () => ({ text: 'STATUS' }),
      'observationalMemory/logs': () => ({ enabled: false, text: '' }),
    })
    const controller = new OmMemoryController(rpc, 'session-1')
    await controller.refresh()
    const state = controller.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.statusText).toBe('STATUS')
    expect(state.error).toContain('unknown endpoint observationalMemory/view')
  })

  it('switches the view mode and refetches only the view section', async () => {
    const rpc = fakeRpc({
      'observationalMemory/view': (request) => ({ text: `VIEW:${String(request.mode)}` }),
    })
    const controller = new OmMemoryController(rpc, 'session-1')
    await controller.setViewMode('full')
    expect(controller.getSnapshot().viewMode).toBe('full')
    expect(controller.getSnapshot().viewText).toBe('VIEW:full')
    expect(rpc.calls).toEqual(['observationalMemory/view'])
  })

  it('drops a stale response issued before a newer refresh', async () => {
    let release: (value: unknown) => void = () => {}
    const gate = new Promise((resolve) => {
      release = resolve
    })
    let calls = 0
    const rpc: ConnectionRpcLike = {
      async call(_channel, endpoint) {
        calls += 1
        if (endpoint === 'observationalMemory/view' && calls === 1) {
          return { ok: true, value: (await gate) as never }
        }
        return { ok: true, value: { text: `fresh:${endpoint}`, enabled: false } }
      },
    }
    const controller = new OmMemoryController(rpc, 'session-1')
    const stale = controller.refresh()
    const second = controller.refresh()
    release({ text: 'STALE' })
    await Promise.all([stale, second])
    expect(controller.getSnapshot().viewText).toBe('fresh:observationalMemory/view')
  })
})
