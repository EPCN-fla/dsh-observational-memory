import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { parse } from 'yaml'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
await mkdir('artifacts', { recursive: true })
// Build is explicit before this gate. The tarball, not the source tree, is the
// immutable input for manifest, wrapper and consumer-resolution checks.
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', 'artifacts'], { encoding: 'utf8' }))
const names = packed.files.map(file => file.path)
for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.en.md', 'LICENSE']) {
  assert.ok(names.includes(required), `Missing ${required}`)
}
const tarball = resolve('artifacts', packed.filename)
const consumer = await mkdtemp(join(tmpdir(), 'observational-memory-consumer-'))
try {
  execFileSync('npm', ['init', '-y'], { cwd: consumer, stdio: 'ignore' })
  const cohort = process.env.DSH_TEST_VERSION
  const cohortArgs = []
  const selected = cohort === undefined ? undefined : manifest.dshCompatibility?.[cohort]
  if (cohort !== undefined) {
    assert.ok(selected, `DSH_TEST_VERSION ${cohort} is not declared in dshCompatibility`)
    for (const name of Object.keys(manifest.devDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) cohortArgs.push(`${name}@${cohort}`)
    }
    cohortArgs.push(`@deepseek-ai/cordis@${selected.cordis}`, `@deepseek-ai/schemastery@${selected.schemastery}`)
    if (selected.overrides !== undefined) {
      const consumerManifestPath = join(consumer, 'package.json')
      const consumerManifest = JSON.parse(await readFile(consumerManifestPath, 'utf8'))
      consumerManifest.overrides = selected.overrides
      await writeFile(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`)
    }
  }
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', tarball, ...cohortArgs], { cwd: consumer, stdio: 'inherit' })
  const require = createRequire(join(consumer, 'package.json'))
  // A published prebuilt package has no build.mjs or dev toolchain. Its
  // prepare script must therefore be a no-op on npm rebuild, while a Git
  // source checkout (which has build.mjs) still builds during installation.
  execFileSync('npm', ['rebuild', manifest.name], { cwd: consumer, stdio: 'inherit' })
  const host = await import(pathToFileURL(require.resolve(manifest.name)).href)
  assert.equal(host.name, 'observational-memory')
  const packedClient = await readFile(require.resolve(`${manifest.name}/client`), 'utf8')
  assert.ok(packedClient.startsWith('window.__ModuleLoader__.load({'))
  assert.ok(packedClient.includes(`id: "${manifest.name}"`))
  const packedManifest = require(`${manifest.name}/package.json`)
  assert.equal(packedManifest.version, manifest.version)
  assert.equal(packedManifest.icon, 'icon.svg')
  const manifestPath = require.resolve(`${manifest.name}/package.json`)
  const packageRoot = dirname(manifestPath)
  const patch = parse(await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8'))
  assert.equal(patch[0].insert[0].name, manifest.name)
  if (cohort !== undefined) {
    for (const name of Object.keys(manifest.devDependencies)) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      const installed = JSON.parse(await readFile(join(consumer, 'node_modules', name, 'package.json'), 'utf8'))
      assert.equal(installed.version, cohort, `${name} resolved outside the selected cohort`)
    }
  }
  const icon = await readFile(join(packageRoot, packedManifest.icon))
  assert.ok(icon.length <= 256 * 1024, 'icon exceeds the DSH metadata limit')
  assert.ok(icon.toString('utf8').includes('<svg'), 'icon is not an SVG document')
} finally {
  await rm(consumer, { recursive: true, force: true })
}

const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
await writeFile('artifacts/package.json', `${JSON.stringify({ name: manifest.name, version: manifest.version, filename: packed.filename, sha256, files: names }, null, 2)}\n`)
await writeFile('artifacts/SHA256SUMS', `${sha256}  ${packed.filename}\n`)
console.log(`Verified ${packed.filename}: ${names.length} files, sha256 ${sha256}`)
