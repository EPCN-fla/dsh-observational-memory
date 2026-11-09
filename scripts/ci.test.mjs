import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import semver from 'semver'
import { readCompatibility, supportsNodeVersion } from './ci-compatibility.mjs'

const script = name => fileURLToPath(new URL(name, import.meta.url))

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'observational-memory-ci-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
    return fn(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const run = (root, name, args, env = {}) => spawnSync(process.execPath, [script(name), ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env }, timeout: 10000,
})

test('compatibility matrix is derived from metadata and selects only DSH/Cordis dev dependencies', () => fixture(root => {
  const matrix = run(root, 'ci-compatibility.mjs', ['matrix'])
  assert.equal(matrix.status, 0, matrix.stderr)
  assert.deepEqual(JSON.parse(matrix.stdout), { 'dsh-version': Object.keys(manifest.dshCompatibility) })
  for (const version of Object.keys(manifest.dshCompatibility)) {
    const result = run(root, 'ci-compatibility.mjs', ['select', version])
    assert.equal(result.status, 0, result.stderr)
    const selected = JSON.parse(readFileSync(join(root, 'package.json')))
    for (const [name, value] of Object.entries(manifest.devDependencies)) {
      assert.equal(selected.devDependencies[name], name.startsWith('@deepseek-ai/dsh-') ? version
        : name === '@deepseek-ai/cordis' ? manifest.dshCompatibility[version].cordis
        : name === '@deepseek-ai/schemastery' ? manifest.dshCompatibility[version].schemastery : value)
    }
    assert.deepEqual(selected.peerDependencies, manifest.peerDependencies)
    assert.deepEqual(selected.overrides ?? {}, manifest.dshCompatibility[version].overrides ?? {})
    assert.equal(run(root, 'ci-compatibility.mjs', ['select', version]).stdout.trim(), 'changed=false')
  }
  assert.notEqual(run(root, 'ci-compatibility.mjs', ['select', 'latest']).status, 0)
}))

test('compatibility reader rejects empty, ranged and malformed metadata', () => fixture(root => {
  for (const entries of [undefined, {}, [], { latest: { cordis: '4.0.5', schemastery: '3.18.4' } }, { '0.2.0-rc.1': { cordis: '*', schemastery: '3.18.4' } }, { '0.2.0-rc.1': { cordis: '4.0.4', schemastery: '3.18.4', overrides: { x: '*' } } }]) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dshCompatibility: entries }))
    assert.throws(() => readCompatibility(join(root, 'package.json')))
  }
}))

test('the DSH 0.2.2 cohort emits its Node 24.9 floor and skips Node 22', () => fixture(root => {
  const output = join(root, 'github-output.txt')
  const selected = run(root, 'ci-compatibility.mjs', ['select', '0.2.2-rc.1'], { GITHUB_OUTPUT: output })
  assert.equal(selected.status, 0, selected.stderr)
  assert.match(readFileSync(output, 'utf8'), /node22=false/)
  const cohort = manifest.dshCompatibility['0.2.2-rc.1']
  assert.equal(supportsNodeVersion(cohort, '24.8.9'), false)
  assert.equal(supportsNodeVersion(cohort, '24.9.0'), true)
  assert.equal(supportsNodeVersion(cohort, '24.10.0'), true)
  assert.equal(supportsNodeVersion(cohort, '25.0.0'), true)
  mkdirSync(join(root, 'artifacts/ci'), { recursive: true })
  writeFileSync(join(root, 'artifacts/ci/node-24.json'), JSON.stringify({
    node: 'v24.0.0', dsh: '0.2.1-rc.5', steps: [{ name: 'install', status: 'passed' }],
  }))
  const summary = run(root, 'ci-verify.mjs', ['summary'], { DSH_TEST_VERSION: '0.2.2-rc.1' })
  assert.equal(summary.status, 0, summary.stderr)
  assert.match(summary.stdout, /\| 22 \| not required \| unsupported \|/)
  assert.doesNotMatch(summary.stdout, /passed/)

  const invalid = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  invalid.dshCompatibility['0.2.2-rc.1'].node = '22'
  writeFileSync(join(root, 'package.json'), JSON.stringify(invalid))
  assert.throws(() => readCompatibility(join(root, 'package.json')))
}))

