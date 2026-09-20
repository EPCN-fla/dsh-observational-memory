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
    running: false,
    failedAction: undefined,
    ...overrides,
  }
}

function render(state: OmMemoryState, locale: Record<string, string>) {
  return renderToStaticMarkup(
    createElement(MemoryView, {
      t: (key: string) => locale[key] ?? key,
      useMemory: (selector: (s: OmMemoryState) => unknown) => selector(state),
      refresh: () => {},
      run: () => {},
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

  it('renders the run action, swapped to its busy label while running', () => {
    const idle = render(stateWith(), zh as Record<string, string>)
    expect(idle).toContain('立即运行')
    const running = render(stateWith({ running: true }), zh as Record<string, string>)
    expect(running).toContain('运行中…')
    expect(running).not.toContain('立即运行')
    expect(render(stateWith(), en)).toContain('Run now')
    expect(render(stateWith({ running: true }), en)).toContain('Running…')
  })

  it('labels a failed run differently from a failed load', () => {
    const html = render(stateWith({ error: 'boom', failedAction: 'run' }), zh as Record<string, string>)
    expect(html).toContain('运行失败')
    expect(html).not.toContain('加载失败')
    expect(render(stateWith({ error: 'boom', failedAction: 'run' }), en)).toContain('Run failed')
    expect(render(stateWith({ error: 'boom', failedAction: 'refresh' }), en)).toContain('Load failed')
  })

  it('marks the active view mode', () => {
    const html = render(stateWith({ viewMode: 'full' }), en)
    expect(html).toContain('aria-pressed="true"')
  })
})
