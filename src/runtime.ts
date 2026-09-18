/**
 * Shared plugin runtime: effective config, the ledger store, per-session
 * in-flight guards, worker error memory, and worker-model resolution.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from './home.ts'
import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import { DebugLog } from './debug-log.ts'
import { LedgerStore } from './ledger/store.ts'
import type { WorkerModelTarget } from './workers/observer.ts'

export type WorkerPhase = 'observer' | 'reflector' | 'dropper'

export type ResolveResult =
  | { ok: true; target: WorkerModelTarget; contextWindow?: number }
  | { ok: false; reason: string }

/** Deliberate-empty observer backoff state for one session. */
export type EmptyBackoff = {
  coverageSeq: number
  tokensAtEmpty: number
}

/** Storage root for ledgers and debug logs. */
export function storageRoot(config: ResolvedConfig): string {
  const configured = config.storageDir
  if (typeof configured === 'string' && configured.trim().length > 0) return configured
  return resolveDshHome('observational-memory')
}

export class OmRuntime {
  private _config: ResolvedConfig
  private _store: LedgerStore
  private readonly onError: (message: string) => void
  private debugLog: DebugLog | undefined
  private debugLogRoot: string | undefined

  /** Sessions with a consolidation pipeline currently running. */
  readonly consolidationInFlight = new Set<string>()
  /** Sessions with a proactive compaction currently in flight. */
  readonly compactInFlight = new Set<string>()

  readonly lastObserverError = new Map<string, string>()
  readonly lastReflectorError = new Map<string, string>()
  readonly lastDropperError = new Map<string, string>()
  readonly observerEmptyBackoff = new Map<string, EmptyBackoff>()
  /** Sessions already notified about model resolution failure (notify once). */
  readonly resolveFailureNotified = new Set<string>()
  /** Consecutive deliberate-empty observer verdicts per session (warns from the 2nd on). */
  readonly observerConsecutiveEmpties = new Map<string, number>()

  constructor(initialConfig: Config, hooks: { onError: (message: string) => void }) {
    this._config = resolveConfig(initialConfig)
    this.onError = hooks.onError
    this._store = new LedgerStore(storageRoot(this._config), { onError: this.onError })
  }

  /** Effective config: composition entry overlaid with user settings. */
  get config(): ResolvedConfig {
    return this._config
  }

  get store(): LedgerStore {
    return this._store
  }

  /** Swap in a new effective config, re-rooting the store when it moved. */
  setConfig(config: Config): void {
    const previousRoot = storageRoot(this._config)
    const next = resolveConfig(config)
    const nextRoot = storageRoot(next)
    this._config = next
    if (nextRoot !== previousRoot) {
      this._store = new LedgerStore(nextRoot, { onError: this.onError })
    }
  }

  recordStageError(sessionId: string, phase: WorkerPhase, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    if (phase === 'observer') this.lastObserverError.set(sessionId, message)
    if (phase === 'reflector') this.lastReflectorError.set(sessionId, message)
    if (phase === 'dropper') this.lastDropperError.set(sessionId, message)
    return message
  }

  /** One more consecutive deliberate-empty observer verdict; returns the streak. */
  noteObserverEmpty(sessionId: string): number {
    const streak = (this.observerConsecutiveEmpties.get(sessionId) ?? 0) + 1
    this.observerConsecutiveEmpties.set(sessionId, streak)
    return streak
  }

  /** Reset the empty-verdict streak after an observer run that recorded. */
  clearObserverEmpties(sessionId: string): void {
    this.observerConsecutiveEmpties.delete(sessionId)
  }

  /** Write one debug event when `debugLog` is enabled; otherwise a no-op. */
  debug(sessionId: string, event: string, data: Record<string, unknown> = {}): void {
    if (!this._config.debugLog) return
    const root = storageRoot(this._config)
    if (!this.debugLog || this.debugLogRoot !== root) {
      this.debugLog = new DebugLog(root, this.onError)
      this.debugLogRoot = root
    }
    this.debugLog.log(sessionId, event, data)
  }

