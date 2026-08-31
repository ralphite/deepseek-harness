import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeExecutableAsset } from '@deepseek-ai/dsh-executable-asset'

const originalDshHome = process.env.DSH_HOME
const scratchDirs: string[] = []

afterEach(async () => {
  Reflect.deleteProperty(process, 'pkg')
  if (originalDshHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
  else process.env.DSH_HOME = originalDshHome
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-executable-asset-'))
  scratchDirs.push(dir)
  return dir
}

function packaged(): void {
  Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
}

describe('materializeExecutableAsset', () => {
  it('rejects an embedded source without a filename', () => {
    packaged()
    expect(() => materializeExecutableAsset('')).toThrow('has no executable filename')
  })

  it('returns the dependency path unchanged outside pkg', () => {
    expect(materializeExecutableAsset('/missing/bin/rg')).toBe('/missing/bin/rg')
  })

  it('publishes embedded bytes under their digest with private executable permissions', async () => {
    const root = await scratch()
    const source = join(root, 'embedded', 'rg')
    await mkdir(join(root, 'embedded'))
    await writeFile(source, 'binary-content', { mode: 0o600 })
    process.env.DSH_HOME = join(root, 'home')
    packaged()

    const target = materializeExecutableAsset(source)
    const expectedDigest = createHash('sha256').update('binary-content').digest('hex')
    expect(target).toBe(join(root, 'home', 'cache', 'native-executables', expectedDigest, 'rg'))
    expect(await readFile(target, 'utf8')).toBe('binary-content')
    if (process.platform !== 'win32') {
      expect((await stat(target)).mode & 0o777).toBe(0o700)
      expect((await stat(join(target, '..'))).mode & 0o777).toBe(0o700)
    }
  })

  it('reuses valid bytes while narrowing their permissions', async () => {
    const root = await scratch()
    const source = join(root, 'rg')
    await writeFile(source, 'stable')
    process.env.DSH_HOME = join(root, 'home')
    packaged()
    const target = materializeExecutableAsset(source)
    await chmod(target, 0o777)

    expect(materializeExecutableAsset(source)).toBe(target)
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o700)
  })

  it.skipIf(process.platform === 'win32')('replaces a corrupt cache file and a symlink without changing its referent', async () => {
    const root = await scratch()
    const source = join(root, 'landlock-run')
    await writeFile(source, 'trusted')
    process.env.DSH_HOME = join(root, 'home')
    packaged()
    const target = materializeExecutableAsset(source)
    await writeFile(target, 'corrupt')
    expect(await readFile(materializeExecutableAsset(source), 'utf8')).toBe('trusted')

    const victim = join(root, 'victim')
    await writeFile(victim, 'victim')
    await rm(target)
    await symlink(victim, target)
    expect(await readFile(materializeExecutableAsset(source), 'utf8')).toBe('trusted')
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(victim, 'utf8')).toBe('victim')
  })

  it('cleans its temporary file when an invalid target prevents publication', async () => {
    const root = await scratch()
    const source = join(root, 'rg')
    const content = 'trusted'
    await writeFile(source, content)
    process.env.DSH_HOME = join(root, 'home')
    packaged()
    const contentDigest = createHash('sha256').update(content).digest('hex')
    const directory = join(root, 'home', 'cache', 'native-executables', contentDigest)
    await mkdir(join(directory, 'rg'), { recursive: true })

    expect(() => materializeExecutableAsset(source)).toThrow()
    expect(await readdir(directory)).toEqual(['rg'])
  })
})
