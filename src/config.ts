/**
 * Plugin configuration: one Schemastery schema shared by the cordis
 * composition entry (`config:` in cordis.yml) and the user-editable settings
 * namespace `observational-memory` (Settings → Plugins → Plugin
 * configuration). The namespace keeps user overrides in the DSH user settings
 * document under their own top-level key — the harness's own composition is
 * never touched.
 *
 * Following the harness idiom, {@link Config} is the schema INPUT type (all
 * fields optional); {@link resolveConfig} applies schema defaults to produce
 * the {@link ResolvedConfig} the runtime consumes.
 */
import z from '@deepseek-ai/schemastery'

export const SETTINGS_NAMESPACE = 'observational-memory'

/** Optional memory-worker model override. Defaults to the session's routed model. */
export interface ConfiguredModel {
  provider: string
  id: string
  reasoningEffort?: string
}

/**
 * How `compactAfterTokens` is interpreted.
 *
 * The settings card shows only the parameter the selected mode consumes;
 * the hidden one is inert no matter what it is set to.
 *
 * - `"calibrated"` (default): use the static `compactAfterTokens` value
 *   directly; `compactAfterTokensRatio` is ignored. Backwards-compatible
 *   with all existing configs.
 *
 * - `"ratio"`: compute the effective threshold as
 *   `floor(model.contextWindow * compactAfterTokensRatio)`;
 *   `compactAfterTokens` is ignored. This auto-scales the proactive
 *   compaction trigger to the session model's context window, so a
 *   1M-context model is not preempted at the same fixed threshold as a
 *   128K model. Some models advertise a large window but lose attention at
 *   long range; lower `compactAfterTokensRatio` to compact earlier on such
 *   models without giving up the window on models that stay sharp.
 *
 *   When the session model's `contextWindow` is unavailable (undefined, 0
 *   or negative), or the ratio itself is not strictly between 0 and 1, the
 *   threshold cannot be derived and the trigger stays disabled (0) — it
 *   does NOT fall back to `compactAfterTokens`, which is inert in this
 *   mode.
 *
 *   Note: ratio mode ignores `compactAfterTokens: 0` whenever a context
 *   window resolves — the derived threshold is always positive, so setting
 *   the mode to `"ratio"` enables the trigger by itself.
 */
export type CompactAfterTokensMode = 'calibrated' | 'ratio'

/** Schema input type: every field optional; defaults live on the schema. */
export interface Config {
  /** Raw/source token threshold for observer runs. */
  observeAfterTokens?: number
  /** Raw/source token threshold for reflection runs; successful reflection can trigger the dropper. */
  reflectAfterTokens?: number
  /**
   * Consecutive worker-run failures after which a configured model override is
   * suspended and workers fall back to the session model; 0 disables the
   * fallback. Inert without a configured override (workers already use the
   * session model). A config change or session reload restarts the count.
   */
  modelFallbackAfterFailures?: number
  /**
   * Max estimated tokens serialized into one observer chunk. Unset derives
   * from the resolved memory model's context window (20%, min 256, fallback
   * 60,000).
   */
  observerChunkMaxTokens?: number
  /**
   * Proactive compaction trigger: compact an idle session when its measured
   * context pressure reaches this many estimated tokens. `0` (default)
   * disables the trigger and lets DSH's native compaction policy drive.
   * Effective only in `"calibrated"` mode; inert in `"ratio"` mode.
   */
  compactAfterTokens?: number
  /** How `compactAfterTokens` is interpreted; see {@link CompactAfterTokensMode}. */
  compactAfterTokensMode?: CompactAfterTokensMode
  /** Window fraction used in `"ratio"` mode; strictly between 0 and 1. Inert in `"calibrated"` mode. */
  compactAfterTokensRatio?: number
  /** Observation-token budget for compaction full-fold pressure. */
  observationsPoolMaxTokens?: number
  /** Active-observation pool target maintained by the dropper. Defaults to half of max. */
  observationsPoolTargetTokens?: number
  /** Shared turn cap for background memory-worker loops. */
  agentMaxTurns?: number
  /** Memory-worker model override. */
  model?: ConfiguredModel
  /** Log observer/reflector/dropper progress lines (warnings and errors always log). */
  showWorkerNotifications?: boolean
  /** Disable proactive background observation, reflection, maintenance and compaction triggers. */
  passive?: boolean
  /** Write per-session worker debug events as NDJSON under the storage dir. */
  debugLog?: boolean
  /** Ledger storage root. Default: `$DSH_HOME/observational-memory`. */
  storageDir?: string
}

