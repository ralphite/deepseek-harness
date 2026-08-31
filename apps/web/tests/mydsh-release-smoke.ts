/** Browser smoke for a sidecar-free mydsh release candidate. */

import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const source = process.argv[2]
const screenshot = process.argv[3]
if (source === undefined || screenshot === undefined) {
  throw new Error('usage: mydsh-release-smoke.ts <mydsh-linux-asset> <screenshot-path>')
}

const root = await mkdtemp(join(tmpdir(), 'mydsh-web-smoke-'))
const executable = join(root, 'mydsh')
const home = join(root, 'home')
const emptyPath = join(root, 'empty-path')

interface RunningServer {
  url: string
  stop(): Promise<void>
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => { resolveExit() })
  })
  child.kill('SIGTERM')
  let deadline: NodeJS.Timeout | undefined
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => {
      deadline = setTimeout(() => { resolveTimeout(false) }, 10_000)
      deadline.unref()
    }),
  ])
  if (deadline !== undefined) clearTimeout(deadline)
  if (graceful) return
  child.kill('SIGKILL')
  await exited
}

async function startServer(): Promise<RunningServer> {
  const child = spawn(executable, ['web', '--no-open', '--port', '0'], {
    cwd: root,
    env: {
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      HOME: root,
      PATH: emptyPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  let url: string
  try {
    url = await new Promise<string>((resolveReady, rejectReady) => {
      const deadline = setTimeout(() => {
        rejectReady(new Error(`mydsh Web did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      }, 60_000)
      const inspect = (): void => {
        const match = /mydsh web: (http:\/\/[^\s]+)/u.exec(stdout)
        if (match?.[1] === undefined) return
        clearTimeout(deadline)
        resolveReady(match[1])
      }
      child.stdout?.on('data', inspect)
      child.once('exit', (code, signal) => {
        clearTimeout(deadline)
        rejectReady(new Error(`mydsh Web exited before ready (code=${String(code)}, signal=${String(signal)})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      })
    })
  } catch (error) {
    await stopChild(child)
    throw error
  }
  return {
    url,
    async stop() {
      await stopChild(child)
    },
  }
}

async function inspectPage(url: string, screenshotPath?: string): Promise<void> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale: 'en-US' })
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => { errors.push(`page: ${String(error)}`) })
    page.on('requestfailed', (request) => {
      errors.push(`request: ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`)
    })
    page.on('response', (candidate) => {
      if (candidate.status() >= 400) errors.push(`response: ${candidate.status()} ${candidate.url()}`)
    })
    const response = await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
    if (response === null || !response.ok()) throw new Error(`mydsh Web returned ${String(response?.status())}`)
    try {
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    } catch (error) {
      const body = (await page.locator('body').innerText()).slice(0, 4_000)
      throw new Error(`mydsh Web did not render its application frame: ${String(error)}\nbody:\n${body}\nbrowser errors:\n${errors.join('\n')}`)
    }
    if (await page.locator('text=Failed to load plugins').count() !== 0) {
      throw new Error('mydsh Web reported a client-plugin load failure')
    }
    if (errors.length > 0) throw new Error(`mydsh Web browser errors:\n${errors.join('\n')}`)
    if (screenshotPath !== undefined) await page.screenshot({ fullPage: true, path: resolve(screenshotPath) })
  } finally {
    await browser.close()
  }
}

let server: RunningServer | undefined
try {
  await mkdir(emptyPath)
  await copyFile(resolve(source), executable, constants.COPYFILE_FICLONE)
  await chmod(executable, 0o755)
  server = await startServer()
  await inspectPage(server.url)
  await server.stop()
  const firstHomeEntries = await readdir(home, { recursive: true })
  if (firstHomeEntries.length === 0) throw new Error('mydsh Web created no persistent Harness-home state')

  server = await startServer()
  await inspectPage(server.url, screenshot)
  await server.stop()
  const restartedHomeEntries = new Set(await readdir(home, { recursive: true }))
  if (!firstHomeEntries.some(path => restartedHomeEntries.has(path))) {
    throw new Error('mydsh Web restart retained no Harness-home state')
  }
  console.log('mydsh-release-smoke: passed')
} finally {
  await server?.stop()
  await rm(root, { force: true, recursive: true })
}
