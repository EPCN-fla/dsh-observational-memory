/**
 * The rollback-enabled user message renderer: a faithful port of the shipped
 * user bubble (attachments, mention projection, reference summary, clock and
 * copy) with one addition — a 回退 (rollback) action left of the copy button.
 *
 * The port is forced by the slot architecture: `conversation.chat.node` has
 * no additive seam for user-message actions, so this plugin replaces the
 * keyed `user`/`steering` renderers while loaded; unloading restores the
 * built-ins. Value imports stay on platform-shared modules only.
 */
import { Fragment, memo, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fileExtension,
  FileTypeIcon,
  fileSizeText,
  JsonBlock,
  projectUserText,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocaleKey } from './locales.ts'
import { findRollbackAnchor, hasAttachments, userTextOf, type RollbackEventView } from './rollback.ts'
import css from './user-message.module.css'

// DSH 0.1.7 renamed the pixel-suffixed product icons to weight names
// (Icon*Outline16 → Icon*OutlineRegular; DSH-0.1.7-J1-26). ui-primitives is
// a platform-external module served by the host, so the export either
// generation provides is resolved at runtime; the weight name wins when both
// exist. A future host carrying NEITHER name must not take every user node
// down with React #130 — fall back to a silent no-icon stub and say so once.
const iconTable = primitives as unknown as Record<string, ComponentType>
function pickIcon(weightName: string, pixelName: string): ComponentType {
  const icon = iconTable[weightName] ?? iconTable[pixelName]
  if (icon !== undefined) return icon
  console.warn(`[observational-memory] host ui-primitives exports neither ${weightName} nor ${pixelName}; the action renders without an icon`)
  return () => null
}
const IconCheckOutline = pickIcon('IconCheckOutlineRegular', 'IconCheckOutline16')
const IconCopyOutline = pickIcon('IconCopyOutlineRegular', 'IconCopyOutline16')

export type UserMessageTranslate = (key: LocaleKey, params?: Record<string, string | number>) => string

// The 0.1.7 built-in bubble passes chip actions (openFile/openSkill) as
// projectUserText's optional fifth argument; 0.1.5's host-served copy takes
// only four parameters and ignores the extra argument at runtime. The alias
// keeps the call typechecking against both generations' declarations.
type ProjectUserText = (
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[],
  slashKind: 'skill' | 'command',
  references?: { openFile: (path: string) => void; openSkill: (name: string) => void } | undefined,
) => ReactNode
const projectUserTextWithRefs = projectUserText as ProjectUserText

/** The node payload shape this renderer consumes (mirrors UserMessageNode). */
export interface UserMessageNodeLike {
  seq: number
  time: number
  content: readonly unknown[]
  referenceLabels?: readonly string[]
  skillNames?: readonly string[]
}

/** The slot owner share this renderer consumes (mirrors ChatNodeOwnerProps).
 *  Note: the 0.1.7 owner additions groupPart/openSkill are assistant-node
 *  concerns (reasoning/response grouping) or chip actions; a user/steering
 *  bubble legitimately never sees groupPart, and openSkill may be absent on
 *  0.1.5 — the references pass-through below gates on it. */
export interface UserMessageOwnerLike {
  node: {
    anchorSeq: number
    location: { kind: string; turn?: { turn: number } }
    data: UserMessageNodeLike
  }
  renderMessageImages: (options: { images: { attachment: unknown }[]; align: 'end'; compact: boolean }) => ReactNode
  openFile: (path: string) => void
  openSkill?: ((name: string) => void) | undefined
  t: UserMessageTranslate
}

/** The rollback face the slot entry's inject factory binds per session. */
export interface RollbackInjected {
  /** The live event window used to resolve the fork anchor at click time. */
  rollbackWindow: () => { entries: readonly RollbackEventView[]; hasMore: boolean }
  /** Fork at the anchor before `messageSeq`, open the child, seed its draft. */
  rollback: (messageSeq: number, text: string) => void
  /** Surface a composer notice when the rollback point cannot be resolved. */
  notifyRollbackBlocked: () => void
}

