/**
 * Minimal `$DSH_HOME` resolution (mirrors `@deepseek-ai/dsh-home-paths`
 * semantics without the dependency): explicit env override, else `~/.dsh`.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DSH_HOME_ENV = 'DSH_HOME'

/** Match dsh-home-paths: expand only ~, ~/ and ~\, not ~other. */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

export function resolveDshHome(...segments: string[]): string {
  const fromEnv = process.env[DSH_HOME_ENV]
  const root = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return join(resolve(expandHomePath(root)), ...segments)
}
