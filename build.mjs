/**
 * Build both halves:
 *  - lib/index.js  — host half (bundled ESM for the Loader; @deepseek-ai
 *    runtime packages stay external so an installed bundle resolves them from
 *    the profile's node_modules).
 *  - lib/client.js — browser half as the lazy-CJS artifact the DSH client
 *    module system serves: execution registers { id, factory } with
 *    window.__ModuleLoader__.
 *
 * Browser externals mirror the shell's shared module table
 * (PLATFORM_MODULES in packages/client/web/src/platform.ts).
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { build } from 'esbuild'
import { transform } from 'lightningcss'

const ID = 'dsh-observational-memory'

const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Host-half externals: harness runtime packages resolved from the profile. */
const HOST_EXTERNALS = ['@deepseek-ai/*']

/**
 * CSS Modules the way the DSH client bundles them: lightningcss compiles and
 * minifies the sheet, the module exports the hashed class map, and factory
 * execution injects one tagged <style> (idempotent across HMR reloads).
 */
const cssModulesPlugin = {
  name: 'dsh-css-modules',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.module\.css$/ }, async (args) => {
      const source = await readFile(args.path)
      const { code, exports: cssExports } = transform({
        filename: args.path,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = {}
      for (const [local, entry] of Object.entries(cssExports ?? {})) classMap[local] = entry.name
      const tagId = `${ID}/${basename(args.path)}`
      return {
        loader: 'js',
        contents: [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          'if (typeof document !== \'undefined\') {',
          // HMR re-executes this factory with edited CSS: replace the existing
          // sheet instead of skipping, so style-only changes apply live.
          '  const selector = \'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\';',
          '  let tag = document.querySelector(selector);',
          '  if (tag === null) {',
          '    tag = document.createElement(\'style\');',
          `    tag.dataset.plugin = ${JSON.stringify(ID)};`,
          '    tag.dataset.pluginCss = tagId;',
          '    document.head.appendChild(tag);',
          '  }',
          '  if (tag.textContent !== css) tag.textContent = css;',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n'),
      }
    })
  },
}

// Host half: bundled ESM for Node; harness runtime dependencies stay external.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  outfile: 'lib/index.js',
  sourcemap: true,
  external: HOST_EXTERNALS,
  logLevel: 'info',
})

// Browser half: lazy-CJS factory artifact.
await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  outfile: 'lib/client.js',
  sourcemap: true,
  jsx: 'automatic',
  external: PLATFORM_EXTERNALS,
  plugins: [cssModulesPlugin],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})
