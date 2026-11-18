// .env files for claude-nexus: the variables the router itself needs (the optional Jev key), found in a file
// instead of the shell. They are given to the router and to nothing else: the claude process, and so the tools
// it runs, never receive them, and nothing here logs a name or a value.
//
// Looked in, highest priority first: the file named by NEXUS_ENV_FILE, then .env in the folder claude-nexus was
// started from, then ~/.claude/nexus/.env. The process environment beats all of them (an empty value does not).
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_BYTES = 64 * 1024

/** KEY=value lines: optional `export`, one pair of quotes, `#` comments. Nothing is expanded or run. */
export function parseEnv(text) {
  const out = {}
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const found = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (found === null) continue
    let value = found[2].trim()
    const quote = value[0]
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1)
      value = end === -1 ? value.slice(1) : value.slice(1, end)
    } else {
      const comment = value.search(/\s#/)
      if (comment !== -1) value = value.slice(0, comment).trim()
    }
    out[found[1]] = value
  }

  return out
}

/** The files to try, highest priority first. */
export function envFileCandidates({ env, cwd, home }) {
  const list = []
  if (typeof env.NEXUS_ENV_FILE === 'string' && env.NEXUS_ENV_FILE !== '') list.push(resolve(cwd, env.NEXUS_ENV_FILE))
  list.push(join(cwd, '.env'), join(home, '.claude', 'nexus', '.env'))

  return list
}

/**
 * Reads the files (highest priority first) into one set of variables. A missing, unreadable, oversized or
 * non-file path is skipped without a word; an empty value is no value. `files` names the ones that gave something.
 */
export function loadEnvFiles(paths) {
  const vars = {}
  const files = []
  for (const path of [...paths].reverse()) {
    let found
    try {
      const info = statSync(path)
      if (!info.isFile() || info.size > MAX_BYTES) continue
      found = parseEnv(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const filled = Object.entries(found).filter(([, value]) => value !== '')
    if (filled.length === 0) continue
    for (const [name, value] of filled) vars[name] = value
    files.push(path)
  }

  return { vars, files }
}

/** What the router sees: the files' variables under the process environment, whose empty values do not count. */
export function mergeEnv(fileVars, processEnv) {
  const set = Object.entries(processEnv).filter(([, value]) => typeof value === 'string' && value !== '')

  return { ...fileVars, ...Object.fromEntries(set) }
}