/** Runtime shape after schema defaults are applied. */
export interface ResolvedConfig {
  observeAfterTokens: number
  reflectAfterTokens: number
  modelFallbackAfterFailures: number
  observerChunkMaxTokens?: number
  compactAfterTokens: number
  compactAfterTokensMode: CompactAfterTokensMode
  compactAfterTokensRatio: number
  observationsPoolMaxTokens: number
  observationsPoolTargetTokens?: number
  agentMaxTurns: number
  model?: ConfiguredModel
  showWorkerNotifications: boolean
  passive: boolean
  debugLog: boolean
  storageDir?: string
}

const modelSchema = z.object({
  provider: z.string().required(),
  id: z.string().required(),
  reasoningEffort: z.string(),
})

/**
 * The field dictionary, shared by both schema faces below. Every field is
 * editable from the plugin's settings card.
 */
const fields = {
  observeAfterTokens: z.number().step(1).min(1).default(10_000),
  reflectAfterTokens: z.number().step(1).min(1).default(20_000),
  modelFallbackAfterFailures: z.number().step(1).min(0).default(0),
  observerChunkMaxTokens: z.number().step(1).min(256),
  compactAfterTokens: z.number().step(1).min(0).default(0),
  compactAfterTokensMode: z.union(['calibrated', 'ratio'] as const).default('calibrated'),
  // The schema bounds are inclusive; the resolver additionally rejects the
  // endpoints (a ratio of 0 never triggers, 1 leaves no room for a response).
  compactAfterTokensRatio: z.number().min(0).max(1).default(0.68),
  observationsPoolMaxTokens: z.number().step(1).min(1).default(20_000),
  observationsPoolTargetTokens: z.number().step(1).min(1),
  agentMaxTurns: z.number().step(1).min(1).default(16),
  // An absent model override must stay absent: schemastery objects resolve
  // even when the key is missing, so an `undefined` default marks it optional
  // (cast: `default(value: T)` predates optional objects).
  model: modelSchema.default(undefined as never),
  showWorkerNotifications: z.boolean().default(true),
  passive: z.boolean().default(false),
  debugLog: z.boolean().default(false),
  storageDir: z.string(),
}

/**
 * The composition-entry schema. Every editable field carries `.volatile()`:
 * on DSH ≥0.1.7 that is what exposes the entry to the profile-owned settings
 * transport (values persist in the profile's cordis.patch.yml and apply
 * live). Calling a volatile-marked schema returns live references, so this
 * face is ONLY for the host's entry machinery — plugin code resolves values
 * through {@link PlainConfig} and unwraps with {@link unwrapVolatileConfig}.
 * `.volatile()` needs schemastery ≥3.18.4; the dependency floor in
 * package.json guarantees it on either host generation (older hosts' cordis
 * ignores the mark beyond the wrapping we unwrap ourselves).
 */
export const Config = z.object(
  Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.volatile()]) as never),
) as unknown as z<Config>

/**
 * The plain-value schema face: same fields without the volatile mark, so
 * calling it yields plain values under every supported schemastery. Used by
 * {@link resolveConfig} and by the legacy (DSH ≤0.1.5) settings section,
 * whose host machinery predates live references.
 */
// Cast: with a mixed schemastery installation (e.g. a 0.1.5-rc.3 host pinning
// 3.18.2 beside this plugin's 3.18.4) the two copies' Schema declarations
// defeat the object-literal inference; the annotation above already names the
// intended input shape.
export const PlainConfig: z<Config> = z.object(fields) as z<Config>