  clearStageErrors(sessionId: string): void {
    this.lastObserverError.delete(sessionId)
    this.lastReflectorError.delete(sessionId)
    this.lastDropperError.delete(sessionId)
  }

  /**
   * Drop every per-session runtime entry when a session leaves the store, so
   * long-lived hosts do not accumulate one row per session id. The durable
   * ledger on disk is untouched.
   */
  clearSession(sessionId: string): void {
    this.clearStageErrors(sessionId)
    this.observerEmptyBackoff.delete(sessionId)
    this.resolveFailureNotified.delete(sessionId)
    this.observerConsecutiveEmpties.delete(sessionId)
    this.compactInFlight.delete(sessionId)
    this.consolidationInFlight.delete(sessionId)
  }

  /**
   * The session model's context window, for the ratio-mode compaction
   * threshold. Unlike {@link resolveModel} this never applies the configured
   * worker-model override: compaction guards the session's own context.
   * Resolution failure is not an error here — the ratio fallback covers it.
   */
  async sessionContextWindow(ctx: Context, session: Session, agent: Agent | undefined): Promise<number | undefined> {
    const routed = session.requestHeader()?.config
    const target =
      routed && routed.provider.length > 0 && routed.model.length > 0
        ? { provider: routed.provider, model: routed.model }
        : agent && agent.options.provider && agent.options.model
          ? { provider: agent.options.provider, model: agent.options.model }
          : defaultSelection(ctx)
    if (!target) return undefined
    try {
      const info = await ctx.llm.resolveModelInfo(target.provider, target.model)
      return info.context?.contextWindow
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the model memory workers call: the configured override when it
   * names a registered route, else the session's durably routed request
   * target, else the live agent's options, else the global default model
   * selection.
   */
  async resolveModel(ctx: Context, session: Session, agent: Agent | undefined): Promise<ResolveResult> {
    const configured = this._config.model
    const routed = session.requestHeader()?.config
    const fallback =
      routed && routed.provider.length > 0 && routed.model.length > 0
        ? { provider: routed.provider, model: routed.model, reasoningEffort: routed.reasoningEffort }
        : agent && agent.options.provider && agent.options.model
          ? { provider: agent.options.provider, model: agent.options.model, reasoningEffort: agent.options.reasoningEffort }
          : defaultSelection(ctx)

    const target = configured
      ? { provider: configured.provider, model: configured.id, reasoningEffort: configured.reasoningEffort }
      : fallback
    if (!target) {
      return {
        ok: false,
        reason: 'no model available (session has no routed model and no observational-memory model is configured)',
      }
    }

    try {
      const info = await ctx.llm.resolveModelInfo(target.provider, target.model)
      return { ok: true, target, contextWindow: info.context?.contextWindow }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!configured || !fallback) return { ok: false, reason: message }
      // A configured override that does not resolve falls back to the
      // session/default target rather than disabling memory work.
      this.onError(
        `observational-memory: configured model ${configured.provider}/${configured.id} is unavailable (${message}); falling back`,
      )
      try {
        const info = await ctx.llm.resolveModelInfo(fallback.provider, fallback.model)
        return { ok: true, target: fallback, contextWindow: info.context?.contextWindow }
      } catch (fallbackError) {
        return { ok: false, reason: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) }
      }
    }
  }
}

/** The deployment's default model selection, when the service is mounted. */
function defaultSelection(
  ctx: Context,
): { provider: string; model: string; reasoningEffort?: string } | undefined {
  try {
    const service = ctx.get('agentDefaultModel') as
      | { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
      | undefined
    const selection = service?.currentSelection()
    if (selection && selection.provider.length > 0 && selection.model.length > 0) return selection
  } catch {
    // Treat a failing read as absent; resolution reports the final failure.
  }
  return undefined
}
