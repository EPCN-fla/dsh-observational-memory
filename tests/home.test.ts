import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DSH_HOME_ENV, expandHomePath, resolveDshHome } from '../src/home.ts'

const previous = process.env[DSH_HOME_ENV]
afterEach(() => {
  if (previous === undefined) delete process.env[DSH_HOME_ENV]
  else process.env[DSH_HOME_ENV] = previous
})

describe('DSH home resolution', () => {
  it('expands the same tilde prefixes as the host', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/memory')).toBe(join(homedir(), 'memory'))
    expect(expandHomePath('~\\memory')).toBe(join(homedir(), 'memory'))
    expect(expandHomePath('~other/memory')).toBe('~other/memory')
  })

  it('uses the expanded override and preserves defaults and relative paths', () => {
    process.env[DSH_HOME_ENV] = '~/om-home'
    expect(resolveDshHome('observational-memory')).toBe(join(homedir(), 'om-home', 'observational-memory'))
    process.env[DSH_HOME_ENV] = 'relative-home'
    expect(resolveDshHome()).toBe(resolve('relative-home'))
    process.env[DSH_HOME_ENV] = '   '
    expect(resolveDshHome()).toBe(join(homedir(), '.dsh'))
    delete process.env[DSH_HOME_ENV]
    expect(resolveDshHome()).toBe(join(homedir(), '.dsh'))
  })
})
