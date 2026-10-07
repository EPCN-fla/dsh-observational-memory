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
 * composition entry; the harness's own configuration is never touched. Three
 * host windows (0.1.5 / 0.1.7 / 0.2.0 prerelease lines) are served from one
 * apply through two integration paths: DSH ≤0.1.5 edits the namespace
 * through the legacy settings section (`installSection`), DSH ≥0.1.7 edits
 * the profile-owned live configuration (volatile Config fields persisted in
 * the profile's cordis.patch.yml).
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: service merges for ctx.settings / ctx.agents / ctx.llm / ctx.sessions.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { Config, PlainConfig, SETTINGS_NAMESPACE, unwrapVolatileConfig } from './config.ts'
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

/**
 * The legacy settings-section face (DSH ≤0.1.5) the old path binds; removed
 * from the host in 0.1.7, detected by the presence of `installSection`.
 */
interface LegacySettingsSection {
  installSection(
    ctx: Context,
    namespace: string,
    schema: unknown,
    base: Config,
    hooks: { setSource: (source: () => Config) => void; onChange: () => void },
  ): void
}

export function apply(ctx: Context, config: Config): void {
  const runtime = new OmRuntime(config, {
    onError: (message) => ctx.logger.warn(message),
  })

  // The live-config source: the composition entry by itself until a settings
  // layer joins. On DSH ≥0.1.7 the entry's volatile fields are refs whose
  // get() tracks profile edits, so polling this source sees them; trigger
  // points poll through runtime.refreshConfig().
  let source: () => Config = () => config
  runtime.bindConfigSource(() => source())
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings as unknown as Partial<LegacySettingsSection> & {
      configure?: (presentation: { auto: boolean }, owner?: unknown) => () => void
    }
    if (typeof settings.installSection === 'function') {
      // DSH ≤0.1.5 — the legacy settings document: the composition entry is
      // the base layer; user edits apply live on top of it. The legacy host
      // machinery predates live references, so it gets the plain schema face
      // and the unwrapped composition value.
      settings.installSection(ctx, SETTINGS_NAMESPACE, PlainConfig, unwrapVolatileConfig(config), {
        setSource: (current) => {
          source = current
        },
        onChange: () => {
          // Same guard as refreshConfig: a schema-invalid edit must not
          // throw into the host's settings dispatch — keep the last good
          // epoch and log the rejection instead.
          try {
            runtime.setConfig(source())
          } catch (error) {
            ctx.logger.warn(`[observational-memory] rejected an invalid settings edit; keeping the previous values: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
      })
      return
    }
    // DSH ≥0.1.7 — profile-owned live configuration: claim the custom page
    // (the browser half renders it on the Plugins page) and let the host
    // persist edits into the profile patch. The old settings.yaml section is
    // imported into this entry automatically on first boot.
    if (typeof settings.configure === 'function') {
      settingsCtx.effect(() => settings.configure!({ auto: false }, ctx.fiber))
    }
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
