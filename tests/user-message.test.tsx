/**
 * Render smoke tests for the rollback-enabled user bubble. The platform-shared
 * ui-primitives module is factory-mocked: its published lib carries undeclared
 * runtime imports (clsx, katex, …) only the in-repo shell build provides.
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  fileExtension: (name: string) => name.split('.').at(-1) ?? '',
  FileTypeIcon: () => null,
  fileSizeText: (bytes: number) => `${bytes} B`,
  // DSH ≥0.1.7 weight-name exports (no pixel-suffixed entries): the runtime
  // fallback in user-message.tsx must pick these.
  IconCheckOutlineRegular: () => createElement('span', { 'data-icon': 'check' }),
  IconCopyOutlineRegular: () => createElement('span', { 'data-icon': 'copy' }),
  JsonBlock: () => null,
  projectUserText: (text: string) => text,
  Tooltip: (props: { children?: ReactNode }) => createElement(Fragment_ => props.children, null),
  writeClipboard: async () => true,
}))

import { OmUserMessageNodeView } from '../src/client/user-message.tsx'
import { en, zh } from '../src/client/locales.ts'

function node(overrides: { seq?: number; turn?: number; content?: readonly unknown[] } = {}) {
  return {
    anchorSeq: overrides.seq ?? 11,
    location: { kind: 'turn', turn: { turn: overrides.turn ?? 1 } },
    data: {
      seq: overrides.seq ?? 11,
      time: Date.parse('2026-01-15T14:30:00'),
      content: overrides.content ?? [{ type: 'text', text: 'remember the codename' }],
    },
  }
}

function render(options: {
  n?: ReturnType<typeof node>
  locale?: Record<string, string>
  rollbackWindow?: () => { entries: { seq: number; type: string }[]; hasMore: boolean }
  renderFactorySlot?: (name: string, props: Record<string, unknown>, options?: { fallback?: ReactNode }) => ReactNode
  rollback?: (anchor: number, text: string) => void
  notifyRollbackBlocked?: () => void
}) {
  const locale = options.locale ?? (en as Record<string, string>)
  return renderToStaticMarkup(
    createElement(OmUserMessageNodeView, {
      node: options.n ?? node(),
      renderMessageImages: () => null,
      openFile: () => {},
      openSkill: () => {},
      renderFactorySlot: options.renderFactorySlot,
      t: (key: string, params?: Record<string, string | number>) => {
        const template = locale[key] ?? key
        return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
      },
      rollbackWindow: options.rollbackWindow ?? (() => ({ entries: [{ seq: 3, type: 'turn/end' }], hasMore: false })),
      rollback: options.rollback ?? (() => {}),
      notifyRollbackBlocked: options.notifyRollbackBlocked ?? (() => {}),
    } as never),
  )
}

describe('OmUserMessageNodeView', () => {
  it('renders the bubble with rollback and copy actions', () => {
    const html = render({})
    expect(html).toContain('remember the codename')
    expect(html).toContain('Rollback')
    expect(html).toContain('Copy')
  })

  it('keeps the bubble when generic factories exist but the user-content factory is absent', () => {
    // DSH 0.2.0 injects renderFactorySlot into every slot entry, before it
    // supplies conversation.chat.user.content. FactoryOutlet resolves missing
    // definitions to options.fallback (or null), not to a missing function.
    const renderFactorySlot = vi.fn((_name, _props, options) => options?.fallback ?? null)
    for (const text of ['first user message', 'second user message']) {
      const html = render({
        n: node({ content: [{ type: 'text', text }] }),
        renderFactorySlot,
      })
      expect(html).toContain(text)
      expect(html).toContain('Rollback')
      expect(html).toContain('Copy')
    }
    expect(renderFactorySlot).toHaveBeenCalledTimes(2)
  })

  it('preserves file attachments and reference summaries in the missing-factory fallback', () => {
    const n = node({ content: [
      { type: 'text', text: 'review this file' },
      { type: 'file', attachment: { name: 'notes.txt', bytes: 42 } },
    ] })
    const html = render({
      n: { ...n, data: { ...n.data, referenceLabels: ['earlier-session'] } } as typeof n,
      renderFactorySlot: (_name, _props, options) => options?.fallback ?? null,
    })
    expect(html).toContain('review this file')
    expect(html).toContain('notes.txt')
    expect(html).toContain('earlier-session')
    expect(html).toContain('data-unavailable')
  })

  it('renders Chinese copy from the zh dictionary', () => {
    const html = render({ locale: zh as Record<string, string> })
    expect(html).toContain('回退')
  })

  it('disables rollback for first-turn messages', () => {
    const html = render({ n: node({ turn: 0, seq: 1 }) })
    expect(html).toContain('data-unavailable')
    expect(html).toContain('Only text-only messages past the first turn can roll back')
  })

  it('disables rollback for attachment-bearing or textless messages', () => {
    const html = render({ n: node({ content: [{ type: 'image', attachment: { ref: 'a' } }] }) })
    expect(html).toContain('data-unavailable')
  })

  it('delegates the content stack to the user-content factory on DSH ≥0.2.1', () => {
    // 0.2.1 owner share: renderMessageImages/openSkill are gone; the PropsRenderFactories
    // pair and loadImage arrive instead, and the shipped bubble delegates to the
    // conversation.chat.user.content factory. The replacement must mirror that call.
    const calls: { name: string; props: Record<string, unknown> }[] = []
    const html = renderToStaticMarkup(
      createElement(OmUserMessageNodeView, {
        node: {
          ...node({ content: [{ type: 'text', text: 'remember the codename' }] }),
          data: {
            seq: 11,
            time: Date.parse('2026-01-15T14:30:00'),
            content: [{ type: 'text', text: 'remember the codename' }],
            referenceLabels: ['earlier-session'],
            skillNames: ['deep-research'],
          },
        },
        openFile: () => {},
        loadImage: async () => undefined,
        renderSlot: () => null,
        renderFactorySlot: (name: string, props: Record<string, unknown>) => {
          calls.push({ name, props })
          return createElement('div', { 'data-factory': name })
        },
        t: (key: string) => (en as Record<string, string>)[key] ?? key,
        rollbackWindow: () => ({ entries: [{ seq: 3, type: 'turn/end' }], hasMore: false }),
        rollback: () => {},
        notifyRollbackBlocked: () => {},
      } as never),
    )
    expect(calls.map((call) => call.name)).toEqual(['conversation.chat.user.content'])
    const forwarded = calls[0]!.props as {
      content: { text: string; referenceLabels?: readonly string[] }
      facts: { sessionLabels?: readonly string[]; skillNames?: readonly string[] }
      interactive: boolean
    }
    expect(forwarded.content.text).toBe('remember the codename')
    expect(forwarded.content.referenceLabels).toEqual(['earlier-session'])
    expect(forwarded.facts.sessionLabels).toEqual(['earlier-session'])
    expect(forwarded.facts.skillNames).toEqual(['deep-research'])
    expect(forwarded.interactive).toBe(true)
    // The rollback action row stays this plugin's own on every generation.
    expect(html).toContain('Rollback')
  })

  it('renders plain text when the host serves neither projection nor render factories', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-client-ui-primitives', () => ({
      fileExtension: (name: string) => name.split('.').at(-1) ?? '',
      FileTypeIcon: () => null,
      fileSizeText: (bytes: number) => `${bytes} B`,
      IconCheckOutlineRegular: () => createElement('span', { 'data-icon': 'check' }),
      IconCopyOutlineRegular: () => createElement('span', { 'data-icon': 'copy' }),
      JsonBlock: () => null,
      // Undefined binding = absent from the host's module table (the vitest
      // mock guard refuses a truly missing property). The owner props below
      // carry no render factories either.
      projectUserText: undefined,
      Tooltip: (props: { children?: ReactNode }) => createElement('span', {}, props.children),
      writeClipboard: async () => true,
    }))
    const { OmUserMessageNodeView: FreshView } = await import('../src/client/user-message.tsx')
    const html = renderToStaticMarkup(
      createElement(FreshView, {
        node: node(),
        renderMessageImages: () => null,
        openFile: () => {},
        openSkill: () => {},
        t: (key: string) => (en as Record<string, string>)[key] ?? key,
        rollbackWindow: () => ({ entries: [{ seq: 3, type: 'turn/end' }], hasMore: false }),
        rollback: () => {},
        notifyRollbackBlocked: () => {},
      } as never),
    )
    expect(html).toContain('remember the codename')
    expect(html).toContain('Rollback')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('projectUserText'))
    warn.mockRestore()
  })
})
