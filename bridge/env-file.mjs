// .env files for claude-nexus: the variables the router itself needs (the optional Jev key), found in a file
// instead of the shell. They are given to the router and to nothing else: the claude process, and so the tools
// it runs, never receive them, and nothing here logs a name or a value.
//
// Looked in, highest priority first: the file named by NEXUS_ENV_FILE, then ~/.claude/nexus/.env (both the
// person's own), then .env in the folder claude-nexus was started from. The process environment beats all of
// them (an empty value does not).
//
// The folder's .env may belong to a repo the person does not trust, so it ranks last, and the names that set a
// security boundary (PROTECTED) are ignored in it: only the person's own sources can say where a key may go.
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_BYTES = 64 * 1024

/** Names an untrusted .env may not set: the hosts the Jev key may go to, and where the person's own file is. */
export const PROTECTED = ['NEXUS_JEV_HOSTS', 'NEXUS_ENV_FILE']

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

/** The files to try, highest priority first, each with whether it is the person's own (trusted) or the folder's. */
export function envFileCandidates({ env, cwd, home }) {
  const list = []
  if (typeof env.NEXUS_ENV_FILE === 'string' && env.NEXUS_ENV_FILE !== '') list.push({ path: resolve(cwd, env.NEXUS_ENV_FILE), trusted: true })
  list.push({ path: join(home, '.claude', 'nexus', '.env'), trusted: true }, { path: join(cwd, '.env'), trusted: false })

  return list
}

/**
 * Reads the files (highest priority first; a bare path counts as trusted) into one set of variables. A missing,
 * unreadable, oversized or non-file path is skipped without a word; an empty value is no value; an untrusted file
 * cannot set a PROTECTED name. `files` names the ones that gave something.
 */
export function loadEnvFiles(entries) {
  const vars = {}
  const files = []
  for (const entry of [...entries].reverse()) {
    const path = typeof entry === 'string' ? entry : entry.path
    const trusted = typeof entry === 'string' ? true : entry.trusted !== false
    let found
    try {
      const info = statSync(path)
      if (!info.isFile() || info.size > MAX_BYTES) continue
      found = parseEnv(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const filled = Object.entries(found).filter(([name, value]) => value !== '' && (trusted || !PROTECTED.includes(name)))
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
