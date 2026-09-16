import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemoryView } from '../src/client/memory.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { OmMemoryState } from '../src/client/memory.ts'

function stateWith(overrides: Partial<OmMemoryState> = {}): OmMemoryState {
  return {
    phase: 'ready',
    statusText: '── Memory ──\nObservations: 1 recorded',
    viewText: '── Observations ──\n[abc] note',
    viewMode: 'visible',
    logsEnabled: false,
    logsText: '',
    error: undefined,
    refreshedAt: undefined,
    refreshing: false,
    ...overrides,
  }
}

function render(state: OmMemoryState, locale: Record<string, string>) {
  return renderToStaticMarkup(
    createElement(MemoryView, {
      t: (key: string) => locale[key] ?? key,
      useMemory: (selector: (s: OmMemoryState) => unknown) => selector(state),
      refresh: () => {},
      setViewMode: () => {},
    } as never),
  )
}

describe('MemoryView', () => {
  it('renders status and memory sections in Chinese', () => {
    const html = render(stateWith(), zh as Record<string, string>)
    expect(html).toContain('状态')
    expect(html).toContain('记忆内容')
    expect(html).toContain('── Memory ──')
    expect(html).not.toContain('调试日志')
  })

  it('renders the debug log section only when recording is on', () => {
    const html = render(stateWith({ logsEnabled: true, logsText: '{"event":"x"}' }), en)
    expect(html).toContain('Debug log')
    expect(html).toContain('{&quot;event&quot;:&quot;x&quot;}')
  })

  it('renders the loading and error states', () => {
    expect(render(stateWith({ phase: 'loading' }), en)).toContain('Loading…')
    const html = render(stateWith({ error: 'boom' }), en)
    expect(html).toContain('Load failed')
    expect(html).toContain('boom')
  })

  it('marks the active view mode', () => {
    const html = render(stateWith({ viewMode: 'full' }), en)
    expect(html).toContain('aria-pressed="true"')
  })
})