/**
 * Minimal shape of the live-configuration reference DSH ≥0.1.7 hands each
 * volatile Config field (cosmokit's `Volatile<T>`; declared locally because
 * the type only exists in cordis ≥4.0.4, newer than the oldest supported
 * host).
 */
export interface VolatileRef<T> {
  get(): T
}

function isVolatileRef(value: unknown): value is VolatileRef<unknown> {
  return typeof value === 'object' && value !== null
    && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Project the composition value the host passed to `apply` into the plain
 * input shape the schema parses: on DSH ≥0.1.7 each volatile field arrives as
 * a {@link VolatileRef} whose `get()` reads the current live value; on older
 * hosts every field is already plain and the projection is an identity.
 * Only top-level fields unwrap — a nested object (the model override) is one
 * whole ref when volatile, never a partial one.
 */
export function unwrapVolatileConfig(config: Config): Config {
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    plain[key] = isVolatileRef(value) ? value.get() : value
  }
  return plain as Config
}

/** Apply schema defaults to a partial composition/settings value. */
export function resolveConfig(config: Config): ResolvedConfig {
  // Live-config references unwrap before the schema sees the value: a
  // VolatileRef is not a valid schema input for its field. The plain face
  // resolves defaults without re-wrapping the result. The z<Config> typing
  // names the plain input shape, so the cast projects to the resolved shape.
  return PlainConfig(unwrapVolatileConfig(config)) as ResolvedConfig
}

/**
 * Resolve the effective proactive-compaction token threshold for the given
 * config and the session model's context window. Only the parameter the
 * selected mode consumes is read; the other is inert however it is set.
 *
 * In `"calibrated"` mode this is always `config.compactAfterTokens`.
 *
 * In `"ratio"` mode this is `floor(contextWindow * compactAfterTokensRatio)`
 * (clamped to a minimum of 1) when `contextWindow` is a positive number and
 * the ratio is strictly between 0 and 1. Otherwise the threshold cannot be
 * derived and the trigger is disabled (0) — `compactAfterTokens` is inert
 * in ratio mode, so there is no calibrated fallback.
 */
export function resolveCompactAfterTokens(config: ResolvedConfig, contextWindow: number | undefined): number {
  if (config.compactAfterTokensMode !== 'ratio') {
    return config.compactAfterTokens
  }
  const ratio = config.compactAfterTokensRatio
  if (
    typeof contextWindow === 'number'
    && Number.isFinite(contextWindow)
    && contextWindow > 0
    && Number.isFinite(ratio)
    && ratio > 0
    && ratio < 1
  ) {
    return Math.max(1, Math.floor(contextWindow * ratio))
  }
  return 0
}

/** Observer chunk cap when no config is set and the model's context window is unknown. */
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000

/** Smallest useful observer chunk: labels, omission markers and some source context. */
export const OBSERVER_CHUNK_MIN_TOKENS = 256

/**
 * Fraction of the memory model's context window used for the derived observer
 * chunk cap. Chunk sizes are estimates (~4 chars/token), which can undercount
 * real tokens on non-ASCII content; 0.2 keeps even the worst case well inside
 * the window with room for the system prompt, prior memory and the response.
 */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2

/**
 * Resolve the maximum estimated tokens serialized into one observer chunk.
 * An explicit config value always wins; otherwise derive from the resolved
 * memory model's context window, falling back when it is unknown. Without a
 * cap, an overgrown backlog makes every observer call fail and coverage never
 * advances.
 */
export function resolveObserverChunkMaxTokens(config: ResolvedConfig, contextWindow: number | undefined): number {
  if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
    return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens)
  }
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.max(OBSERVER_CHUNK_MIN_TOKENS, Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO))
  }
  return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS
}

/** Active-observation pool target: explicit config, else half of the max budget. */
export function resolveObservationsPoolTargetTokens(config: ResolvedConfig): number {
  const configured = config.observationsPoolTargetTokens
  if (configured !== undefined && configured > 0 && configured < config.observationsPoolMaxTokens) {
    return configured
  }
  return Math.floor(config.observationsPoolMaxTokens / 2)
}
