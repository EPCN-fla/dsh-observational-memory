/**
 * Host-generation wiring of apply(): the settings layer must bind through the
 * legacy installSection on hosts that still serve it (DSH ≤0.1.5) and through
 * the profile-owned live configuration everywhere else (DSH ≥0.1.7), without
 * touching the other generation's API in either case.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { PlainConfig } from '../src/config.ts'
import { apply } from '../src/index.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'om-wiring-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Wiring {
  installed: { namespace: string; schema: unknown; base: unknown; hooks: { setSource: (s: () => unknown) => void; onChange: () => void } }[]
  configured: { presentation: { auto: boolean } }[]
  effects: { callback: () => unknown; description?: string }[]
}

/** Minimal apply()-shaped context; the settings service is supplied per case. */
function fakeCtx(settings: unknown): { ctx: Context; wiring: Wiring } {
  const wiring: Wiring = { installed: [], configured: [], effects: [] }
  const settingsCtx = {
    settings,
    effect: (callback: () => unknown, description?: string) => {
      wiring.effects.push({ callback, description })
      return () => {}
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    fiber: { label: 'test-fiber' },
    inject: (services: string[], callback: (child: unknown) => void) => {
      expect(services).toEqual(['settings'])
      callback(settingsCtx)
    },
    on: () => () => {},
    effect: () => () => {},
    get: () => undefined,
    tools: { register: () => {} },
    plugin: () => () => {},
  } as unknown as Context
  if (settings && typeof settings === 'object') {
    const s = settings as Record<string, unknown>
    if (typeof s.installSection === 'function') {
      s.installSection = ((...args: unknown[]) => {
        wiring.installed.push({ namespace: args[1] as string, schema: args[2], base: args[3], hooks: args[4] as never })
      }) as never
    }
    if (typeof s.configure === 'function') {
      s.configure = ((presentation: { auto: boolean }) => {
        wiring.configured.push({ presentation })
        return () => {}
      }) as never
    }
  }
  return { ctx, wiring }
}

describe('apply settings wiring', () => {
  it('binds the legacy settings section on hosts that serve installSection (DSH ≤0.1.5)', () => {
    const { ctx, wiring } = fakeCtx({ installSection: () => {}, configure: undefined })
    expect(() => apply(ctx, { storageDir: dir })).not.toThrow()
    expect(wiring.installed).toHaveLength(1)
    expect(wiring.installed[0].namespace).toBe('observational-memory')
    // The legacy host machinery predates live references: plain schema face,
    // unwrapped composition value.
    expect(wiring.installed[0].schema).toBe(PlainConfig)
    expect(wiring.installed[0].base).toEqual({ storageDir: dir })
    expect(wiring.configured).toHaveLength(0)
  })

  it('claims the custom page through the live configuration on DSH ≥0.1.7', () => {
    const { ctx, wiring } = fakeCtx({ configure: () => () => {} })
    expect(() => apply(ctx, { storageDir: dir })).not.toThrow()
    expect(wiring.installed).toHaveLength(0)
    // The presentation claim is registered as an effect, not run eagerly.
    expect(wiring.effects).toHaveLength(1)
    wiring.effects[0].callback()
    expect(wiring.configured).toEqual([{ presentation: { auto: false } }])
  })

  it('unwraps volatile refs in the composition value handed to the legacy section', () => {
    const { ctx, wiring } = fakeCtx({ installSection: () => {} })
    const live = { storageDir: { get: () => dir }, passive: { get: () => true } } as never
    apply(ctx, live)
    expect(wiring.installed[0].base).toEqual({ storageDir: dir, passive: true })
  })
})
