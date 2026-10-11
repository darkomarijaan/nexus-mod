/**
 * Lean mode: terse replies and minimal code as rules in the system prompt,
 * the /lean-nexus arguments, and the HUD badge. Pure: no $, no I/O.
 */

import type { NexusLeanPick } from '../types'
import { tokens } from './lean'

export type LeanTalk = 'off' | 'lite' | 'ultra'
export type LeanSettings = { talk: LeanTalk; code: boolean }
export type LeanPick = NexusLeanPick

const TALKS: readonly string[] = ['off', 'lite', 'ultra']

export function isLeanTalk(value: unknown): value is LeanTalk {
  return typeof value === 'string' && TALKS.includes(value)
}

/** A stored /lean-nexus pick, keeping only the fields that are valid. */
export function readLeanPick(raw: unknown): LeanPick {
  if (typeof raw !== 'object' || raw === null) return {}
  const { talk, code } = raw as Record<string, unknown>

  return { ...(isLeanTalk(talk) ? { talk } : {}), ...(typeof code === 'boolean' ? { code } : {}) }
}

/** The settings with the person's pick laid over them, field by field. */
export function leanSettings(base: LeanSettings, pick: LeanPick): LeanSettings {
  return { talk: pick.talk ?? base.talk, code: pick.code ?? base.code }
}

export function isOverride(pick: LeanPick): boolean {
  return pick.talk !== undefined || pick.code !== undefined
}

// ── Rules in the system prompt ───────────────────────────────────────────

const LITE = `- Lead with the answer. No greeting, no restating the question, no closing offers or "hope this helps".
- No recaps between tool calls; at most one short line before a call, only when it helps.
- Short sentences. Cut filler, hedging and anything already on screen.
- Keep code, commands, paths, error text and numbers exact.
- Use full, clear sentences for security warnings, irreversible actions, step-by-step instructions, questions to the person, and when the person seems confused.
- These rules hold in whatever language the person writes.`

const ULTRA = `- Telegraphic: fragments are fine, one idea per line; drop articles, connectives and filler; → for "leads to".
- Never drop a negation or limiter: not, no, never, only; tidak, bukan, jangan, hanya; and their equivalents in other languages.`

/** The rungs before writing code; the review prompt climbs the same ones. */
export const LADDER = `1. Does it need to exist at all?
2. Already in the codebase? Reuse it.
3. Standard library?
4. A native platform feature?
5. A dependency already installed? Add a new one only after asking.
6. One line?
7. The minimum that works.`

const NEVER_CUT = 'Never cut: validation at trust boundaries, data-loss handling, security, accessibility.'

export function leanRules(s: LeanSettings): string {
  const parts: string[] = []
  if (s.talk !== 'off') parts.push(`# Terse replies (Nexus lean: ${s.talk})\n${LITE}${s.talk === 'ultra' ? `\n${ULTRA}` : ''}`)
  if (s.code) {
    parts.push(`# Minimal code (Nexus lean)
Read the code you touch first, then stop at the first rung that holds:
${LADDER}
${NEVER_CUT} Logic with a branch, loop, parsing, money or security gets one small test.`)
  }

  return parts.join('\n\n')
}

const FULL_SUMMARY = `# Delivery (Nexus)
- Work quietly: no progress recaps or interim summaries between tool calls. At most one short line before a tool call, and only when it helps.
- When this turn changed files, end with one final reply in plain English for a non-specialist (no jargon, no code unless asked), under exactly these three headings:
  **What Changed**: one line per file touched, naming the file and what changed in it in everyday words.
  **Verification Status**: the lint, type-check and test commands you ran and whether they passed; say plainly if you ran none. Nexus re-runs the project's checks when you stop and sends any failure back to you.
  **Next Steps**: what the person may want to do or decide next, or "None".
- When the turn changed no files, answer plainly without those headings.`

const TERSE_SUMMARY = `# Delivery (Nexus)
- Work quietly: no progress recaps or interim summaries between tool calls.
- When this turn changed files, end with exactly these three headings, terse:
  **What Changed**: one short line per file touched.
  **Verification Status**: one line: the checks you ran and whether they passed (say so if none), plus anything you skipped or left unchecked. Nexus re-runs the project's checks when you stop.
  **Next Steps**: one line, or "None".
- When the turn changed no files, answer plainly without those headings.`

