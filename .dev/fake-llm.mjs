/**
 * Dev-only fake LLM adapter for the dsh-observational-memory test profile.
 * Serves a `fake/fake-model` route so the whole memory pipeline can run
 * end-to-end without a real provider:
 * - the main agent gets a plain text reply with usage sized to the request;
 * - the observer gets a record_observations call citing the first source seq
 *   in its chunk, then a stop once a tool result comes back;
 * - the reflector gets a record_reflections call citing the first observation
 *   id in its input, then a stop;
 * - the dropper gets a drop_observations call for the first low observation.
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const name = 'om-fake-llm'
const inject = ['llm']

/** Dev tap outputs land next to this fixture, wherever the repo is cloned. */
const devDir = dirname(fileURLToPath(import.meta.url))

function textOf(content) {
  return (content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function lastMessage(options) {
  return options.messages[options.messages.length - 1]
}

function isToolResult(message) {
  return Array.isArray(message?.content) && message.content[0]?.type === 'tool-result'
}

function estimateInputTokens(options) {
  let chars = (options.system ?? '').length
  for (const message of options.messages ?? []) chars += textOf(message.content).length
  return Math.ceil(chars / 4)
}

async function* streamText(text, options) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield {
    type: 'usage',
    usage: { inputTokens: estimateInputTokens(options), outputTokens: Math.ceil(text.length / 4), totalTokens: 0 },
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* streamToolCall(toolName, args, options) {
  const json = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: 'fake-call-1', name: toolName, argumentsDelta: json }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fake-call-1', name: toolName, arguments: json } }
  yield {
    type: 'usage',
    usage: { inputTokens: estimateInputTokens(options), outputTokens: 40, totalTokens: 0 },
  }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function* streamError(message, code, options) {
  yield {
    type: 'usage',
    usage: { inputTokens: estimateInputTokens(options), outputTokens: 0, totalTokens: 0 },
  }
  yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

function observeArgs(userText) {
  const seqMatch = userText.match(/\[Source event seq: (\d+)\]/)
  const seq = seqMatch ? Number(seqMatch[1]) : 0
  return {
    observations: [
      {
        timestamp: '2026-01-15 14:30',
        content: 'User is driving an integration test of observational memory.',
        relevance: 'high',
        sourceEventSeqs: [seq],
      },
      {
        timestamp: '2026-01-15 14:31',
        content: 'completed: fake observer covered the chunk.',
        relevance: 'low',
        sourceEventSeqs: [seq],
      },
    ],
  }
}

function reflectArgs(userText) {
  const idMatch = userText.match(/\[([a-f0-9]{12})\]/)
  return {
    reflections: [
      {
        content: 'This session is an observational-memory integration test.',
        supportingObservationIds: [idMatch ? idMatch[1] : 'a1b2c3d4e5f6'],
      },
    ],
  }
}

function dropArgs(userText) {
  const low = userText.match(/\[([a-f0-9]{12})\][^\n]*\[low\]/)
  return low ? { ids: [low[1]] } : { ids: [] }
}

let mainCallCount = 0

function stream(options) {
  const system = typeof options.system === 'string' ? options.system : ''
  const last = lastMessage(options)
  const waitingOnTool = isToolResult(last)
  const userText = textOf(last?.content)

  // Dev-only: every 3rd main-loop call pretends the context window overflowed,
  // driving compaction-basic's context-overflow recovery.
  if (!system && !options.purpose) {
    mainCallCount++
    if (mainCallCount % 3 === 0) {
      return streamError('context window exceeded (fake)', 'CONTEXT_WINDOW_EXCEEDED', options)
    }
  }

  if (system.includes('observation agent')) {
    if (waitingOnTool) return streamText('observed.', options)
    return streamToolCall('record_observations', observeArgs(userText), options)
  }
  if (system.includes('reflection agent')) {
    if (waitingOnTool) return streamText('reflected.', options)
    return streamToolCall('record_reflections', reflectArgs(userText), options)
  }
  if (system.includes('dropper agent')) {
    if (waitingOnTool) return streamText('dropped.', options)
    return streamToolCall('drop_observations', dropArgs(userText), options)
  }
  return streamText('Fake reply.', options)
}

class FakeAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'Fake (observational-memory test)' }
  }

  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  async listModels(provider) {
    return [{ provider, id: 'fake-model', name: 'Fake Model' }]
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: 'Fake Model',
      context: { contextWindow: 128_000 },
      inputModalities: ['text'],
    }
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model)
    return { model: resolved, stream: (options) => stream(options) }
  }

  stream(options) {
    return stream(options)
  }
}

function apply(ctx) {
  ctx.llm.registerAdapter(['fake'], new FakeAdapter())
  appendFileSync(join(devDir, 'probe.log'), JSON.stringify({ fakeSees: { compaction: !!ctx.get('compaction'), tokenMeter: !!ctx.get('tokenMeter'), agents: !!ctx.get('agents') } }) + '\n')
  ctx.logger.info('[om-fake-llm] fake provider registered')

  // Dev-only event tap: every session event lands in .dev/events.log.
  const logPath = join(devDir, 'events.log')
  ctx.on('session/event', (session, event) => {
    appendFileSync(logPath, JSON.stringify({ session: session.id, seq: event.seq, type: event.type, data: summarize(event) }) + '\n')
  })
  ctx.on('agent/status', ({ agent, status }) => {
    appendFileSync(logPath, JSON.stringify({ agentStatus: status, session: agent?.session?.id }) + '\n')
    if (status === 'idle') {
      appendFileSync(logPath, JSON.stringify({
        preset: agent.session.header.agentPreset ?? null,
        agentCtx: {
          compaction: !!agent.ctx.get('compaction'),
          tokenMeter: !!agent.ctx.get('tokenMeter'),
          tools: !!agent.ctx.get('tools'),
        },
      }) + '\n')
    }
    if (status === 'idle') {
      const fibers = []
      for (const runtime of ctx.registry.values()) {
        for (const fiber of runtime.fibers) fibers.push({ name: fiber.name, state: fiber.state })
      }
      appendFileSync(logPath, JSON.stringify({ fibers: fibers }) + '\n')
      appendFileSync(logPath, JSON.stringify({ getCompaction: !!ctx.get('compaction'), getTokenMeter: !!ctx.get('tokenMeter') }) + '\n')
    }
  })
  ctx.on('agent/error', ({ error }) => {
    appendFileSync(logPath, JSON.stringify({ agentError: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 500) }) + '\n')
  })
  ctx.on('llm/stream', (options, next) => {
    appendFileSync(logPath, JSON.stringify({ llmCall: { provider: options.provider, model: options.model, purpose: options.purpose ?? null, messageCount: options.messages?.length, tools: (options.tools ?? []).map((t) => t.name) } }) + '\n')
    return next()
  })
}

function summarize(event) {
  const d = event.data ?? {}
  if (event.type === 'user/message') return { text: (d.content?.[0]?.text ?? '').slice(0, 60) }
  if (event.type === 'assistant/message') return { content: JSON.stringify(d.message?.content ?? []).slice(0, 200), usage: d.usage }
  if (event.type === 'assistant/attempt') return { frames: (d.stream ?? []).map((f) => f.type ?? Object.keys(f)) }
  if (event.type === 'turn/end') return { reason: d.reason }
  if (event.type === 'request/header') return { config: d.header?.config }
  if (event.type === 'request/context') return d
  return d
}

export { name, inject, apply }