test('every published host in the peer compatibility window has an executable matrix entry', () => {
  assert.deepEqual(Object.keys(manifest.dshCompatibility), [
    '0.1.5-rc.2', '0.1.5-rc.3',
    '0.1.7-rc.1', '0.1.7-rc.2',
    '0.2.0-rc.1', '0.2.0-rc.2',
    '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5',
    '0.2.2-rc.1',
  ])
  // 0.1.5-rc.4 remains in the peer declaration but was never published to npm.
  assert.equal(manifest.dshCompatibility['0.1.5-rc.4'], undefined)
})

test('every executable matrix version remains inside every DSH peer range', () => {
  for (const version of Object.keys(manifest.dshCompatibility)) {
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) assert.ok(semver.satisfies(version, range, { includePrerelease: true }), `${name} must admit ${version}`)
    }
  }
})

test('verification records failures, continues independent checks and summarizes both Node legs', { skip: process.platform === 'win32' }, () => fixture(root => {
  mkdirSync(join(root, 'bin'))
  const npm = join(root, 'bin/npm')
  writeFileSync(npm, `#!${process.execPath}\nprocess.exit(process.argv.includes(process.env.FAIL_STEP) ? 1 : 0)\n`)
  chmodSync(npm, 0o755)
  const major = process.versions.node.split('.')[0]
  const env = { PATH: `${root}/bin:${process.env.PATH}`, DSH_TEST_VERSION: '0.2.1-rc.5', FAIL_STEP: 'typecheck' }
  const result = run(root, 'ci-verify.mjs', ['verify', major], env)
  assert.equal(result.status, 1, result.stderr)
  let report = JSON.parse(readFileSync(join(root, `artifacts/ci/node-${major}.json`)))
  assert.equal(report.steps.find(s => s.name === 'typecheck').status, 'failed')
  assert.equal(report.steps.find(s => s.name === 'package').status, 'passed')
  const summary = run(root, 'ci-verify.mjs', ['summary'], env)
  assert.equal(summary.status, 0, summary.stderr)
  assert.match(summary.stdout, /failed/)
  assert.match(summary.stdout, /not run/)
  const installFailure = run(root, 'ci-verify.mjs', ['verify', major], { ...env, FAIL_STEP: 'ci' })
  assert.equal(installFailure.status, 1)
  report = JSON.parse(readFileSync(join(root, `artifacts/ci/node-${major}.json`)))
  assert.ok(report.steps.slice(1).every(s => s.status === 'skipped'))
}))

test('CI and the committed lockfile use official npm package endpoints', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.env.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org')
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.')) continue
    assert.equal(new URL(entry.resolved).hostname, 'registry.npmjs.org', `${path} uses a third-party registry mirror`)
  }
})

test('workflow isolates PR validation but gates tag-only publishing on the full local check', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  assert.deepEqual(workflow.on, { pull_request: null, push: { tags: ['v*'] } })
  assert.equal(workflow.jobs.publish.needs, 'verify')
  assert.equal(workflow.jobs.compatibility.if, undefined)
  assert.equal(workflow.jobs.verify.if, undefined)
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write')
  assert.equal(workflow.jobs.publish.concurrency.group, 'npm-publish-${{ github.repository }}')
  assert.equal(workflow.jobs.publish.concurrency['cancel-in-progress'], false)
  const steps = workflow.jobs.verify.steps
  assert.match(steps.find(s => s.id === 'verify24').if, /!cancelled\(\)/)
  assert.doesNotMatch(steps.find(s => s.id === 'verify24').if, /verify22|smoke/)
  assert.match(steps.find(s => s.id === 'verify22').if, /node22/)
  assert.equal(steps.find(s => s.name === 'Test summary').if, 'always()')
  assert.match(steps.find(s => s.id === 'cohort').run, /mktemp/)
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job.steps.every(s => !s.uses?.includes('artifact')))
  }
  const publishCommands = workflow.jobs.publish.steps.map(s => s.run ?? '').join('\n')
  const check = publishCommands.indexOf('npm run check')
  const publish = publishCommands.indexOf('npm publish --ignore-scripts')
  assert.ok(check >= 0, 'tag publishing must run the full local gate')
  assert.ok(publish > check, 'the full local gate must precede npm publish')
  assert.match(publishCommands, /artifacts\/\$\(node/, 'publish must consume the verified tarball')
})
