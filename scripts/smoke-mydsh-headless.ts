/** Keyless release smoke for the sidecar-free mydsh Headless application. */

import { constants, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'

const source = process.argv[2]
if (source === undefined) throw new Error('usage: smoke-mydsh-headless.ts <mydsh-linux-asset>')

const root = await mkdtemp(join(tmpdir(), 'mydsh-headless-smoke-'))
const executable = join(root, 'mydsh')
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const hostBin = join(root, 'host-bin')
const marker = join(workspace, 'landlock-marker.txt')
const patch = join(root, 'headless.cordis.patch.yml')
const apiKey = 'mydsh-keyless-smoke'
const successText = 'MYDSH_HEADLESS_OK'

let server: Awaited<ReturnType<typeof startMockLlmServer>> | undefined
try {
  await Promise.all([mkdir(workspace), mkdir(hostBin)])
  await writeFile(patch, '- id: session-title-llm\n  disabled: true\n')
  await copyFile(resolve(source), executable, constants.COPYFILE_FICLONE)
  await chmod(executable, 0o755)
  for (const [name, candidates] of [
    ['bash', ['/bin/bash', '/usr/bin/bash']],
    ['sh', ['/bin/sh', '/usr/bin/sh']],
    ['true', ['/usr/bin/true', '/bin/true']],
  ] as const) {
    const candidate = candidates.find(path => existsSync(path))
    if (candidate === undefined) throw new Error(`mydsh Headless smoke requires host ${name}`)
    await symlink(candidate, join(hostBin, name))
  }

  server = await startMockLlmServer({
    apiKey,
    sequence: ['tool_call_success', 'success'],
    successText,
    toolName: 'bash',
    toolArguments: JSON.stringify({
      command: `printf 'landlock-ok\\n' > ${marker}`,
      description: 'Write the Landlock smoke marker',
    }),
  })
  const result = await execa(executable, [
    '--profile', 'headless',
    '--patch', patch,
    'Use bash once to write the requested marker, then report the model result.',
  ], {
    cwd: workspace,
    env: {
      DEEPSEEK_API_KEY: apiKey,
      DEEPSEEK_BASE_URL: server.baseURL,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_TELEMETRY_DISABLED: '1',
      HOME: root,
      PATH: hostBin,
    },
    extendEnv: false,
    reject: false,
    timeout: 90_000,
  })
  if (result.timedOut) throw new Error('mydsh Headless exceeded its 90-second release-smoke deadline')
  if (result.exitCode !== 0) {
    throw new Error(`mydsh Headless exited ${String(result.exitCode)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  if (result.stdout !== successText) throw new Error(`unexpected Headless output: ${JSON.stringify(result.stdout)}`)
  if (!existsSync(marker)) {
    const requests = server.requests.map((request) => {
      const messages = typeof request.body === 'object' && request.body !== null && 'messages' in request.body
        ? request.body.messages
        : undefined
      return {
        attempt: request.attempt,
        behavior: request.behavior,
        messages: Array.isArray(messages) ? messages.slice(-2) : messages,
      }
    })
    throw new Error(`the sandboxed Bash call did not write its marker\nrequests:\n${JSON.stringify(requests, null, 2)}\nstderr:\n${result.stderr}`)
  }
  if (await readFile(marker, 'utf8') !== 'landlock-ok\n') throw new Error('the sandboxed Bash call did not write its marker')
  if (server.requests.length !== 2) throw new Error(`mock model received ${String(server.requests.length)} requests, expected 2`)

  const cacheRoot = join(home, 'cache', 'native-executables')
  const cached = await readdir(cacheRoot, { recursive: true })
  const launcher = cached.find(path => basename(path) === 'landlock-run')
  if (launcher === undefined) throw new Error('the embedded Landlock launcher was not materialized')
  const digest = launcher.split(sep)[0]
  if (!/^[0-9a-f]{64}$/u.test(digest ?? '')) throw new Error(`invalid native executable cache path: ${launcher}`)
  console.log('smoke-mydsh-headless: passed')
} finally {
  await server?.close()
  await rm(root, { force: true, recursive: true })
}
