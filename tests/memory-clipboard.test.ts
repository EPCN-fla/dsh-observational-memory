// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { writeClipboardText } from '../src/client/memory.tsx'

describe('Memory clipboard fallback', () => {
  it('removes the temporary textarea when legacy copying throws', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    document.execCommand = vi.fn(() => { throw new Error('copy denied') })
    await expect(writeClipboardText('memory')).resolves.toBe(false)
    expect(document.body.querySelector('textarea')).toBeNull()
  })
})
