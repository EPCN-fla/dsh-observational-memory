/**
 * Heuristic token accounting (~4 chars/token). Memory scheduling and pool
 * budgets all use this local estimate; it deliberately never depends on a
 * provider's own accounting.
 */

/** Rough token estimate for a plain string. */
export function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Estimated rendered footprint of an observation line as it appears in
 * summaries and pool listings: "[id] YYYY-MM-DD HH:MM [relevance] content".
 * Pool budgets count the full rendered line (not bare content) so the
 * configured pool target matches what future contexts actually carry.
 */
export function observationLineTokenCount(observation: {
  id: string
  timestamp: string
  relevance: string
  content: string
}): number {
  return estimateStringTokens(
    `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`,
  )
}
