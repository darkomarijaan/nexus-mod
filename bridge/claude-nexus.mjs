#!/usr/bin/env node
// claude-nexus: Claude Code with Nexus's provider router in front of it.
// Plain `claude` stays as it is (Remote Control works there; not here, since
// ANTHROPIC_BASE_URL points at this router).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { constants as osConstants, homedir } from 'node:os'
import { delimiter, join } from 'node:path'

import { startRouter } from './router.mjs'
import { latestSession, resumeHint } from './resume.mjs'

const startedAt = Date.now()

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

// Claude Code applies the env of its settings files on top of ours, so these names there would undo the router.
const OVERRIDES = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_AUTH_TOKEN']
for (const file of [join(homedir(), '.claude', 'settings.json'), join(process.cwd(), '.claude', 'settings.json'), join(process.cwd(), '.claude', 'settings.local.json')]) {
  let settings
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    continue
  }
  const set = settings !== null && typeof settings === 'object' && settings.env !== null && typeof settings.env === 'object' ? settings.env : {}
  for (const name of OVERRIDES) {
    if (name in set) console.error(`claude-nexus: ${file} sets ${name} in its env, which overrides what claude-nexus sets for the router; remove it, or requests will bypass the router or be refused.`)
  }
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

// Claude prints its hint only on a terminal; so do we.
const printResumeHint = () => {
  if (!process.stdout.isTTY) return
  try {
    const id = latestSession(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), process.cwd(), startedAt)
    if (id !== undefined) process.stdout.write(`\x1b[2m${resumeHint('claude-nexus', id)}\x1b[22m\n`)
  } catch {}
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
    printResumeHint()
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
