import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import {
  resolveCompactAfterTokens,
  resolveConfig,
  resolveObservationsPoolTargetTokens,
  resolveObserverChunkMaxTokens,
  unwrapVolatileConfig,
  Config,
  PlainConfig,
} from '../src/config.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'om-config-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('Config schema', () => {
  it('resolves defaults for an empty composition entry', () => {
    const config = PlainConfig({})
    expect(config.observeAfterTokens).toBe(10_000)
    expect(config.reflectAfterTokens).toBe(20_000)
    expect(config.compactAfterTokens).toBe(0)
    expect(config.compactAfterTokensMode).toBe('calibrated')
    expect(config.compactAfterTokensRatio).toBe(0.68)
    expect(config.observationsPoolMaxTokens).toBe(20_000)
    expect(config.agentMaxTurns).toBe(16)
    expect(config.passive).toBe(false)
    expect(config.debugLog).toBe(false)
    expect(config.showWorkerNotifications).toBe(true)
  })

  it('keeps user values', () => {
    const config = PlainConfig({ observeAfterTokens: 5000, passive: true, model: { provider: 'p', id: 'm' } })
    expect(config.observeAfterTokens).toBe(5000)
    expect(config.passive).toBe(true)
    expect(config.model).toEqual({ provider: 'p', id: 'm' })
  })
})

describe('resolveObserverChunkMaxTokens', () => {
  const base = resolveConfig({})

  it('honors an explicit config value (clamped to the minimum)', () => {
    expect(resolveObserverChunkMaxTokens(resolveConfig({ observerChunkMaxTokens: 5000 }), 1_000_000)).toBe(5000)
    expect(resolveObserverChunkMaxTokens(resolveConfig({ observerChunkMaxTokens: 256 }), 1_000_000)).toBe(256)
  })

  it('derives from the model context window and floors at the minimum', () => {
    expect(resolveObserverChunkMaxTokens(base, 1_000_000)).toBe(200_000)
    expect(resolveObserverChunkMaxTokens(base, 1000)).toBe(256)
  })

  it('falls back when the window is unknown or invalid', () => {
    expect(resolveObserverChunkMaxTokens(base, undefined)).toBe(60_000)
    expect(resolveObserverChunkMaxTokens(base, 0)).toBe(60_000)
    expect(resolveObserverChunkMaxTokens(base, -5)).toBe(60_000)
  })
})

describe('resolveCompactAfterTokens', () => {
  it('returns the static threshold in calibrated mode', () => {
    const config = resolveConfig({ compactAfterTokens: 81_000 })
    expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(81_000)
    expect(resolveCompactAfterTokens(config, undefined)).toBe(81_000)
  })

  it('derives from the context window in ratio mode', () => {
    const config = resolveConfig({ compactAfterTokensMode: 'ratio', compactAfterTokensRatio: 0.68 })
    expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(680_000)
    expect(resolveCompactAfterTokens(config, 128_000)).toBe(87_040)
  })

  it('derives a positive threshold even when the static value is 0', () => {
    const config = resolveConfig({ compactAfterTokens: 0, compactAfterTokensMode: 'ratio', compactAfterTokensRatio: 0.5 })
    expect(resolveCompactAfterTokens(config, 100)).toBe(50)
    expect(resolveCompactAfterTokens(config, 1)).toBe(1)
  })

  it('disables the trigger when the window is unknown or invalid in ratio mode', () => {
    // compactAfterTokens is inert in ratio mode: there is no calibrated fallback.
    const config = resolveConfig({ compactAfterTokens: 81_000, compactAfterTokensMode: 'ratio' })
    expect(resolveCompactAfterTokens(config, undefined)).toBe(0)
    expect(resolveCompactAfterTokens(config, 0)).toBe(0)
    expect(resolveCompactAfterTokens(config, -5)).toBe(0)
  })

  it('disables the trigger for endpoint ratios the schema admits', () => {
    const zero = resolveConfig({ compactAfterTokens: 81_000, compactAfterTokensMode: 'ratio', compactAfterTokensRatio: 0 })
    const one = resolveConfig({ compactAfterTokens: 81_000, compactAfterTokensMode: 'ratio', compactAfterTokensRatio: 1 })
    expect(resolveCompactAfterTokens(zero, 1_000_000)).toBe(0)
    expect(resolveCompactAfterTokens(one, 1_000_000)).toBe(0)
  })

  it('ignores the ratio in calibrated mode', () => {
    const config = resolveConfig({ compactAfterTokens: 81_000, compactAfterTokensRatio: 0.5 })
    expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(81_000)
    expect(resolveCompactAfterTokens(config, undefined)).toBe(81_000)
  })

  it('rejects out-of-range ratios at the schema boundary', () => {
    expect(() => PlainConfig({ compactAfterTokensRatio: -0.1 })).toThrow()
    expect(() => PlainConfig({ compactAfterTokensRatio: 1.5 })).toThrow()
  })

  it('rejects an unknown mode at the schema boundary', () => {
    expect(() => PlainConfig({ compactAfterTokensMode: 'windowed' as never })).toThrow()
  })
})

