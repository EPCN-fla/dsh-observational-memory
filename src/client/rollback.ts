/**
 * Rollback (回退) logic for user messages: rolling back to a message means
 * forking the session at the completed-turn boundary right before it (a
 * session can only be cut at a `turn/end`) and restoring the message text
 * into the new branch's composer, so the user can edit and resend. 
 * Non-destructive: the source session keeps its history on its own branch.
 */

/** The event slice rollback needs from the client session event window. */
export interface RollbackEventView {
  seq: number
  type: string
}

/**
 * The fork anchor for rolling back to just before `messageSeq`: the seq of
 * the last `turn/end` strictly before the message. Undefined when the message
 * belongs to the first completed turn — DSH cannot fork an empty prefix, so
 * the first user message has no rollback point.
 */
export function findRollbackAnchor(
  events: readonly RollbackEventView[],
  messageSeq: number,
): number | undefined {
  let anchor: number | undefined
  for (const event of events) {
    if (event.seq >= messageSeq) break
    if (event.type === 'turn/end') anchor = event.seq
  }
  return anchor
}

type ContentBlockView = { type?: string; text?: string }

/**
 * The plain text a rollback restores into the composer: the message's text
 * blocks joined, matching what the copy action writes.
 */
export function userTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as ContentBlockView[])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

/**
 * Whether the message carries image/file attachments. Rolling back restores
 * text only (a draft cannot reattach uploaded objects), so attachment-bearing
 * messages stay rollback-disabled.
 */
export function hasAttachments(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return (content as ContentBlockView[]).some((block) => block?.type === 'image' || block?.type === 'file')
}

/** Client session operations needed to create and restore one rollback branch. */
export interface RollbackSessions {
  fork(opts: {
    sessionId: string
    atSeq: number
    increaseTitle: true
    onCreated?: (childId: string) => void
  }): Promise<string>
  /** Establish the child scope before the composer binds (DSH 0.2.1). */
  retainAgentScope?(id: string): { release(): void }
  scope(id: string): unknown
  open(id: string): void
}

/**
 * Fork and restore a rollback draft without silently losing it. New hosts
 * require an explicit retain before scope() can succeed; older hosts may
 * already expose the scope after fork, or only after open.
 */
export async function forkRollbackSession(
  sessions: RollbackSessions,
  sessionId: string,
  anchorSeq: number,
  text: string,
  restoreDraft: (scope: unknown, text: string) => void,
  notify: (failure: 'fork' | 'restore') => void,
): Promise<void> {
  let createdChildId: string | undefined
  let childId: string
  try {
    childId = await sessions.fork({
      sessionId,
      atSeq: anchorSeq,
      increaseTitle: true,
      onCreated: id => { createdChildId = id },
    })
  } catch {
    // A title rename can fail after the Host already created the child. In
    // that case continue opening/restoring that child instead of reporting
    // that no fork exists and inviting the user to create another one.
    if (createdChildId === undefined) {
      notify('fork')
      return
    }
    childId = createdChildId
  }

  let reference: { release(): void } | undefined
  try {
    reference = sessions.retainAgentScope?.(childId)
    let scope = sessions.scope(childId)
    let opened = false
    if (scope === undefined && reference === undefined) {
      // Legacy fallback: open establishes the retained generation. Current
      // hosts take the retain-first path so the draft exists before binding.
      sessions.open(childId)
      opened = true
      scope = sessions.scope(childId)
    }
    if (scope === undefined) throw new Error('rollback child scope is unavailable')
    restoreDraft(scope, text)
    if (!opened) sessions.open(childId)
  } catch {
    notify('restore')
  } finally {
    reference?.release()
  }
}
