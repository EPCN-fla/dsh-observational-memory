import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { buildStatusText, buildViewText, type StatusContext } from '../src/report.ts'
import type { LedgerEntry } from '../src/ledger/index.ts'
import { makeObservation, makeReflection, resetSeqs, userEvent } from './fixtures.ts'

function statusContext(overrides: Partial<StatusContext> = {}): StatusContext {
  return {
    config: resolveConfig({}),
    contextWindow: undefined,
    measuredTokens: undefined,
    consolidationInFlight: false,
    compactionInFlight: false,
    lastObserverError: undefined,
    lastReflectorError: undefined,
    lastDropperError: undefined,
    ...overrides,
  }
}

const OBSERVED = makeObservation({ content: 'User prefers pnpm over npm.' })
const REFLECTED = makeReflection('The user standardized the toolchain on pnpm.', [OBSERVED.id])

const LEDGER: LedgerEntry[] = [
  { kind: 'observations-recorded', observations: [OBSERVED], coversUpToSeq: 5 },
  { kind: 'reflections-recorded', reflections: [REFLECTED], coversUpToSeq: 5 },
  {
    kind: 'visible-memory',
    text: 'visible',
    upToSeq: 5,
    fullFold: true,
    compactionId: 'c1',
    observations: [OBSERVED],
    reflections: [REFLECTED],
  },
]

describe('buildStatusText', () => {
  it('renders memory inventory and worker progress', () => {
    const events = [userEvent('hello', 6), userEvent('again', 7)]
    const text = buildStatusText(LEDGER, events, statusContext({ measuredTokens: 12_000 }))
    expect(text).toContain('Observations: 1 recorded / 0 dropped / 1 active / 1 visible')
    expect(text).toContain('Reflections:  1 recorded / 1 visible')
    expect(text).toContain('Next observation: ~')
    expect(text).toContain('Next reflection:')
    expect(text).toContain('proactive trigger disabled')
    expect(text).toContain('Visible observation pool:')
    expect(text).toContain('Active observation pool:')
    expect(text).toContain('Reflection pool:')
    expect(text).not.toContain('── In flight ──')
    expect(text).not.toContain('── Last error ──')
  })

  it('renders the ratio-mode threshold against measured pressure', () => {
    const text = buildStatusText(LEDGER, [], statusContext({
      config: resolveConfig({ compactAfterTokensMode: 'ratio', compactAfterTokensRatio: 0.5 }),
      contextWindow: 128_000,
      measuredTokens: 32_000,
    }))
    expect(text).toContain('Next compaction:  ~32,000 / 64,000 estimated tokens (50%) (ratio 0.5 × 128,000)')
  })

  it('reports the trigger as disabled when the window is unknown in ratio mode', () => {
    const text = buildStatusText(LEDGER, [], statusContext({
      config: resolveConfig({ compactAfterTokens: 81_000, compactAfterTokensMode: 'ratio' }),
      measuredTokens: 10,
    }))
    expect(text).toContain('proactive trigger disabled')
    expect(text).toContain('(ratio mode, window or ratio unusable — trigger disabled)')
    expect(text).not.toContain('81,000')
  })

  it('renders passive mode, in-flight runs and last errors only when present', () => {
    const text = buildStatusText(LEDGER, [], statusContext({
      config: resolveConfig({ passive: true }),
      consolidationInFlight: true,
      compactionInFlight: true,
      lastObserverError: 'boom',
    }))
    expect(text).toContain('── Mode ──')
    expect(text).toContain('Passive:')
    expect(text).toContain('── In flight ──')
    expect(text).toContain('Consolidation: running')
    expect(text).toContain('Auto-compaction: running')
    expect(text).toContain('── Last error ──')
    expect(text).toContain('Observer: boom')
  })
})

describe('buildViewText', () => {
  it('renders the visible projection by default', () => {
    const text = buildViewText(LEDGER, 'visible')
    expect(text).toContain('── Reflections ──')
    expect(text).toContain(REFLECTED.id)
    expect(text).toContain('── Observations ──')
    expect(text).toContain('User prefers pnpm over npm.')
  })

  it('renders empty projections with scoped empty copy', () => {
    resetSeqs()
    expect(buildViewText([], 'visible')).toContain('No visible observations.')
    expect(buildViewText([], 'full')).toContain('No recorded reflections.')
  })

  it('renders full projections beyond the visible boundary', () => {
    const extra = makeObservation({ content: 'A later observation not yet visible.' })
    const ledger: LedgerEntry[] = [...LEDGER, { kind: 'observations-recorded', observations: [extra], coversUpToSeq: 9 }]
    expect(buildViewText(ledger, 'visible')).not.toContain('A later observation')
    expect(buildViewText(ledger, 'full')).toContain('A later observation')
  })
})