/** The Executive Summary rules: the full report, or the terse one while talk is lean. */
export function summaryRules(talk: LeanTalk): string {
  return talk === 'off' ? FULL_SUMMARY : TERSE_SUMMARY
}

// ── /lean-nexus ──────────────────────────────────────────────────────────

export type LeanCommand =
  | { kind: 'status' }
  | { kind: 'set'; pick: LeanPick }
  | { kind: 'reset' }
  | { kind: 'error'; text: string }

export const LEAN_USAGE = 'Use: /lean-nexus [talk off|lite|ultra] [code on|off] | on | off | reset'

export const LEAN_NOTE = 'Takes effect from the next turn; the prompt cache resets once.'

export function parseLeanArgs(args: string): LeanCommand {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'status' }
  if (words.length === 1 && words[0] === 'reset') return { kind: 'reset' }
  if (words.length === 1 && words[0] === 'on') return { kind: 'set', pick: { talk: 'lite', code: true } }
  if (words.length === 1 && words[0] === 'off') return { kind: 'set', pick: { talk: 'off', code: false } }
  const pick: LeanPick = {}
  for (let i = 0; i < words.length; i += 2) {
    const key = words[i]
    const value = words[i + 1]
    if (key === 'talk' && isLeanTalk(value)) pick.talk = value
    else if (key === 'code' && (value === 'on' || value === 'off')) pick.code = value === 'on'
    else return { kind: 'error', text: `Not understood: "${args.trim()}". ${LEAN_USAGE}` }
  }

  return { kind: 'set', pick }
}

/** `Talk: lite · Minimal code: on` */
export function leanLabel(s: LeanSettings): string {
  return `Talk: ${s.talk} · Minimal code: ${s.code ? 'on' : 'off'}`
}

/** `✂ lite · min` for the HUD, or null when lean mode is off altogether. */
export function leanBadge(s: LeanSettings, icon: string): string | null {
  const parts = [...(s.talk === 'off' ? [] : [s.talk]), ...(s.code ? ['min'] : [])]

  return parts.length === 0 ? null : `${icon} ${parts.join(' · ')}`
}

// ── /lean-review-nexus ───────────────────────────────────────────────────

/** Past this many characters the diff stays out; Claude opens the files itself. */
export const REVIEW_DIFF_LIMIT = 40_000

/** A branch, tag or commit; never something git would read as an option. */
export function isSafeBase(base: string): boolean {
  return base !== '' && !base.startsWith('-') && !/\s/.test(base)
}

/** The untracked paths in `git status --porcelain` output. */
export function untrackedFiles(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter(line => line.startsWith('?? '))
    .map(line => line.slice(3).trim())
    .filter(Boolean)
}

export type ReviewInput = { base: string | null; diff: string; stat: string; untracked: readonly string[] }

export function reviewPrompt(input: ReviewInput): string {
  const changes =
    input.diff !== ''
      ? `Diff:\n\`\`\`diff\n${input.diff}\n\`\`\``
      : `The diff is too large to include; open the files yourself:\n${input.stat}`
  const fresh = input.untracked.length > 0 ? `\n\nNew files (read them too):\n${input.untracked.map(file => `- ${file}`).join('\n')}` : ''

  return `Review these changes${input.base === null ? '' : ` against ${input.base}`} for over-engineering (Nexus lean review). Do not edit any file unless I ask.
For each finding give: file:line, the rung below it breaks, and the simpler alternative. If nothing is over-built, say so in one line.
${LADDER}
${NEVER_CUT} One small test for logic is not excess.

${changes}${fresh}`
}

// ── /compress-nexus ──────────────────────────────────────────────────────

