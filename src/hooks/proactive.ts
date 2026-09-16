/**
 * Proactive compaction trigger: when an agent settles idle and its measured
 * context pressure has reached the effective threshold, ask the mounted
 * compaction engine for an explicit idle compaction (`compactNow`, the same
 * entry the `/compact` command uses).
 *
 * The effective threshold comes from `resolveCompactAfterTokens`: the static
 * `compactAfterTokens` in calibrated mode, or `floor(contextWindow *
 * compactAfterTokensRatio)` against the session model's window in ratio
 * mode. Calibrated mode at `0` (default) disables the trigger: DSH's native
 * threshold-ratio policy already drives automatic compaction, and the memory
 * render rides whichever summarization call it makes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveCompactAfterTokens } from '../config.ts'
import type { OmRuntime } from '../runtime.ts'

/** Minimal measured-pressure shape of the token meter service. */
interface TokenMeterLike {
  measure(session: Agent['session']): { totalTokens: number }
}

/** Minimal idle-compaction face of the compaction engine service. */
interface CompactionLike {
  compactNow(agent: Agent, signal: AbortSignal): Promise<unknown>
}

/**
 * Minimal face of the agent-presets registry. Presets mount their compaction
 * engine behind an `isolate` realm, which is invisible to `agent.ctx.get()`
 * and the host plane; `serviceFor` is the supported read address for exactly
 * this case (a host-side request about one agent's mounted composition).
 */
interface AgentPresetsLike {
  serviceFor(agent: Agent, name: 'compaction'): CompactionLike | undefined
}

/** Resolve the agent's compaction engine across the preset isolation boundary. */
function compactionFor(ctx: Context, agent: Agent): CompactionLike | undefined {
  const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
  return presets?.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction') as CompactionLike | undefined
}

export function registerCompactionTrigger(ctx: Context, runtime: OmRuntime): void {
  /** Deferred compaction timers per session, cleared when the plugin unloads. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  ctx.effect(() => {
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const config = runtime.config
    runtime.debug(agent.session.id, 'compaction.status', {
      status,
      passive: config.passive,
      compactAfterTokens: config.compactAfterTokens,
      compactAfterTokensMode: config.compactAfterTokensMode,
      origin: agent.session.header.origin ?? null,
    })
    if (status !== 'idle') return
    if (config.passive) return
    // Calibrated mode at 0 disables the trigger; ratio mode derives a
    // positive threshold from the context window on its own.
    if (config.compactAfterTokens <= 0 && config.compactAfterTokensMode !== 'ratio') return
    if (agent.session.header.origin === 'subagent') return

    const sessionId: string = agent.session.id
    if (runtime.compactInFlight.has(sessionId)) return

    const tokenMeter = ctx.get('tokenMeter') as TokenMeterLike | undefined
    // The compaction engine lives in the agent preset's isolated realm:
    // invisible to agent.ctx.get() from outside the group, so resolve it
    // through the host-plane presets registry (serviceFor). Presets without
    // compaction (e.g. minimal) legitimately expose nothing — the trigger
    // stays quiet there.
    const compaction = compactionFor(ctx, agent)
    if (!tokenMeter || !compaction) {
      runtime.debug(sessionId, 'compaction.unavailable', {
        tokenMeter: tokenMeter !== undefined,
        compaction: compaction !== undefined,
      })
      return
    }

    // Claim the in-flight slot before the first await so back-to-back idle
    // events cannot trigger twice; the async flow owns the release.
    runtime.compactInFlight.add(sessionId)
    void (async () => {
      try {
        const contextWindow =
          config.compactAfterTokensMode === 'ratio'
            ? await runtime.sessionContextWindow(ctx, agent.session, agent)
            : undefined
        const threshold = resolveCompactAfterTokens(config, contextWindow)
        // Ratio mode with an unresolvable window cannot derive a threshold
        // (compactAfterTokens is inert there), so the trigger stays disabled.
        if (threshold <= 0) return

        let totalTokens: number
        try {
          totalTokens = tokenMeter.measure(agent.session).totalTokens
        } catch (error) {
          runtime.debug(sessionId, 'compaction.measure_failed', { error: String(error) })
          return
        }
        runtime.debug(sessionId, 'compaction.measure', { totalTokens, threshold })
        if (totalTokens < threshold) return

        runtime.debug(sessionId, 'compaction.trigger', { totalTokens, threshold })
        if (runtime.config.showWorkerNotifications) {
          ctx.logger.info(
            `[observational-memory] compaction threshold reached (~${totalTokens.toLocaleString()} estimated tokens); triggering compaction`,
          )
        }
        // Defer past the status dispatch, then re-verify idleness; compactNow
        // itself throws `busy` when the agent woke meanwhile. An unload-cleared
        // timer never resolves, abandoning the flow with the runtime.
        await new Promise<void>((resolve) => {
          timers.set(sessionId, setTimeout(resolve, 0))
        })
        timers.delete(sessionId)
        if (agent.status !== 'idle') return
        // Re-measure after the deferral (pi parity): a manual or native
        // compaction that completed in the gap drops pressure below the
        // threshold, and compactNow would force an unneeded second pass.
        let current: number
        try {
          current = tokenMeter.measure(agent.session).totalTokens
        } catch {
          return
        }
        if (current < threshold) {
          runtime.debug(sessionId, 'compaction.skipped', { totalTokens: current, threshold })
          return
        }
        await compaction.compactNow(agent, new AbortController().signal)
      } catch (error) {
        // 'busy' (the agent woke) and 'cancelled' (the session was disposed
        // mid-compaction) are normal races, not failures.
        const code = (error as { code?: unknown }).code
        if (code !== 'busy' && code !== 'cancelled') {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`[observational-memory] proactive compaction failed: ${message}`)
        }
      } finally {
        runtime.compactInFlight.delete(sessionId)
      }
    })()
  })
}
