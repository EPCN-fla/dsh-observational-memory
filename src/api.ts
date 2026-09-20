/**
 * The plugin's Typert Remote face: unary endpoints the browser Memory tab
 * calls through the API Gateway (`POST /api/observationalMemory/<method>`).
 *
 * `/om:status` and `/om:view` exist in the pi reference as interactive slash
 * commands; DSH surfaces their content in the conversation's Memory view tab
 * instead, so these endpoints return the rendered report text. Debug logs
 * (written when `debugLog` is on) are returned as a bounded tail, and `run`
 * backs the tab's manual "run now" consolidation action.
 */
import { open } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { debugLogPath } from './debug-log.ts'
import { runConsolidationNow } from './hooks/consolidation.ts'
import { buildStatusText, buildViewText, type ViewMode } from './report.ts'
import { storageRoot, type OmRuntime } from './runtime.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'observational-memory/session-unavailable': { readonly sessionId: string }
  }
}

/** Minimal measured-pressure shape of the token meter service. */
interface TokenMeterLike {
  measure(session: { id: string } & object): { totalTokens: number }
}

export interface OmSessionRequest {
  sessionId: string
}

export interface OmViewRequest extends OmSessionRequest {
  mode?: ViewMode
}

export interface OmLogsRequest extends OmSessionRequest {
  /** Tail bound; defaults to {@link DEFAULT_LOG_LINES}. */
  maxLines?: number
}

export interface OmTextValue {
  text: string
}

export interface OmLogsValue extends OmTextValue {
  /** Whether debugLog recording is on; when off there is never text. */
  enabled: boolean
}

export interface OmRunValue {
  /** Whether this call ran the pipeline (false: busy, or not a memory session). */
  ran: boolean
}

/** Bounded log tail: enough for a debugging session, small enough for RPC. */
export const DEFAULT_LOG_LINES = 200
export const MAX_LOG_LINES = 1000
/** Read window for tail extraction; lines beyond it stay unread on disk. */
const LOG_TAIL_BYTES = 256 * 1024

/**
 * The last `bound` NDJSON lines without reading the whole file: debug logs
 * are append-only and unrotated, so a naive readFile would pull megabytes
 * through every tab refresh.
 */
async function readLogTail(path: string, bound: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, LOG_TAIL_BYTES)
    const start = size - length
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      // The window likely opens mid-line; drop the partial first line.
      const firstNewline = text.indexOf('\n')
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
    }
    const lines = text.split('\n').filter((line) => line.length > 0)
    return lines.slice(-bound).join('\n')
  } finally {
    await handle.close()
  }
}

function sessionIdOf(request: OmSessionRequest): SessionId {
  if (typeof request?.sessionId !== 'string' || request.sessionId.length === 0) {
    throw new RemoteError('gateway/bad-request', 'sessionId must be a non-empty string', {})
  }
  return request.sessionId as SessionId
}

/** Attached session, or a domain error the tab renders as-is. */
function attachedSession(ctx: Context, sessionId: SessionId) {
  const session = ctx.sessions.get(sessionId)
  if (!session) {
    throw new RemoteError(
      'observational-memory/session-unavailable',
      `session "${sessionId}" is not attached; open it to inspect its memory`,
      { sessionId },
    )
  }
  return session
}

export class OmApiService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly runtime: OmRuntime,
  ) {
    super(ctx, 'observationalMemory', { namespace: 'observationalMemory' })
  }

  /** `/om:status` content for one attached session. */
  @Remote('status')
  // `signal` is the SRC transport-cancellation parameter (final position).
  async status(request: OmSessionRequest, signal?: AbortSignal): Promise<OmTextValue> {
    const sessionId = sessionIdOf(request)
    const session = attachedSession(this.ctx, sessionId)
    await this.runtime.ensureInherited(this.ctx, session)
    const agent = this.ctx.agents.get(sessionId)
    const config = this.runtime.config

    const tokenMeter = this.ctx.get('tokenMeter') as TokenMeterLike | undefined
    let measuredTokens: number | undefined
    try {
      measuredTokens = tokenMeter?.measure(session).totalTokens
    } catch {
      measuredTokens = undefined
    }
    const contextWindow =
      config.compactAfterTokensMode === 'ratio'
        ? await this.runtime.sessionContextWindow(this.ctx, session, agent)
        : undefined

    const entries = await this.runtime.store.load(sessionId)
    return {
      text: buildStatusText(entries, session.snapshotEvents(), {
        config,
        contextWindow,
        measuredTokens,
        consolidationInFlight: this.runtime.consolidationInFlight.has(sessionId),
        compactionInFlight: this.runtime.compactInFlight.has(sessionId),
        lastObserverError: this.runtime.lastObserverError.get(sessionId),
        lastReflectorError: this.runtime.lastReflectorError.get(sessionId),
        lastDropperError: this.runtime.lastDropperError.get(sessionId),
      }),
    }
  }

  /** `/om:view` content; the ledger alone suffices, attached or not. */
  @Remote('view')
  async view(request: OmViewRequest, signal?: AbortSignal): Promise<OmTextValue> {
    const sessionId = sessionIdOf(request)
    if (request.mode !== undefined && request.mode !== 'visible' && request.mode !== 'full') {
      throw new RemoteError('gateway/bad-request', `mode must be "visible" or "full"; received ${JSON.stringify(request.mode)}`, {})
    }
    const mode: ViewMode = request.mode ?? 'visible'
    // Detached sessions have no lineage in reach; their own ledger answers.
    const session = this.ctx.sessions.get(sessionId)
    if (session) await this.runtime.ensureInherited(this.ctx, session)
    const entries = await this.runtime.store.load(sessionId)
    return { text: buildViewText(entries, mode) }
  }

  /**
   * The Memory tab's "run now": one forced consolidation pass (observer →
   * reflector → dropper) for an attached session. The manual entry passive
   * mode keeps available: it bypasses the passive switch and the token
   * clocks, but not the per-session in-flight guard.
   */
  @Remote('run')
  async run(request: OmSessionRequest, signal?: AbortSignal): Promise<OmRunValue> {
    const sessionId = sessionIdOf(request)
    const session = attachedSession(this.ctx, sessionId)
    const ran = await runConsolidationNow(this.ctx, this.runtime, session)
    return { ran }
  }

  /** Bounded tail of the session's debug NDJSON, when recording is on. */
  @Remote('logs')
  async logs(request: OmLogsRequest, signal?: AbortSignal): Promise<OmLogsValue> {
    const sessionId = sessionIdOf(request)
    const config = this.runtime.config
    if (!config.debugLog) return { enabled: false, text: '' }
    const bound = typeof request.maxLines === 'number' && Number.isInteger(request.maxLines) && request.maxLines > 0
      ? Math.min(request.maxLines, MAX_LOG_LINES)
      : DEFAULT_LOG_LINES
    try {
      return { enabled: true, text: await readLogTail(debugLogPath(storageRoot(config), sessionId), bound) }
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return { enabled: true, text: '' }
      throw error
    }
  }
}
