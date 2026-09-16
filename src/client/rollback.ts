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