export const COMPRESS_RULES = `You compress a Markdown memory file (CLAUDE.md) for an AI coding assistant so it costs fewer tokens.
- Keep every instruction and fact; drop only filler, repetition and pleasantries.
- Keep exactly, character for character: fenced code blocks, inline code, commands, file paths, URLs, numbers and headings.
- Keep the order of sections.
- Reply with the compressed file only: no preamble, no closing note, no surrounding code fence.`

/** The reply without one code fence wrapped around all of it. */
export function unwrapFence(reply: string): string {
  const text = reply.trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text)

  return fenced?.[1] ?? text
}

/** A rough count, about four characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export type CompressCheck = { ok: true } | { ok: false; reason: string }

const FENCED = /```[\s\S]*?```/g
const URLS = /https?:\/\/[^\s)>\]`'"]+/g
const PATHS = /(?:[A-Za-z]:)?(?:~|\.{1,2})?[\\/]?[\w.-]+(?:[\\/][\w.-]+)+[\\/]?/g
const NUMBERS = /\d+(?:[.,]\d+)*/g
// "1. " at the start of a list item is numbering, not a fact.
const LIST_MARKS = /^\s*\d+[.)]\s/gm

function missing(found: readonly string[] | null, text: string): string[] {
  return [...new Set(found ?? [])].filter(one => !text.includes(one))
}

function named(list: readonly string[]): string {
  return list.slice(0, 3).map(one => `\`${one.length > 60 ? `${one.slice(0, 59)}…` : one}\``).join(', ')
}

/** Whether a compressed file kept everything that must not change. */
export function checkCompressed(original: string, result: string): CompressCheck {
  const before = original.replace(/\r\n/g, '\n').trim()
  const after = result.replace(/\r\n/g, '\n').trim()
  if (after.length >= before.length) return { ok: false, reason: 'The result is not shorter than the original.' }
  if (after.length < before.length * 0.3) {
    return { ok: false, reason: `The result kept only ${Math.round((after.length / before.length) * 100)}% of the text; too much may be gone.` }
  }
  const blocks = missing(before.match(FENCED), after)
  if (blocks.length > 0) return { ok: false, reason: `${blocks.length} code block${blocks.length === 1 ? '' : 's'} changed or missing.` }
  const prose = before.replace(FENCED, ' ')
  const urls = missing(prose.match(URLS), after)
  if (urls.length > 0) return { ok: false, reason: `${urls.length} URL${urls.length === 1 ? '' : 's'} missing: ${named(urls)}.` }
  const plain = prose.replace(URLS, ' ')
  const paths = missing(plain.match(PATHS), after)
  if (paths.length > 0) return { ok: false, reason: `${paths.length} path${paths.length === 1 ? '' : 's'} missing: ${named(paths)}.` }
  const numbers = missing(plain.replace(LIST_MARKS, ' ').match(NUMBERS), after)
  if (numbers.length > 0) return { ok: false, reason: `${numbers.length} number${numbers.length === 1 ? '' : 's'} missing: ${named(numbers)}.` }

  return { ok: true }
}

/** The file to compress: the project's CLAUDE.md, or `arg` (with ~ for home) resolved against the project. */
export function compressTarget(arg: string, root: string, home: string): string {
  const one = arg.trim().replace(/\\/g, '/')
  if (one === '') return `${root}/CLAUDE.md`
  if (one.startsWith('~/')) return `${home}/${one.slice(2)}`
  if (/^[A-Za-z]:\//.test(one) || one.startsWith('/')) return one

  return `${root}/${one.replace(/^\.\//, '')}`
}

/** `<path>.bak-YYYYMMDD-HHMMSS`, in UTC. */
export function backupName(path: string, ms: number): string {
  const at = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${path}.bak-${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}-${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}`
}

/** The question before writing: the saving and the opening of the result. */
export function compressQuestion(name: string, original: string, result: string): string {
  const from = estimateTokens(original)
  const to = estimateTokens(result)
  const lines = result.split('\n')
  const preview = lines.slice(0, 12).join('\n') + (lines.length > 12 ? '\n…' : '')

  return `Compress ${name}: ≈${tokens(from)} → ≈${tokens(to)} tokens (−${Math.round((1 - to / from) * 100)}%)? The original is kept as a backup.\n\n${preview}`
}
