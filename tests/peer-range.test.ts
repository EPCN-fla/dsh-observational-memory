/**
 * Peer-range regression guard for the DSH compatibility window.
 *
 * The host enforces each plugin's `peerDependencies` at install and at
 * startup with `semver.satisfies(runtimeVersion, range, { includePrerelease:
 * true })` (packages/boot/app-boot/src/plugin-compatibility.ts, byte-stable
 * across 0.1.7-rc.1 … 0.2.0-rc.2). Two failure modes have bitten in practice
 * and must never regress:
 *
 * - exact prerelease pins go stale the moment the host bumps (`0.1.7-rc.1`
 *   refuses `0.1.7-rc.2`), and
 * - a caret on a zero-major line refuses the line's own prereleases
 *   (`^0.2.0` refuses `0.2.0-rc.1` because rc < release).
 *
 * This test mirrors the host's exact semver call so a range edit that drops
 * a supported host — or admits an unverified one — fails here first.
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

/** Host versions this plugin release supports, per the migration audits. */
const SUPPORTED_HOSTS = [
  // 0.1.5 prerelease line (the plugin's original window).
  '0.1.5-rc.2',
  '0.1.5-rc.3',
  '0.1.5-rc.4',
  // 0.1.7 release candidates (0.1.7-rc.1 … rc.2 audited; format guards and
  // every consumed contract verified identical).
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  // 0.2.0 release candidates (rc.1/rc.2 audited — no consumed surface moved).
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  // The windows are `>=`-floored inside each prerelease line by design:
  // future rcs of an already-audited line install without a plugin release.
  '0.1.7-rc.99',
  '0.2.0-rc.99',
] as const

/**
 * Hosts the range must keep refusing. The windows close BELOW each line's
 * final release on purpose: only audited prerelease lines are admitted, so
 * a final (0.1.7, 0.2.0) or the next line (0.2.1-alpha.1) always requires a
 * conscious range widening here — never a silent install.
 */
const REFUSED_HOSTS = [
  '0.1.4',
  '0.1.5-rc.1',
  '0.1.5',
  '0.1.6',
  '0.1.7',
  '0.2.0',
  '0.2.1-alpha.1',
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

  it('keeps every DSH peer on one identical range', () => {
    const ranges = new Set(dshPeers.map(([, range]) => range))
    expect([...ranges]).toHaveLength(1)
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

  it('keeps the @deepseek-ai devDependency cohort on one exact version', () => {
    const versions = new Set(
      Object.entries(manifest.devDependencies)
        .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
        .map(([, version]) => version),
    )
    expect([...versions]).toHaveLength(1)
    expect([...versions][0]).toMatch(/^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/)
  })
})
