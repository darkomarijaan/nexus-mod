// `claude-nexus jev-key`: stores the Jev key in ~/.claude/nexus/.env without it ever being typed into a chat, a
// command line or a settings file. The key is read from the terminal with nothing echoed (or from a pipe), written
// to the person's own env file and never printed.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { validKeyEnv } from './jev.mjs'

const MAX_KEY = 512

/** Text of an env file with NAME set to value (an existing NAME line is replaced, the rest kept as written). */
export function setEnvLine(text, name, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const mine = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`)
  const line = `${name}=${value}`
  const at = lines.findIndex(one => mine.test(one))
  if (at === -1) lines.push(line)
  else lines[at] = line

  return `${lines.join(eol)}${eol}`
}

/** Text of an env file without the NAME line. */
export function dropEnvLine(text, name) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const mine = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`)
  const lines = text.split(/\r?\n/).filter(one => !mine.test(one))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return lines.length === 0 ? '' : `${lines.join(eol)}${eol}`
}

/** A key as one pasted token: no spaces, quotes or control characters. Returns the key or an error text. */
export function cleanKey(raw) {
  const key = String(raw).trim()
  if (key === '') return { error: 'nothing was entered' }
  if (key.length > MAX_KEY) return { error: 'that is too long to be a key' }
  if (/[\s"'`\\\x00-\x1f]/.test(key)) return { error: 'a key has no spaces, quotes or line breaks; paste only the key' }

  return { key }
}

/** Reads one line from the terminal with nothing echoed, or the first line of a pipe. */
export function readSecret(prompt, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      let data = ''
      input.setEncoding('utf8')
      input.on('data', chunk => {
        data += chunk
      })
      input.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''))
      input.on('error', reject)
      return
    }
    output.write(prompt)
    let value = ''
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    const done = result => {
      input.setRawMode(false)
      input.pause()
      input.removeListener('data', onData)
      output.write('\n')
      result()
    }
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done(() => resolve(value))
        if (char === '\x03') return done(() => reject(new Error('cancelled')))
        if (char === '\x7f' || char === '\b') value = value.slice(0, -1)
        else if (char >= ' ') value += char
      }
    }
    input.on('data', onData)
  })
}

const USAGE = `claude-nexus jev-key [NAME]          paste the Jev key (hidden); NAME defaults to CMD_API_KEY
claude-nexus jev-key --remove [NAME] forget it
The key goes to ~/.claude/nexus/.env, which only claude-nexus's router reads.`

/** Runs the subcommand; resolves to the exit code. `file` and the streams are injectable for tests. */
export async function runJevKey(args, { file = join(homedir(), '.claude', 'nexus', '.env'), input = process.stdin, output = process.stderr } = {}) {
  const remove = args.includes('--remove')
  if (args.includes('--help') || args.includes('-h')) {
    output.write(`${USAGE}\n`)
    return 0
  }
  const name = args.find(one => !one.startsWith('-')) ?? 'CMD_API_KEY'
  if (!validKeyEnv(name)) {
    output.write(`claude-nexus: ${name} cannot hold a Jev key; use CMD_API_KEY, TYPESAFE_API_KEY, JEV_API_KEY or a NEXUS_JEV_ name.\n`)
    return 1
  }
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {}

  if (remove) {
    writeFileSync(file, dropEnvLine(text, name), { mode: 0o600 })
    output.write(`claude-nexus: ${name} removed from ${file}.\n`)
    return 0
  }

  let raw
  try {
    raw = await readSecret(`Jev key for ${name} (nothing is shown as you paste): `, { input, output })
  } catch {
    output.write('claude-nexus: cancelled, nothing was saved.\n')
    return 1
  }
  const { key, error } = cleanKey(raw)
  if (error !== undefined) {
    output.write(`claude-nexus: nothing was saved: ${error}.\n`)
    return 1
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, setEnvLine(text, name, key), { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {}
  output.write(`claude-nexus: ${name} saved to ${file} (${key.length} characters). Start claude-nexus again, then /automodel-nexus jev always (or gray).\n`)

  return 0
}