// ---------------------------------------------------------------------------
// Clock (ported from ui-chat's message-chrome: date-aware HH:mm labels)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function msUntilNextLocalMidnight(ms: number): number {
  const next = new Date(ms)
  next.setHours(24, 0, 0, 0)
  return Math.max(next.getTime() - ms, 1)
}

/** Local calendar-day epoch that re-fires after each local midnight. */
function useCalendarDay(): number {
  const [day, setDay] = useState(() => startOfLocalDay(Date.now()))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const arm = (): void => {
      const now = Date.now()
      setDay(startOfLocalDay(now))
      timer = setTimeout(arm, msUntilNextLocalMidnight(now))
    }
    timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()))
    return () => {
      clearTimeout(timer)
    }
  }, [])
  return day
}

/** Same calendar day → HH:mm; earlier this year → clock.md + clock; else clock.ymd + clock. */
function formatMessageClock(time: number, t: UserMessageTranslate, now: number = Date.now()): string {
  const d = new Date(time)
  const n = new Date(now)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return clock
  }
  const params = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }
  const md = d.getFullYear() === n.getFullYear() ? t('clock.md', params) : t('clock.ymd', params)
  return `${md} ${clock}`
}

// ---------------------------------------------------------------------------
// Content projection (ported from MessageItem's contentParts)
// ---------------------------------------------------------------------------

interface PresentedFile {
  name: string
  bytes: number
}

/** One presented attachment in source order (the shipped bubble interleaves). */
type PresentedAttachment =
  | { readonly type: 'image'; readonly image: { attachment: unknown } }
  | { readonly type: 'file'; readonly file: PresentedFile }

function contentParts(content: readonly unknown[]): {
  text: string
  attachments: PresentedAttachment[]
  rest: unknown[]
} {
  const attachments: PresentedAttachment[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    // Text blocks are joined once by userTextOf below (single join source —
    // duplicating it here drifted the rollback draft away from the copy action).
    if (b.type === 'text' && typeof b.text === 'string') continue
    if (b.type === 'image' && b.attachment !== undefined) attachments.push({ type: 'image', image: { attachment: b.attachment } })
    else if (b.type === 'file' && b.attachment !== undefined) attachments.push({ type: 'file', file: b.attachment as PresentedFile })
    else rest.push(block)
  }
  return { text: userTextOf(content), attachments, rest }
}

// ---------------------------------------------------------------------------
// Rollback icon: a curved undo arrow (the shared icon set has no undo glyph)
// ---------------------------------------------------------------------------

function IconRollback16() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 3.5 3 7l3.5 3.5M3 7h6a4 4 0 0 1 0 8H7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Actions row: clock, rollback, copy (ported IconActions + the new action)
// ---------------------------------------------------------------------------