describe('resolveObservationsPoolTargetTokens', () => {
  it('defaults to half of the pool max', () => {
    expect(resolveObservationsPoolTargetTokens(resolveConfig({}))).toBe(10_000)
    expect(resolveObservationsPoolTargetTokens(resolveConfig({ observationsPoolMaxTokens: 3000 }))).toBe(1500)
  })

  it('honors a valid explicit target and rejects invalid ones', () => {
    expect(
      resolveObservationsPoolTargetTokens(resolveConfig({ observationsPoolMaxTokens: 3000, observationsPoolTargetTokens: 1000 })),
    ).toBe(1000)
    expect(
      resolveObservationsPoolTargetTokens(resolveConfig({ observationsPoolMaxTokens: 3000, observationsPoolTargetTokens: 9000 })),
    ).toBe(1500)
  })
})

describe('live (volatile) configuration', () => {
  it('marks every editable schema field volatile for the DSH ≥0.1.7 settings transport', () => {
    const dict = (Config as unknown as { dict: Record<string, { meta: { volatile?: boolean } }> }).dict
    for (const [key, field] of Object.entries(dict)) {
      expect(field.meta.volatile, `field ${key}`).toBe(true)
    }
  })

  it('parses plain values unchanged (legacy host shape)', () => {
    const config = resolveConfig({ observeAfterTokens: 5000, passive: true })
    expect(config.observeAfterTokens).toBe(5000)
    expect(config.passive).toBe(true)
  })

  it('unwraps volatile refs before schema parsing (DSH ≥0.1.7 shape)', () => {
    const ref = <T,>(value: T) => ({ get: () => value })
    const config = resolveConfig({
      observeAfterTokens: ref(5000),
      passive: ref(true),
      model: ref({ provider: 'p', id: 'm' }),
    } as never)
    expect(config.observeAfterTokens).toBe(5000)
    expect(config.passive).toBe(true)
    expect(config.model).toEqual({ provider: 'p', id: 'm' })
  })

  it('unwrapVolatileConfig reads the ref live at every call', () => {
    let current = 10_000
    const live = { observeAfterTokens: { get: () => current } } as never
    expect(unwrapVolatileConfig(live).observeAfterTokens).toBe(10_000)
    current = 5000
    expect(unwrapVolatileConfig(live).observeAfterTokens).toBe(5000)
  })
})

describe('OmRuntime config epochs', () => {
  it('setConfig with an unchanged value is a no-op (no epoch reset)', async () => {
    const { OmRuntime } = await import('../src/runtime.ts')
    const runtime = new OmRuntime(resolveConfig({ storageDir: dir }), { onError: () => {} })
    runtime.workerConsecutiveFailures.set('s1', 3)
    runtime.setConfig({ storageDir: dir })
    expect(runtime.workerConsecutiveFailures.get('s1')).toBe(3)
  })

  it('setConfig with a changed value applies it and resets the epoch', async () => {
    const { OmRuntime } = await import('../src/runtime.ts')
    const runtime = new OmRuntime(resolveConfig({ storageDir: dir }), { onError: () => {} })
    runtime.workerConsecutiveFailures.set('s1', 3)
    runtime.setConfig({ storageDir: dir, observeAfterTokens: 5000 })
    expect(runtime.config.observeAfterTokens).toBe(5000)
    expect(runtime.workerConsecutiveFailures.get('s1')).toBeUndefined()
  })

  it('refreshConfig polls the bound live source and applies drift', async () => {
    const { OmRuntime } = await import('../src/runtime.ts')
    let current = 10_000
    const runtime = new OmRuntime(resolveConfig({ storageDir: dir }), { onError: () => {} })
    runtime.bindConfigSource(() => ({ storageDir: dir, observeAfterTokens: current }))
    runtime.refreshConfig()
    expect(runtime.config.observeAfterTokens).toBe(10_000)
    current = 5000
    runtime.refreshConfig()
    expect(runtime.config.observeAfterTokens).toBe(5000)
  })
})
