/**
 * dsh-observational-memory — host half.
 *
 * Background memory workers (observer → reflector → dropper) distill the
 * session into a plugin-owned per-session ledger while the agent works; when
 * DSH compacts, the rendered memory projection answers the summarization call
 * (no model round-trip). The `recall` tool recovers exact source evidence
 * behind any memory id.
 *
 * Configuration lives in the `observational-memory` settings namespace
 * (Settings → Plugins → Plugin configuration), layered over the cordis
 * composition entry; the harness's own configuration is never touched.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: service merges for ctx.settings / ctx.agents / ctx.llm / ctx.sessions.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { Config, SETTINGS_NAMESPACE } from './config.ts'
import { OmRuntime } from './runtime.ts'
import { OmApiService } from './api.ts'
import { registerCompactionHook } from './hooks/compaction.ts'
import { registerConsolidationTrigger } from './hooks/consolidation.ts'
import { registerCompactionTrigger } from './hooks/proactive.ts'
import { registerRecallTool } from './tools/recall.ts'

export const name = 'observational-memory'
export const inject = ['llm', 'tools', 'sessions', 'agents']

export { Config, SETTINGS_NAMESPACE }
export type { Config as ConfigShape } from './config.ts'

export function apply(ctx: Context, config: Config): void {
  const runtime = new OmRuntime(config, {
    onError: (message) => ctx.logger.warn(message),
  })

  // Settings section: the composition entry is the base layer; user edits in
  // the settings document apply live on top of it.
  let source: () => Config = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: (current) => {
        source = current
      },
      onChange: () => {
        runtime.setConfig(source())
      },
    })
  })

  registerConsolidationTrigger(ctx, runtime)
  registerCompactionHook(ctx, runtime)
  registerCompactionTrigger(ctx, runtime)
  registerRecallTool(ctx, runtime)

  // Typert Remote endpoints feeding the browser Memory tab (`/om:status`,
  // `/om:view` and debug-log tails). With no API Gateway mounted (headless
  // runs) the service simply never gets called.
  ctx.plugin(OmApiService, runtime)
}
