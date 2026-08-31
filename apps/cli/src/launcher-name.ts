/**
 * Launcher identity for source, npm, Python, and GitHub binary carriers.
 * @module @deepseek-ai/dsh/launcher-name
 */

import { basename } from 'node:path'

/**
 * Select the GitHub distribution name only for a packaged executable whose
 * exact basename is `mydsh`; every other carrier remains `dsh`.
 * @param execPath - current executable path.
 * @param packaged - whether the process is running from pkg.
 * @returns the user-facing launcher command.
 */
export function resolveLauncherName(
  execPath = process.execPath,
  packaged = 'pkg' in process,
): 'dsh' | 'mydsh' {
  return packaged && basename(execPath) === 'mydsh' ? 'mydsh' : 'dsh'
}
