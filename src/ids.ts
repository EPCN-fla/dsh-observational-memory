import { createHash } from 'node:crypto'

/**
 * Deterministic 12-character lowercase hex memory id derived from content.
 * Same content → same id, which makes re-recorded duplicates collapse.
 */
export function hashId(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}
