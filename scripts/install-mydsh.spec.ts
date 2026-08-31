import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const installer = join(import.meta.dirname, 'install-mydsh.sh')
const scratchDirs: string[] = []

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

interface FixtureOptions {
  architecture?: string
  binaryVersion?: string
  expectedDigest?: string
  glibc?: string
  existingInstall?: string
  homeDefault?: boolean
  os?: string
  pathIncludesInstallDir?: boolean
  version?: string
}

function runInstaller(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-mydsh-'))
  scratchDirs.push(root)
  const fakeBin = join(root, 'fake-bin')
  const installDir = options.homeDefault === true ? join(root, '.local', 'bin') : join(root, 'install')
  const fixtureBinary = join(root, 'fixture-mydsh')
  const fixtureChecksums = join(root, 'SHA256SUMS')
  const curlLog = join(root, 'curl.log')
  mkdirSync(fakeBin)
  mkdirSync(installDir, { recursive: true })
  const version = options.version ?? '0.1.2-alpha.3'
  const architecture = options.architecture ?? 'x86_64'
  const asset = `mydsh-linux-${architecture === 'aarch64' || architecture === 'arm64' ? 'arm64' : 'x64'}`
  writeFileSync(fixtureBinary, `#!/bin/sh\nprintf '%s\\n' '${options.binaryVersion ?? version}'\n`, { mode: 0o755 })
  const actualDigest = createHash('sha256').update(readFileSync(fixtureBinary)).digest('hex')
  writeFileSync(fixtureChecksums, `${options.expectedDigest ?? actualDigest}  ${asset}\n`)
  if (options.existingInstall !== undefined) writeFileSync(join(installDir, 'mydsh'), options.existingInstall)

  writeExecutable(join(fakeBin, 'uname'), `#!/bin/sh
if [ "$1" = "-s" ]; then printf '%s\\n' '${options.os ?? 'Linux'}'; else printf '%s\\n' '${architecture}'; fi
`)
  writeExecutable(join(fakeBin, 'getconf'), `#!/bin/sh
printf '%s\\n' '${options.glibc ?? 'glibc 2.28'}'
`)
  writeExecutable(join(fakeBin, 'sha256sum'), `#!/bin/sh
printf '%s  %s\\n' '${actualDigest}' "$1"
`)
  writeExecutable(join(fakeBin, 'curl'), `#!/bin/sh
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$url" >> "$MYDSH_TEST_CURL_LOG"
case "$url" in
  */SHA256SUMS) cp "$MYDSH_TEST_CHECKSUMS" "$out" ;;
  */${asset}) cp "$MYDSH_TEST_BINARY" "$out" ;;
  *) printf 'unexpected URL: %s\\n' "$url" >&2; exit 22 ;;
esac
`)
  const path = options.pathIncludesInstallDir === false
    ? `${fakeBin}:/usr/bin:/bin`
    : `${installDir}:${fakeBin}:/usr/bin:/bin`
  const env = {
    ...process.env,
    HOME: root,
    ...(options.homeDefault === true ? {} : { MYDSH_INSTALL_DIR: installDir }),
    MYDSH_TEST_BINARY: fixtureBinary,
    MYDSH_TEST_CHECKSUMS: fixtureChecksums,
    MYDSH_TEST_CURL_LOG: curlLog,
    MYDSH_VERSION: version,
    PATH: path,
  }
  const result = spawnSync('sh', [installer], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  })
  if (result.error !== undefined) throw result.error
  return { ...result, curlLog, env, installDir, root }
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

