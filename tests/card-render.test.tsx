import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ObservationalMemoryCard } from '../src/client/card.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { OmCardState } from '../src/client/controller.ts'

function stateWith(overrides: Partial<OmCardState> = {}): OmCardState {
  return {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    fields: {},
    catalogStatus: 'idle',
    catalog: [],
    ...overrides,
  }
}

function render(state: OmCardState, locale: Record<string, string>) {
  return renderToStaticMarkup(
    createElement(ObservationalMemoryCard, {
      t: (key: string) => locale[key] ?? key,
      useOmCard: (selector: (s: OmCardState) => unknown) => selector(state),
      edit: () => {},
      resetField: () => {},
      save: () => {},
      discard: () => {},
    } as never),
  )
}

describe('ObservationalMemoryCard', () => {
  it('renders nothing while the namespace is unavailable', () => {
    expect(render(stateWith({ available: false }), en)).toBe('')
  })

  it('renders the collapsed card header in English', () => {
    const html = render(stateWith(), en)
    expect(html).toContain('Observational Memory')
    expect(html).toContain('background')
    expect(html).not.toContain('action.save')
  })

  it('renders Chinese copy from the zh dictionary', () => {
    const html = render(stateWith(), zh as Record<string, string>)
    expect(html).toContain('在后台把会话沉淀为观察与反思')
  })

  it('shows the unsaved badge when the form is dirty', () => {
    const html = render(stateWith({ dirty: true }), en)
    expect(html).toContain('Unsaved')
  })

  it('keeps zh and en dictionaries in key parity', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
