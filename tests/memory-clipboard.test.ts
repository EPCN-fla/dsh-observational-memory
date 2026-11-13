// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { writeClipboardText } from '../src/client/memory.tsx'

describe('Memory clipboard fallback', () => {
  it('uses a readonly offscreen textarea for legacy copying', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    document.execCommand = vi.fn(() => {
      const area = document.body.querySelector('textarea')
      expect(area?.readOnly).toBe(true)
      expect(area?.style.position).toBe('fixed')
      expect(area?.style.left).toBe('-9999px')
      return true
    })
    await expect(writeClipboardText('memory')).resolves.toBe(true)
    expect(document.body.querySelector('textarea')).toBeNull()
  })

  it('removes the temporary textarea when legacy copying throws', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    document.execCommand = vi.fn(() => { throw new Error('copy denied') })
    await expect(writeClipboardText('memory')).resolves.toBe(false)
    expect(document.body.querySelector('textarea')).toBeNull()
  })
})
