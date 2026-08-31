/**
 * Materialize executable files embedded in a pkg virtual filesystem.
 *
 * @module @deepseek-ai/dsh-executable-asset
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const DIRECTORY_MODE = 0o700
const EXECUTABLE_MODE = 0o700

/** Whether the current process reads application files through pkg's virtual filesystem. */
function isPackagedRuntime(): boolean {
  return (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined
}

/** Return the SHA-256 digest of complete file content. */
function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Read a regular, non-link cache entry and compare its content digest. */
function isValidCachedExecutable(path: string, expectedDigest: string): boolean {
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false
    return digest(readFileSync(path)) === expectedDigest
  } catch (error) {
    /* v8 ignore next -- non-ENOENT metadata failures are external I/O faults, propagated unchanged. */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    /* v8 ignore next -- covered by the same external I/O fault case above. */
    throw error
  }
}

/**
 * Return a spawnable path for an executable dependency. Ordinary Node
 * processes receive the dependency path unchanged. A pkg runtime reads the
 * embedded bytes and publishes them under a SHA-256 cache directory, because
 * operating systems cannot execute a file inside pkg's virtual filesystem.
 *
 * A valid cache entry is re-used after digest verification and receives exact
 * owner-only executable permissions. A missing, corrupt, or symlinked entry is
 * replaced by an exclusive temporary sibling and atomic rename. Concurrent
 * processes may race to publish the same immutable bytes; every successful
 * rename therefore commits an equivalent file.
 * @param source - dependency-owned executable path.
 * @returns `source` outside pkg, otherwise the verified native cache path.
 */
export function materializeExecutableAsset(source: string): string {
  if (!isPackagedRuntime()) return source
  const name = basename(source)
  if (name === '' || name === '.' || name === '..') {
    throw new Error(`executable-asset: source has no executable filename: ${JSON.stringify(source)}`)
  }
  const content = readFileSync(source)
  const contentDigest = digest(content)
  const directory = dshHomePath('cache', 'native-executables', contentDigest)
  const target = join(directory, name)
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
  chmodSync(directory, DIRECTORY_MODE)
  if (isValidCachedExecutable(target, contentDigest)) {
    chmodSync(target, EXECUTABLE_MODE)
    return target
  }

  const temporary = join(directory, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: EXECUTABLE_MODE })
    renameSync(temporary, target)
    chmodSync(target, EXECUTABLE_MODE)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return target
}
