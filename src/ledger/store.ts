/**
 * Plugin-owned ledger persistence: one append-only JSONL file per session
 * under the configured storage root (default `$DSH_HOME/observational-memory`).
 *
 * The session log itself is deliberately NOT used: DSH persists only events
 * in its build-generated vocabulary, and `Session.append()` cannot mark
 * external events `ignorable`, so plugin-typed session events would make
 * sessions fail to reload. A sidecar store keeps memory durable without
 * touching the session log.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isLedgerEntry, type LedgerEntry } from './types.ts'

export type LedgerStoreOptions = {
  /** Called with I/O and parse diagnostics; must never throw. */
  onError?: (message: string) => void
}

/** Sanitize a session id into a safe single-component file name. */
export function ledgerFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, (ch) => `_${ch.codePointAt(0)?.toString(16)}_`)
  return `${safe}.jsonl`
}

export class LedgerStore {
  private readonly cache = new Map<string, LedgerEntry[]>()
  private readonly loading = new Map<string, Promise<LedgerEntry[]>>()
  private readonly tails = new Map<string, Promise<void>>()
  private ready = false

  constructor(
    private readonly rootDir: string,
    private readonly options: LedgerStoreOptions = {},
  ) {}

  /** Ensure the storage root exists. Idempotent; called lazily on first write. */
  private async ensureRoot(): Promise<void> {
    if (this.ready) return
    await mkdir(this.rootDir, { recursive: true })
    this.ready = true
  }

  private path(sessionId: string): string {
    return join(this.rootDir, ledgerFileName(sessionId))
  }

  /**
   * Load (and cache) a session's ledger. Missing files yield an empty ledger;
   * unparseable or invalid lines are skipped with a diagnostic.
   *
   * An absent file is NOT cached: the memory tab's view/logs endpoints accept
   * arbitrary session ids, and caching every probed id would grow the cache
   * without bound. `append` installs the cache entry itself before pushing.
   */
  async load(sessionId: string): Promise<LedgerEntry[]> {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    const pending = this.loading.get(sessionId)
    if (pending) return pending

    const task = (async (): Promise<LedgerEntry[]> => {
      let text: string
      try {
        text = await readFile(this.path(sessionId), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Absent file = empty ledger; the deduped `loading` promise keeps
          // concurrent loads sharing this one array.
          return []
        }
        // Transient read failures are NOT cached as empty: that would hide a
        // non-empty on-disk ledger and make later appends diverge from disk.
        this.options.onError?.(`failed to read ledger for session ${sessionId}: ${String(error)}`)
        return this.cache.get(sessionId) ?? []
      }
      const entries: LedgerEntry[] = []
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (isLedgerEntry(parsed)) {
            entries.push(parsed)
          } else {
            this.options.onError?.(`session ${sessionId}: skipping invalid ledger record`)
          }
        } catch {
          this.options.onError?.(`session ${sessionId}: skipping unparseable ledger line`)
        }
      }
      this.cache.set(sessionId, entries)
      return entries
    })()

    this.loading.set(sessionId, task)
    try {
      return await task
    } finally {
      this.loading.delete(sessionId)
    }
  }

  /** In-memory snapshot; empty until `load` has resolved for the session. */
  entries(sessionId: string): readonly LedgerEntry[] {
    return this.cache.get(sessionId) ?? []
  }

  /**
   * Append one record, updating the cache first and persisting on the
   * session's serialized write chain. Persistence failures are reported and
   * swallowed: memory work must never break the session pipeline, and the
   * in-memory copy keeps the current process consistent.
   */
  async append(sessionId: string, entry: LedgerEntry): Promise<void> {
    const entries = await this.load(sessionId)
    // A first-ever write follows an uncached ENOENT load: install the shared
    // array before pushing so later loads see the in-memory copy.
    if (!this.cache.has(sessionId)) this.cache.set(sessionId, entries)
    entries.push(entry)
    const line = `${JSON.stringify(entry)}\n`
    const tail = this.tails.get(sessionId) ?? Promise.resolve()
    const next = tail.then(async () => {
      try {
        await this.ensureRoot()
        await appendFile(this.path(sessionId), line, 'utf8')
      } catch (error) {
        this.options.onError?.(`failed to persist ledger for session ${sessionId}: ${String(error)}`)
      }
    })
    this.tails.set(sessionId, next)
    return next
  }

  /** Await every pending write (used on session dispose and in tests). */
  async flush(): Promise<void> {
    await Promise.all([...this.tails.values()])
  }

  /** Drop the cached copy; the next load re-reads from disk. */
  evict(sessionId: string): void {
    this.cache.delete(sessionId)
  }
}
