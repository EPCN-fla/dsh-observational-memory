/**
 * Regression guard for the client bundle-purity gate: a non-seed bare import
 * (an unlisted @deepseek-ai/* package, a Node builtin) must fail the build
 * instead of being inlined as a private duplicate of a host-shared module,
 * and global CSS must fail instead of producing an unserved client.css.
 * Plain JS (not typechecked) so it can import build.mjs directly.
 */
import { describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { bundlePurityPlugin, PLATFORM_EXTERNALS } from '../build.mjs'

async function tryBuild(contents) {
  try {
    await build({
      stdin: { contents, loader: 'tsx', resolveDir: `${process.cwd()}/src/client` },
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      write: false,
      external: PLATFORM_EXTERNALS,
      plugins: [bundlePurityPlugin],
      logLevel: 'silent',
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

describe('bundle purity gate', () => {
  it('passes the platform externals and a bare entry', async () => {
    const result = await tryBuild(
      "import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'\n"
      + "import { jsx } from 'react/jsx-runtime'\n"
      + 'export const view = jsx(Tooltip, {})\n',
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a @deepseek-ai import outside the seed table', async () => {
    const result = await tryBuild("import '@deepseek-ai/dsh-client-connection'\nexport {}\n")
    expect(result.ok).toBe(false)
    expect(result.error).toContain('bundle-purity')
  })

  it('rejects Node builtins', async () => {
    const result = await tryBuild("import { readFile } from 'node:fs'\nexport { readFile }\n")
    expect(result.ok).toBe(false)
    expect(result.error).toContain('bundle-purity')
  })

  it('rejects global (non-module) CSS', async () => {
    const result = await tryBuild("import './plain.css'\nexport {}\n")
    expect(result.ok).toBe(false)
    expect(result.error).toContain('global CSS')
  })
})
