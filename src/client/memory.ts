/**
 * The Memory view tab's data controller: pulls the host-rendered reports
 * (`/om:status`, `/om:view`, debug-log tail) through the Connection RPC
 * channel and stages them in one snapshot store the slot component reads.
 *
 * Reports are pulled, not pushed: the tab fetches on mount and on explicit
 * refresh, so an idle session costs no polling.
 */

/** The slice of the Connection RPC caller this controller consumes. */
export interface ConnectionRpcLike {
  call(
    channel: '/api',
    endpoint: string,
    payload: unknown,
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string } }
  >
}

export type MemoryViewMode = 'visible' | 'full'

export interface OmMemoryState {
  /** First-load phase; later refreshes keep showing the previous text. */
  phase: 'loading' | 'ready' | 'error'
  statusText: string
  viewText: string
  viewMode: MemoryViewMode
  /** Debug-log recording switch on the host; the log section hides when off. */
  logsEnabled: boolean
  logsText: string
  /** Last failed refresh's message (kept visible alongside stale content). */
  error: string | undefined
  /** Epoch ms of the last successful refresh. */
  refreshedAt: number | undefined
  refreshing: boolean
  /** A manual "run now" consolidation pass is in flight on the host. */
  running: boolean
}

const INITIAL: OmMemoryState = {
  phase: 'loading',
  statusText: '',
  viewText: '',
  viewMode: 'visible',
  logsEnabled: false,
  logsText: '',
  error: undefined,
  refreshedAt: undefined,
  refreshing: false,
  running: false,
}

interface TextResult {
  text: string
}

interface LogsResult extends TextResult {
  enabled: boolean
}

interface RunResult {
  ran: boolean
}

function isTextResult(value: unknown): value is TextResult {
  return typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string'
}

function isLogsResult(value: unknown): value is LogsResult {
  return isTextResult(value) && typeof (value as { enabled?: unknown }).enabled === 'boolean'
}

function isRunResult(value: unknown): value is RunResult {
  return typeof value === 'object' && value !== null && typeof (value as { ran?: unknown }).ran === 'boolean'
}

export class OmMemoryController {
  private current: OmMemoryState = INITIAL
  private readonly listeners = new Set<() => void>()
  /** Bumps on every issued request so a late response never overwrites a newer one. */
  private generation = 0
  /**
   * Bumps on every issued run so only the latest run owns the `running`
   * flag. Separate from {@link generation}: a refresh interleaving a run
   * must not strand the flag (a stale run would return early and never
   * clear it), so runs guard on their own epoch.
   */
  private runEpoch = 0

  constructor(
    private readonly rpc: ConnectionRpcLike,
    private readonly sessionId: string,
  ) {}

  readonly getSnapshot = (): OmMemoryState => this.current

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(next: OmMemoryState): void {
    this.current = next
    for (const listener of [...this.listeners]) listener()
  }

  /** One RPC round whose failure throws the wire/business message. */
  private async fetch<T>(endpoint: string, request: Record<string, unknown>, guard: (value: unknown) => value is T): Promise<T> {
    const result = await this.rpc.call('/api', endpoint, { args: { request } })
    if (!result.ok) throw new Error(result.error.message)
    if (!guard(result.value)) throw new Error(`unexpected ${endpoint} response shape`)
    return result.value
  }

  /** Settle one report fetch into a tagged result instead of throwing. */
  private async attempt<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
    try {
      return { ok: true, value: await promise }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Pull all three reports; a partial failure keeps the sections that worked. */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    const mode = this.current.viewMode
    this.publish({ ...this.current, refreshing: true })
    const [status, view, logs] = await Promise.all([
      this.attempt(this.fetch('observationalMemory/status', { sessionId: this.sessionId }, isTextResult)),
      this.attempt(this.fetch('observationalMemory/view', { sessionId: this.sessionId, mode }, isTextResult)),
      this.attempt(this.fetch('observationalMemory/logs', { sessionId: this.sessionId }, isLogsResult)),
    ])
    if (generation !== this.generation) return
    const error = [status, view, logs].find((result) => !result.ok)
    this.publish({
      phase: status.ok || view.ok ? 'ready' : 'error',
      statusText: status.ok ? status.value.text : this.current.statusText,
      viewText: view.ok ? view.value.text : this.current.viewText,
      viewMode: mode,
      logsEnabled: logs.ok ? logs.value.enabled : this.current.logsEnabled,
      logsText: logs.ok ? logs.value.text : this.current.logsText,
      error: error && !error.ok ? error.message : undefined,
      refreshedAt: error === undefined ? Date.now() : this.current.refreshedAt,
      refreshing: false,
      running: this.current.running,
    })
  }

  /**
   * Force one consolidation pass on the host (`observationalMemory/run`),
   * then re-pull the reports so the tab reflects whatever it produced. This
   * is the proactive entry passive mode keeps: with background triggers off,
   * the user runs memory work explicitly from here.
   */
  async run(): Promise<void> {
    const epoch = ++this.runEpoch
    this.publish({ ...this.current, running: true, error: undefined })
    const run = await this.attempt(this.fetch('observationalMemory/run', { sessionId: this.sessionId }, isRunResult))
    // A newer run owns the flag now; its own settle path clears it.
    if (epoch !== this.runEpoch) return
    if (!run.ok) {
      this.publish({ ...this.current, running: false, error: run.message })
      return
    }
    // Re-pull whatever the run produced. refresh() keeps the flag (its
    // publishes spread/preserve `running`); the flip below is epoch-guarded,
    // never generation-guarded, so an interleaved refresh cannot strand it.
    await this.refresh()
    if (epoch !== this.runEpoch) return
    this.publish({ ...this.current, running: false })
  }

  /** Switch the `/om:view` projection and refetch just that section. */
  async setViewMode(mode: MemoryViewMode): Promise<void> {
    if (mode === this.current.viewMode) return
    const previousMode = this.current.viewMode
    const generation = ++this.generation
    this.publish({ ...this.current, viewMode: mode, refreshing: true })
    const view = await this.attempt(this.fetch('observationalMemory/view', { sessionId: this.sessionId, mode }, isTextResult))
    if (generation !== this.generation) return
    this.publish(view.ok
      ? { ...this.current, viewText: view.value.text, error: undefined, refreshing: false }
      // On failure keep the previous mode selected over its matching content:
      // a flipped label above stale text would misrepresent the scope.
      : { ...this.current, viewMode: previousMode, error: view.message, refreshing: false })
  }
}
