import { describe, expect, it } from 'vitest'
import { runWorkerLoop } from '../src/workers/loop.ts'
import { fakeLlmCtx } from './fake-llm.ts'

const echoTool = {
  schema: {
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  execute(args: unknown): string {
    return `echo: ${(args as { text: string }).text}`
  },
}

describe('runWorkerLoop finish robustness', () => {
  it('executes tool calls even when the adapter finishes with stop', async () => {
    const { ctx, requests } = fakeLlmCtx([
      { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"hi"}' }], finish: 'stop' },
      { text: 'done' },
    ])
    const result = await runWorkerLoop(ctx, {
      provider: 'p',
      model: 'm',
      system: 's',
      userText: 'u',
      tools: [echoTool],
      maxTurns: 4,
    })
    expect(result.turns).toBe(2)
    expect(JSON.stringify(requests[1].messages)).toContain('echo: hi')
  })
})
