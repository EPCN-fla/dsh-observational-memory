import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import semver from 'semver'
import { readCompatibility } from './ci-compatibility.mjs'

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
        : name === '@deepseek-ai/cordis' ? manifest.dshCompatibility[version].cordis : value)
    }
    assert.deepEqual(selected.peerDependencies, manifest.peerDependencies)
    assert.equal(run(root, 'ci-compatibility.mjs', ['select', version]).stdout.trim(), 'changed=false')
  }
  assert.notEqual(run(root, 'ci-compatibility.mjs', ['select', 'latest']).status, 0)
}))

test('compatibility reader rejects empty, ranged and malformed metadata', () => fixture(root => {
  for (const entries of [undefined, {}, [], { latest: { cordis: '4.0.5' } }, { '0.2.0-rc.1': { cordis: '*' } }]) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dshCompatibility: entries }))
    assert.throws(() => readCompatibility(join(root, 'package.json')))
  }
}))

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
  const env = { PATH: `${root}/bin:${process.env.PATH}`, DSH_TEST_VERSION: '0.2.1-rc.4', FAIL_STEP: 'typecheck' }
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

test('workflow isolates PR validation from tag-only publishing with no artifact uploads', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  assert.deepEqual(workflow.on, { pull_request: null, push: { tags: ['v*'] } })
  assert.equal(workflow.jobs.publish.needs, undefined)
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write')
  const steps = workflow.jobs.verify.steps
  assert.match(steps.find(s => s.id === 'verify24').if, /!cancelled\(\)/)
  assert.doesNotMatch(steps.find(s => s.id === 'verify24').if, /verify22|smoke/)
  assert.equal(steps.find(s => s.name === 'Test summary').if, 'always()')
  assert.match(steps.find(s => s.id === 'cohort').run, /mktemp/)
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job.steps.every(s => !s.uses?.includes('artifact')))
  }
  const publishCommands = workflow.jobs.publish.steps.map(s => s.run ?? '').join('\n')
  assert.doesNotMatch(publishCommands, /npm (test|run (check|test|pack:check))/)
  assert.match(publishCommands, /npm publish --ignore-scripts/)
})
