import { Context } from '@deepseek-ai/cordis'
import { Remote, remoteMethods, type RemoteMethodMarker } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { OmApiService } from '../src/api.ts'
import { OmRuntime } from '../src/runtime.ts'

type SessionMarker = RemoteMethodMarker & {
  resources?: Record<string, (...args: unknown[]) => unknown>
}

function marker(service: object, method: string): SessionMarker {
  const found = remoteMethods(service).find(candidate => candidate.method === method)
  if (!found) throw new Error(`missing Remote marker for ${method}`)
  return found
}

describe('Observational Memory Remote authorization', () => {
  it('scopes every session endpoint to the requested session resource', () => {
    const ctx = new Context()
    const runtime = new OmRuntime({}, { onError: () => {} })
    const service = new OmApiService(ctx, runtime)
    let supportsSessionResources = true
    try {
      ;(Remote as unknown as (options: unknown) => unknown)({ name: 'probe', resources: { session: () => 's1' } })
    } catch {
      supportsSessionResources = false
    }
    for (const method of ['status', 'view', 'run', 'logs']) {
      const reader = marker(service, method).resources?.session
      if (!supportsSessionResources) {
        // Legacy Typert has no resource-map contract; remoteForSession must
        // retain its name-only decorator rather than throwing at module load.
        expect(reader).toBeUndefined()
        continue
      }
      expect(reader, `${method} must not fall back to global authorization`).toBeTypeOf('function')
      expect(reader?.({ sessionId: 'session-victim' }, undefined)).toBe('session-victim')
    }
  })
})