function UserActions(props: {
  text: string
  time: number | undefined
  rollbackAvailable: boolean
  onRollback: () => void
  t: UserMessageTranslate
}) {
  const { t } = props
  const day = useCalendarDay()
  const reasonId = useId()
  const [copied, setCopied] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyEpoch = useRef(0)
  useEffect(() => () => {
    copyEpoch.current += 1
    copyPending.current = false
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])
  const onCopy = (): void => {
    if (copied || copyPending.current) return
    const epoch = copyEpoch.current
    copyPending.current = true
    void writeClipboard(props.text).then((ok) => {
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
  const clockEl = props.time === undefined ? null : (
    <span className={css.timeStart}>{formatMessageClock(props.time, t, day)}</span>
  )
  const rollbackLabel = props.rollbackAvailable ? t('message.rollback') : t('message.rollbackUnavailable')
  return (
    <div className={css.actions}>
      {clockEl}
      <Tooltip label={rollbackLabel} side="bottom">
        {/* aria-disabled keeps hover/focus events flowing so Tooltip can explain. */}
        <button
          type="button"
          className={css.action}
          aria-label={t('message.rollback')}
          aria-disabled={props.rollbackAvailable ? undefined : true}
          aria-describedby={props.rollbackAvailable ? undefined : reasonId}
          data-unavailable={props.rollbackAvailable ? undefined : true}
          onClick={props.rollbackAvailable ? props.onRollback : undefined}
        >
          <IconRollback16 />
        </button>
      </Tooltip>
      {!props.rollbackAvailable && <span id={reasonId} className={css.visuallyHidden}>{rollbackLabel}</span>}
      <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
        <button type="button" className={css.action} aria-label={copied ? t('copied') : t('copy')} onClick={onCopy}>
          {copied ? <IconCheckOutline /> : <IconCopyOutline />}
        </button>
      </Tooltip>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The bubble (ported UserStyleBubble) with the rollback-enabled actions row
// ---------------------------------------------------------------------------

export const OmUserMessageNodeView = memo(function OmUserMessageNodeView(
  props: UserMessageOwnerLike & RollbackInjected,
) {
  const { node, t } = props
  const data = node.data
  const { text, attachments, rest } = contentParts(data.content)
  const referenceLabels = data.referenceLabels ?? []
  const skillNames = data.skillNames ?? []
  const compactImages = attachments.length > 1
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0

  // text to restore, no attachments, and a completed earlier
  // turn to fork from (a turn-0 message has no rollback point).
  const turn = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn?.turn : undefined
  const rollbackAvailable = text !== '' && !hasAttachments(data.content) && turn !== undefined && turn > 0
  const onRollback = (): void => {
    // The anchor is resolved against the live event window at click time, not
    // render time: turn numbers guarantee existence, the window provides seqs.
    // data.seq is the durable user/message event seq (anchorSeq is a
    // flow-ordering value that may differ for presentation-frozen nodes).
    // The window is tail-anchored: scan first, because the anchor of any
    // recent message lives inside it even while older pages stay unloaded.
    const window = props.rollbackWindow()
    const anchor = findRollbackAnchor(window.entries, data.seq)
    if (anchor !== undefined) {
      props.rollback(anchor, text)
      return
    }
    // A miss with older pages still unloaded means the anchor likely sits in
    // one of them (say so on the composer instead of silently no-op'ing); a
    // miss on a fully loaded prefix means there is no earlier boundary,
    // which the turn gate should already have excluded.
    props.notifyRollbackBlocked()
  }

  return (
    <div className={css.userRow}>
      <div className={css.userStack}>
        {attachments.length > 0 && (
          <div className={css.attachmentRow} data-message-attachments>
            {attachments.map((attachment, index) => attachment.type === 'image'
              ? (
                <Fragment key={`image:${index}`}>
                  {props.renderMessageImages({ images: [attachment.image], align: 'end', compact: compactImages })}
                </Fragment>
              )
              : (
                <span key={`file:${index}`} className={css.fileCard} title={attachment.file.name}>
                  <FileTypeIcon path={attachment.file.name} className={css.fileIcon} />
                  <span className={css.fileContent}>
                    <span className={css.fileName}>{attachment.file.name}</span>
                    <span className={css.fileMeta}>
                      {[fileExtension(attachment.file.name).toUpperCase().slice(0, 8), fileSizeText(attachment.file.bytes)].filter(Boolean).join(' ')}
                    </span>
                  </span>
                </span>
              ))}
          </div>
        )}
        {showBubble && (
          <div className={css.bubble}>
            {/* Chip actions ride the optional fifth argument: on 0.1.7 the
                built-in bubble passes { openFile, openSkill }; on 0.1.5
                openSkill is absent and the host's 4-parameter copy ignores
                the argument entirely. */}
            {projectUserTextWithRefs(
              text,
              referenceLabels,
              skillNames,
              'skill',
              props.openSkill === undefined ? undefined : { openFile: props.openFile, openSkill: props.openSkill },
            )}
            {rest.map((block, i) => (
              <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />
            ))}
          </div>
        )}
        {referenceLabels.length > 0 && (
          <div className={css.referenceSummary}>
            {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
          </div>
        )}
      </div>
      <UserActions
        text={text}
        time={data.time}
        rollbackAvailable={rollbackAvailable}
        onRollback={onRollback}
        t={t}
      />
    </div>
  )
})