describe.skipIf(process.platform === 'win32')('install-mydsh.sh', () => {
  it.each(['x86_64', 'amd64', 'aarch64', 'arm64'])('installs and verifies the %s release asset', (architecture) => {
    const result = runInstaller({ architecture })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('mydsh 0.1.2-alpha.3 installed at')
    expect(result.stdout).not.toContain('Add mydsh to PATH:')
    expect(installedVersion(result.installDir)).toBe('0.1.2-alpha.3')
  })

  it('supports an explicit version and prints a PATH instruction only when needed', () => {
    const result = runInstaller({ pathIncludesInstallDir: false, version: '1.2.3' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('mydsh 1.2.3 installed')
    expect(result.stdout).toContain('Add mydsh to PATH:')
    expect(readFileSync(result.curlLog, 'utf8')).toContain(
      'https://github.com/ralphite/deepseek-harness/releases/download/mydsh-v1.2.3/mydsh-linux-x64',
    )
  })

  it('defaults to HOME/.local/bin without editing PATH', () => {
    const result = runInstaller({ homeDefault: true, pathIncludesInstallDir: false })
    expect(result.status, result.stderr).toBe(0)
    expect(result.installDir).toBe(join(result.root, '.local', 'bin'))
    expect(result.stdout).toContain('Add mydsh to PATH:')
  })

  it.each([
    { options: { os: 'Darwin' }, message: 'only Linux is supported' },
    { options: { architecture: 'riscv64' }, message: 'unsupported Linux architecture' },
    { options: { glibc: 'glibc 2.27' }, message: 'glibc 2.28 or newer is required' },
    { options: { glibc: 'musl libc' }, message: 'musl/Alpine is not supported' },
  ])('rejects an unsupported host: $message', ({ options, message }) => {
    const result = runInstaller(options)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
  })

  it('preserves an existing install when checksum verification fails', () => {
    const result = runInstaller({ existingInstall: 'old-install', expectedDigest: '0'.repeat(64) })
    const target = join(result.installDir, 'mydsh')
    expect(result.status).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('old-install')
    expect(readdirSync(result.installDir)).toEqual(['mydsh'])
  })

  it('preserves an existing install when binary self-check fails', () => {
    const result = runInstaller({ binaryVersion: '9.9.9', existingInstall: 'old-install' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("reported version '9.9.9'")
    expect(readFileSync(join(result.installDir, 'mydsh'), 'utf8')).toBe('old-install')
    expect(readdirSync(result.installDir)).toEqual(['mydsh'])
  })

  it('atomically replaces an existing version and removes temporary files', () => {
    const result = runInstaller({ existingInstall: 'old-install' })
    expect(result.status, result.stderr).toBe(0)
    expect(installedVersion(result.installDir)).toBe('0.1.2-alpha.3')
    expect(readdirSync(result.installDir)).toEqual(['mydsh'])
  })

  it('reinstalls the same version without leaving temporary files', () => {
    const first = runInstaller()
    expect(first.status, first.stderr).toBe(0)
    const second = spawnSync('sh', [installer], {
      encoding: 'utf8',
      env: first.env,
      timeout: 10_000,
    })
    if (second.error !== undefined) throw second.error
    expect(second.status, second.stderr).toBe(0)
    expect(installedVersion(first.installDir)).toBe('0.1.2-alpha.3')
    expect(readdirSync(first.installDir)).toEqual(['mydsh'])
  })

  it('rejects an unsafe version before downloading', () => {
    const result = runInstaller({ version: '../latest' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MYDSH_VERSION contains unsupported characters')
  })

  it('rejects a relative installation directory', () => {
    const result = runInstaller()
    const invalid = spawnSync('sh', [installer], {
      encoding: 'utf8',
      env: { ...result.env, MYDSH_INSTALL_DIR: 'relative/bin' },
      timeout: 10_000,
    })
    if (invalid.error !== undefined) throw invalid.error
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('MYDSH_INSTALL_DIR must be an absolute path')
  })

  it('pins a checked-in recommended version without querying latest releases', () => {
    const source = readFileSync(installer, 'utf8')
    expect(source).toContain("MYDSH_DEFAULT_VERSION='0.1.2-alpha.3'")
    expect(source).toContain("repository='https://github.com/ralphite/deepseek-harness'")
    expect(source).not.toContain('/releases/latest')
  })
})

function installedVersion(installDir: string): string {
  const result = spawnSync(join(installDir, 'mydsh'), ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (result.error !== undefined) throw result.error
  return result.stdout.trim()
}
