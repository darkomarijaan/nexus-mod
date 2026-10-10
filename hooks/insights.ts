import { clip, untilReset } from './util'

// ── Limit forecast ───────────────────────────────────────────────────────

export type Sample = { at: number; pct: number }

/**
 * Adds a reading of a usage window. A drop means the window reset: the
 * history starts over. Readings older than `keepMs` leave.
 */
export function addSample(list: readonly Sample[], sample: Sample, keepMs: number): Sample[] {
  const last = list.at(-1)
  if (last !== undefined && sample.pct < last.pct - 1) return [sample]
  if (last !== undefined && last.pct === sample.pct && sample.at - last.at < 60_000) return [...list]

  return [...list, sample].filter(one => sample.at - one.at <= keepMs).slice(-240)
}

/**
 * When the window runs out at the pace of its readings, and whether that is
 * before it resets. None until the readings span 5 minutes and rose a point.
 */
export function forecast(
  list: readonly Sample[],
  resetsAt: number | null,
): { outInMs: number; isBeforeReset: boolean } | undefined {
  const first = list[0]
  const last = list.at(-1)
  if (first === undefined || last === undefined) return undefined
  const span = last.at - first.at
  const rise = last.pct - first.pct
  if (span < 5 * 60_000 || rise < 1 || last.pct >= 100) return undefined
  const outInMs = ((100 - last.pct) / rise) * span

  return { outInMs, isBeforeReset: resetsAt === null || last.at + outInMs < resetsAt }
}

/** `out ~1h 10m` when the window runs out before its reset; nothing otherwise. */
export function forecastText(list: readonly Sample[], resetsAt: number | null, now: number): string | undefined {
  const guess = forecast(list, resetsAt)
  if (guess === undefined || !guess.isBeforeReset) return undefined
  const last = list.at(-1)?.at ?? now

  return `out ~${untilReset(last + guess.outInMs, now)}`
}

// ── Cache freshness ──────────────────────────────────────────────────────

/**
 * How long since the last model request: the prompt cache lives 5 minutes by
 * default (an hour on some plans), so past that the next reply starts cold.
 */
export function cacheAge(lastAt: number, now: number, isWorking: boolean): { text: string; color: string } {
  if (isWorking) return { text: 'live', color: 'green' }
  const minutes = Math.floor(Math.max(0, now - lastAt) / 60_000)
  if (minutes < 5) return { text: `warm ${minutes}m`, color: 'green' }
  if (minutes < 60) return { text: `idle ${minutes}m`, color: 'yellow' }

  return { text: 'cold', color: 'gray' }
}

// ── Next-step suggestion ─────────────────────────────────────────────────

const strip = (line: string) =>
  line
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .trim()

/** The first item under a reply's "Next Steps" heading, as a prompt; none for "None". */
export function nextStepFrom(answer: string): string | undefined {
  const lines = answer.split(/\r?\n/)
  const at = lines.findIndex(line => /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?next steps?(?:\*\*|__)?\s*:?/i.test(line))
  if (at < 0) return undefined
  const inline = strip((lines[at] ?? '').replace(/^.*?next steps?(?:\*\*|__)?\s*:?/i, ''))
  const candidates = [inline, ...lines.slice(at + 1).map(strip)]
  const first = candidates.find(line => line !== '')
  if (first === undefined || /^none\b/i.test(first) || /^#{1,6}\s/.test(first)) return undefined

  return clip(first, 200)
}

// ── Loop detector ────────────────────────────────────────────────────────

export type LoopState = { signature: string; fails: number; repeats: number }

export const NO_LOOP: LoopState = { signature: '', fails: 0, repeats: 0 }

/**
 * Follows a turn's calls: the same call failing three times running, or the
 * same call made six times running, is a loop worth breaking.
 */
export function trackCall(
  state: LoopState,
  signature: string,
  isFailed: boolean,
): { state: LoopState; verdict: 'none' | 'failing' | 'repeating' } {
  const isSame = state.signature === signature
  const next: LoopState = {
    signature,
    fails: isFailed ? (isSame ? state.fails + 1 : 1) : 0,
    repeats: isSame ? state.repeats + 1 : 1,
  }
  const verdict = next.fails === 3 ? 'failing' : next.repeats === 6 ? 'repeating' : 'none'

  return { state: next, verdict }
}

// ── Compaction guard ─────────────────────────────────────────────────────

export type WorkState = {
  files: readonly string[]
  tasks: readonly { label: string; status: string }[]
  checks: string | null
}

/** What compaction must keep, written for the summarizer. */
export function compactInstructions(work: WorkState): string {
  const parts = [
    'Nexus: keep these in the summary, word for word where they are names:',
    '- Every file path read, created or changed, and what was done to each.',
    '- The open task list with each item\'s status.',
    '- Errors met and how each was resolved, or that it is still open.',
    '- Decisions the user made or confirmed, and their reasons.',
    '- The exact next step that was about to be taken.',
  ]
  if (work.files.length > 0) parts.push(`Files changed this session: ${work.files.slice(-40).join(', ')}`)
  const open = work.tasks.filter(task => task.status !== 'completed')
  if (open.length > 0) parts.push(`Open tasks: ${open.map(task => `${task.label} (${task.status})`).join('; ')}`)
  if (work.checks !== null) parts.push(`Last lint/test result: ${work.checks}`)

  return parts.join('\n')
}

// ── Session handoff ──────────────────────────────────────────────────────

export type Handoff = {
  at: number
  files: string[]
  tasks: { label: string; status: string }[]
  checks: string | null
  lastPrompt: string
  turns: number
}

/** The handoff as the next session reads it. */
export function handoffText(record: Handoff, now: number): string {
  const open = record.tasks.filter(task => task.status !== 'completed')
  const lines = [`Last session in this project, ${agoText(record.at, now)} ago (${record.turns} turn${record.turns === 1 ? '' : 's'}):`]
  if (record.lastPrompt !== '') lines.push(`- Last request: ${clip(record.lastPrompt, 160)}`)
  lines.push(
    record.files.length === 0
      ? '- No files changed.'
      : `- Files changed (${record.files.length}): ${record.files.slice(-15).join(', ')}${record.files.length > 15 ? ', …' : ''}`,
  )
  if (open.length > 0) lines.push(`- Unfinished tasks: ${open.map(task => task.label).join('; ')}`)
  if (record.checks !== null) lines.push(`- Last checks: ${record.checks}`)

  return lines.join('\n')
}

/** One line for the toast at session start. */
export function handoffLine(record: Handoff, now: number): string {
  const open = record.tasks.filter(task => task.status !== 'completed').length
  const bits = [`${record.files.length} file${record.files.length === 1 ? '' : 's'} changed`]
  if (open > 0) bits.push(`${open} task${open === 1 ? '' : 's'} unfinished`)

  return `Last session ${agoText(record.at, now)} ago: ${bits.join(', ')}. /handoff-nexus to see or resume it.`
}

function agoText(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`

  return `${Math.round(minutes / 1440)}d`
}

// ── Commit helper ────────────────────────────────────────────────────────

/** A one-line commit subject from the model's reply, kept to git's conventions. */
export function commitSubject(raw: string): string | undefined {
  const line = raw
    .split(/\r?\n/)
    .map(one => one.replace(/^\s*(?:commit message|subject)\s*:\s*/i, '').replace(/^["'`\s]+|["'`\s]+$/g, ''))
    .find(one => one !== '')
  if (line === undefined) return undefined

  return clip(line.replace(/\.$/, ''), 72)
}
