#!/usr/bin/env node
// claude-nexus: Claude Code with Nexus's provider router in front of it.
// Plain `claude` stays as it is (Remote Control works there; not here, since
// ANTHROPIC_BASE_URL points at this router).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { constants as osConstants, homedir } from 'node:os'
import { delimiter, join } from 'node:path'

import { startRouter } from './router.mjs'

const token = randomBytes(32).toString('hex')
const controlToken = randomBytes(32).toString('hex')
const logFile = process.env.NEXUS_ROUTER_DEBUG === '1' ? join(homedir(), '.claude', 'nexus', `router-${process.pid}.log`) : null
if (logFile !== null) mkdirSync(join(homedir(), '.claude', 'nexus'), { recursive: true })
const log = line => {
  if (logFile !== null) appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
}

const router = await startRouter({ token, controlToken, log, debug: logFile !== null })

for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
  if (process.env[name]) console.error(`claude-nexus: ${name} is set, so it, not your claude.ai login, reaches Anthropic on the Claude route.`)
}

const own = process.env.ANTHROPIC_CUSTOM_HEADERS
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${router.port}`,
  ANTHROPIC_CUSTOM_HEADERS: own ? `${own}\nx-nexus-router: ${token}` : `x-nexus-router: ${token}`,
  NEXUS_ROUTER_TOKEN: controlToken,
}
const claude = process.env.CLAUDE_NEXUS_CLAUDE ?? 'claude'
const args = process.argv.slice(2)
const windows = process.platform === 'win32'

const quote = text => `"${text.replaceAll('"', '\\"')}"`

// An npm-style claude.cmd shim cannot be spawned without a shell on Windows.
const isShim = command => /\.(cmd|bat)$/i.test(command)
const resolvesToShim = command => {
  if (isShim(command)) return true
  const bases = /[\/]/.test(command) ? [command] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, command))
  return bases.some(base => existsSync(`${base}.cmd`) || existsSync(`${base}.bat`))
}

let child
const forward = signal => () => {
  if (child !== undefined) child.kill(signal)
}

const finish = async code => {
  try {
    await router.close()
  } finally {
    process.exit(code)
  }
}

const fail = async error => {
  console.error(`claude-nexus: could not start ${claude}: ${error.message}`)
  await finish(1)
}

const start = useShell => {
  const options = { stdio: 'inherit', env }
  try {
    child = useShell ? spawn(quote(claude), args.map(quote), { ...options, shell: true }) : spawn(claude, args, options)
  } catch (error) {
    return onError(error, useShell)
  }
  child.on('error', error => onError(error, useShell))
  child.on('exit', (code, signal) => {
    // Killed by a signal: the shell convention, 128 + the signal number.
    finish(code ?? (signal === null ? 0 : 128 + (osConstants.signals[signal] ?? 1)))
  })
}

const onError = (error, wasShell) => {
  const retry = windows && !wasShell && (error.code === 'EINVAL' || (error.code === 'ENOENT' && resolvesToShim(claude)))
  if (retry) return start(true)
  return fail(error)
}

// ctrl+c belongs to claude, which shares this console. Termination signals go to
// claude too, so the launcher is never gone while claude still talks to the router.
process.on('SIGINT', () => {})
process.on('SIGTERM', forward('SIGTERM'))
process.on('SIGHUP', forward('SIGHUP'))

start(windows && isShim(claude))
