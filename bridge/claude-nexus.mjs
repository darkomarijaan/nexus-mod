#!/usr/bin/env node
// claude-nexus: Claude Code with Nexus's provider router in front of it.
// Plain `claude` stays as it is (Remote Control works there; not here, since
// ANTHROPIC_BASE_URL points at this router).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
const child = spawn(claude, process.argv.slice(2), { stdio: 'inherit', env })

// ctrl+c belongs to claude, which shares this console.
process.on('SIGINT', () => {})
child.on('error', async error => {
  console.error(`claude-nexus: could not start ${claude}: ${error.message}`)
  await router.close()
  process.exit(1)
})
child.on('exit', async (code, signal) => {
  await router.close()
  process.exit(code ?? (signal === null ? 0 : 1))
})
