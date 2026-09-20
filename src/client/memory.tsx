/**
 * The Memory conversation view tab: renders the host-side `/om:status` and
 * `/om:view` reports plus the debug-log tail (when recording is on), each in
 * its own section. Chrome follows the settings card's own style language —
 * the bundle-purity gate forbids importing the shipped views' components.
 */
import { useEffect, useRef, useState } from 'react'
import type { LocaleKey } from './locales.ts'
import type { MemoryViewMode, OmMemoryState } from './memory.ts'
import css from './memory.module.css'

export type MemoryTranslate = (key: LocaleKey, params?: Record<string, string | number>) => string

/**
 * Clipboard write with a legacy fallback: `navigator.clipboard` needs a
 * secure context, which loopback HTTP already is, but the textarea path keeps
 * older embedders working. Returns whether the write succeeded.
 */
async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    if (typeof document === 'undefined') return false
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

/** Props the slot entry composes: injected face plus the locale seat. */
export interface MemoryViewProps {
  t: MemoryTranslate
  /** Selector hook synthesized from the inject face's `hooks.memory` store. */
  useMemory: <S>(selector: (state: OmMemoryState) => S) => S
  refresh: () => void
  run: () => void
  setViewMode: (mode: MemoryViewMode) => void
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{props.title}</h3>
      {props.children}
    </section>
  )
}

function ReportBody(props: { text: string; empty: string }) {
  if (props.text === '') return <p className={css.empty}>{props.empty}</p>
  return <pre className={css.report}>{props.text}</pre>
}

export function MemoryView(props: MemoryViewProps) {
  const { t } = props
  const state = props.useMemory((snapshot) => snapshot)
  // Same success chrome discipline as the user-message copy action: a short
  // check swap, gated so re-clicks during the window neither re-copy nor
  // stack timers, and no post-unmount setState.
  const [copied, setCopied] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyEpoch = useRef(0)

  // Pull once on mount (and on session change, which remounts the entry);
  // after that the refresh button drives.
  const refresh = props.refresh
  useEffect(() => {
    refresh()
  }, [refresh])
  useEffect(() => () => {
    copyEpoch.current += 1
    copyPending.current = false
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])

  const onCopy = () => {
    if (copied || copyPending.current || state.viewText === '') return
    const epoch = copyEpoch.current
    copyPending.current = true
    void writeClipboardText(state.viewText).then((ok) => {
      if (epoch !== copyEpoch.current) return
      copyPending.current = false
      if (!ok) return
      setCopied(true)
      copyTimer.current = setTimeout(() => {
        copyTimer.current = null
        setCopied(false)
      }, 1000)
    })
  }

  return (
    <div className={css.view}>
      <div className={css.toolbar}>
        <div className={css.modeSwitch} role="group" aria-label={t('memory.mode.label')}>
          {(['visible', 'full'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={mode === state.viewMode ? css.modeActive : css.mode}
              aria-pressed={mode === state.viewMode}
              onClick={() => props.setViewMode(mode)}
            >
              {t(mode === 'visible' ? 'memory.mode.visible' : 'memory.mode.full')}
            </button>
          ))}
        </div>
        <div className={css.toolbarActions}>
          <button
            type="button"
            className={css.toolButton}
            disabled={state.running || state.refreshing}
            onClick={props.run}
          >
            {t(state.running ? 'memory.running' : 'memory.run')}
          </button>
          <button
            type="button"
            className={css.toolButton}
            disabled={state.viewText === ''}
            onClick={onCopy}
          >
            {t(copied ? 'memory.copied' : 'memory.copy')}
          </button>
          <button type="button" className={css.toolButton} disabled={state.refreshing} onClick={props.refresh}>
            {t(state.refreshing ? 'memory.refreshing' : 'memory.refresh')}
          </button>
        </div>
      </div>
      {state.refreshedAt !== undefined ? (
        <p className={css.updatedAt}>
          {t('memory.updatedAt', {
            time: `${String(new Date(state.refreshedAt).getHours()).padStart(2, '0')}:${String(new Date(state.refreshedAt).getMinutes()).padStart(2, '0')}`,
          })}
        </p>
      ) : null}
      {state.error !== undefined ? (
        <p className={css.error} role="status">{t('memory.error')}: {state.error}</p>
      ) : null}
      {state.phase === 'loading' ? (
        <p className={css.empty} role="status">{t('memory.loading')}</p>
      ) : (
        <div className={css.sections}>
          <Section title={t('memory.section.status')}>
            <ReportBody text={state.statusText} empty={t('memory.empty.status')} />
          </Section>
          <Section title={t('memory.section.content')}>
            <ReportBody text={state.viewText} empty={t('memory.empty.content')} />
          </Section>
          {state.logsEnabled ? (
            <Section title={t('memory.section.logs')}>
              <ReportBody text={state.logsText} empty={t('memory.empty.logs')} />
            </Section>
          ) : null}
        </div>
      )}
    </div>
  )
}
