/** Browser smoke for a sidecar-free mydsh release candidate. */

import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Locator, type Page } from 'playwright'

const source = process.argv[2]
const screenshot = process.argv[3]
if (source === undefined || screenshot === undefined) {
  throw new Error('usage: mydsh-release-smoke.ts <mydsh-linux-asset> <screenshot-path>')
}

const root = await mkdtemp(join(tmpdir(), 'mydsh-web-smoke-'))
const executable = join(root, 'mydsh')
const home = join(root, 'home')
const emptyPath = join(root, 'empty-path')
const workspaceParent = join(root, 'workspace-parent')
const workspaceName = 'release-workspace'
const workspacePath = join(workspaceParent, workspaceName)

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
      SSH_TTY: '/dev/pts/mydsh-release-smoke',
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

async function openWorkspaceDirectoryDialog(page: Page): Promise<Locator> {
  const addWorkspace = page.getByRole('button', { name: 'Add workspace', exact: true })
  const directoryDialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  const testingNotice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  const providerSetup = page.getByRole('dialog', { name: 'Add an API key to get started' })
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await directoryDialog.isVisible()) return directoryDialog
    if (await testingNotice.isVisible()) {
      await testingNotice.getByRole('button', { name: 'Continue', exact: true }).click()
      await testingNotice.waitFor({ state: 'hidden', timeout: 10_000 })
      continue
    }
    if (await providerSetup.isVisible()) {
      await providerSetup.getByRole('button', { name: 'Configure later', exact: true }).click()
      await providerSetup.waitFor({ state: 'hidden', timeout: 10_000 })
      continue
    }
    await addWorkspace.click()
    await Promise.race([
      directoryDialog.waitFor({ state: 'visible', timeout: 10_000 }),
      testingNotice.waitFor({ state: 'visible', timeout: 10_000 }),
      providerSetup.waitFor({ state: 'visible', timeout: 10_000 }),
    ])
  }
  throw new Error('mydsh Web did not expose its workspace directory dialog')
}

async function createAndUseWorkspace(page: Page): Promise<void> {
  const dialog = await openWorkspaceDirectoryDialog(page)
  await dialog.getByRole('button', { name: 'workspace-parent', exact: true }).click()
  await dialog.getByRole('button', { name: 'New folder', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: 'New folder' })
  await createDialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill(workspaceName)
  await createDialog.getByRole('button', { name: 'Create', exact: true }).click()
  await createDialog.waitFor({ state: 'hidden', timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
  await page.locator('[data-composer-input][contenteditable="true"][data-placeholder="Describe what you want to build... / commands, @ files or sessions"]')
    .waitFor({ timeout: 30_000 })
  await page.getByRole('treeitem', { name: workspaceName, exact: true }).waitFor({ timeout: 10_000 })
}

async function inspectPage(url: string, createWorkspace: boolean, screenshotPath?: string): Promise<void> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale: 'en-US' })
    const errors: string[] = []
    const pluginResponses: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`)
      if (message.type() === 'warning'
        && /\b(?:new session|initial workspace selection) failed:/u.test(message.text())) {
        errors.push(`console warning: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => { errors.push(`page: ${String(error)}`) })
    page.on('requestfailed', (request) => {
      errors.push(`request: ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`)
    })
    page.on('response', (candidate) => {
      if (new URL(candidate.url()).pathname.startsWith('/plugins/')) {
        pluginResponses.push(`${String(candidate.status())} ${candidate.url()}`)
      }
      if (candidate.status() >= 400) errors.push(`response: ${candidate.status()} ${candidate.url()}`)
    })
    const response = await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
    if (response === null || !response.ok()) throw new Error(`mydsh Web returned ${String(response?.status())}`)
    try {
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    } catch (error) {
      const body = (await page.locator('body').innerText()).slice(0, 4_000)
      const scriptSources = await page.locator('head script[src]').evaluateAll(
        scripts => scripts.map(script => (script as HTMLScriptElement).src),
      )
      const scripts = await Promise.all(scriptSources.map(async (src) => {
        const script = await page.request.get(src)
        return `${String(script.status())} ${src}\n${(await script.text()).slice(0, 500)}`
      }))
      throw new Error(
        `mydsh Web did not render its application frame: ${String(error)}`
        + `\nbody:\n${body}`
        + `\nplugin responses:\n${pluginResponses.join('\n')}`
        + `\nhead scripts:\n${scripts.join('\n---\n')}`
        + `\nbrowser errors:\n${errors.join('\n')}`,
      )
    }
    if (await page.locator('text=Failed to load plugins').count() !== 0) {
      throw new Error('mydsh Web reported a client-plugin load failure')
    }
    try {
      if (createWorkspace) {
        await createAndUseWorkspace(page)
      } else {
        await page.locator('[data-composer-input][contenteditable="true"][data-placeholder="Describe what you want to build... / commands, @ files or sessions"]')
          .waitFor({ timeout: 30_000 })
        await page.getByRole('treeitem', { name: workspaceName, exact: true }).waitFor({ timeout: 10_000 })
      }
    } catch (error) {
      throw new Error(
        `mydsh Web workspace flow failed: ${String(error)}`
        + `\nbrowser errors:\n${errors.join('\n')}`,
      )
    }
    if (errors.length > 0) throw new Error(`mydsh Web browser errors:\n${errors.join('\n')}`)
    if (screenshotPath !== undefined) await page.screenshot({ fullPage: true, path: resolve(screenshotPath) })
  } finally {
    await browser.close()
  }
}

let server: RunningServer | undefined
try {
  await Promise.all([mkdir(emptyPath), mkdir(workspaceParent)])
  await copyFile(resolve(source), executable, constants.COPYFILE_FICLONE)
  await chmod(executable, 0o755)
  server = await startServer()
  await inspectPage(server.url, true)
  await server.stop()
  if (!(await stat(workspacePath)).isDirectory()) {
    throw new Error('mydsh Web did not create its workspace directory')
  }
  const firstHomeEntries = await readdir(home, { recursive: true })
  if (firstHomeEntries.length === 0) throw new Error('mydsh Web created no persistent Harness-home state')

  server = await startServer()
  await inspectPage(server.url, false, screenshot)
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
