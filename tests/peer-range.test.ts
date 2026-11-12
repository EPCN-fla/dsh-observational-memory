/**
 * Exact-host regression guard for the intentionally narrow DSH 0.5.0 release.
 *
 * The host enforces each plugin's `peerDependencies` at install and startup
 * with `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`.
 * This release supports only DSH 0.2.2-rc.2: even adjacent release candidates
 * must be refused until a later plugin release explicitly audits and admits them.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { peerDependencies: Record<string, string>; devDependencies: Record<string, string> }

/** The host's own predicate (plugin-compatibility.ts). */
const admits = (hostVersion: string, range: string): boolean =>
  semver.satisfies(hostVersion, range, { includePrerelease: true })

const SUPPORTED_HOSTS = ['0.2.2-rc.2'] as const
const REFUSED_HOSTS = [
  '0.1.5-rc.2',
  '0.1.7-rc.2',
  '0.2.0-rc.2',
  '0.2.1-rc.5',
  '0.2.2-alpha.3',
  '0.2.2-rc.1',
  '0.2.2-rc.3',
  '0.2.2',
  '0.3.0',
] as const

const dshPeers = Object.entries(manifest.peerDependencies).filter(([name]) =>
  name.startsWith('@deepseek-ai/dsh-'),
)

describe('DSH peer ranges', () => {
  it('declares a peer range for every consumed host package', () => {
    expect(dshPeers.map(([name]) => name).sort()).toEqual([
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-compaction',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-typert-protocol',
    ])
  })

  it('pins every DSH peer to the exact supported host', () => {
    expect(new Set(dshPeers.map(([, range]) => range))).toEqual(new Set(['0.2.2-rc.2']))
  })

  for (const host of SUPPORTED_HOSTS) {
    it(`admits dsh ${host}`, () => {
      for (const [name, range] of dshPeers) {
        expect(admits(host, range), `${name} range "${range}" must admit ${host}`).toBe(true)
      }
    })
  }

  for (const host of REFUSED_HOSTS) {
    it(`refuses dsh ${host}`, () => {
      for (const [name, range] of dshPeers) {
        expect(admits(host, range), `${name} range "${range}" must refuse ${host}`).toBe(false)
      }
    })
  }

  it('keeps the @deepseek-ai devDependency cohort on the exact supported host', () => {
    const versions = new Set(
      Object.entries(manifest.devDependencies)
        .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
        .map(([, version]) => version),
    )
    expect(versions).toEqual(new Set(['0.2.2-rc.2']))
  })
})
