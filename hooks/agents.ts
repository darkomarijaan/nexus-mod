/**
 * The Agents panel: one record per subagent of this session, kept current by
 * the engine's events and checked against its list, and the text it shows.
 */

import type { NexusAgentRun } from '../types'
import { tokens } from './lean'
import { clip } from './util'

export type AgentRun = NexusAgentRun

export const MAX_RUNS = 50
export const QUIET_MS = 2 * 60_000
// A spawn the engine's list has not caught up with yet is not ended.
const GRACE_MS = 10_000
const NOTE_MAX = 60

export const STEP_TOOL = 'mcp__nexus__step'

export const STEP_DESCRIPTION =
  'For subagents only: report progress on your own task to the Agents panel. ' +
  'Right after reading your task, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
  'call it again as each step finishes. Cheap and silent: it only draws a bar.'

export const STEP_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
    total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
    note: { type: 'string', description: 'The step in progress, a few words.' },
  },
  required: ['done'],
} as const

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

function blank(id: string, now: number): AgentRun {
  return {
    id,
    type: 'unknown',
    description: '',
    model: '',
    status: 'running',
    startedAt: now,
    endedAt: null,
    tools: 0,
    lastTool: null,
    lastDetail: null,
    lastActivityAt: now,
    contextTokens: 0,
    tokens: 0,
    step: null,
    inTool: 0,
  }
}

/** A finished agent that works again (resumed by a message, a teammate's next turn) is running again. */
function live(run: AgentRun): AgentRun {
  return run.status === 'running' ? run : { ...run, status: 'running', endedAt: null }
}

/** At most MAX_RUNS: the oldest finished records go first; a running one never does. */
function cap(runs: AgentRun[]): AgentRun[] {
  const extra = runs.length - MAX_RUNS
  if (extra <= 0) return runs
  const drop = new Set(
    runs
      .filter(run => run.status !== 'running')
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
      .slice(0, extra)
      .map(run => run.id),
  )

  return runs.filter(run => !drop.has(run.id))
}

/** Changes the record of `id`, making a basic one first for an agent not seen yet. */
function withRun(runs: readonly AgentRun[], id: string, now: number, change: (run: AgentRun) => AgentRun): AgentRun[] {
  const known = runs.find(run => run.id === id)
  const next = change(known ?? blank(id, now))

  return cap(known === undefined ? [...runs, next] : runs.map(run => (run.id === id ? next : run)))
}

export function onSpawn(runs: readonly AgentRun[], spawn: { agentId: string; type: string; description: string; model: string }, now: number): AgentRun[] {
  return withRun(runs, spawn.agentId, now, () => ({
    ...blank(spawn.agentId, now),
    type: spawn.type || 'agent',
    description: spawn.description,
    model: spawn.model,
  }))
}

export function onToolCall(runs: readonly AgentRun[], call: { agentId: string; tool: string; detail: string }, now: number): AgentRun[] {
  return withRun(runs, call.agentId, now, run => ({
    ...live(run),
    tools: run.tools + 1,
    inTool: run.inTool + 1,
    lastTool: call.tool,
    lastDetail: call.detail === '' ? null : call.detail,
    lastActivityAt: now,
  }))
}

/** A tool call answered: no longer inside it, and that is activity too. */
export function onToolEnd(runs: readonly AgentRun[], end: { agentId: string }, now: number): AgentRun[] {
  return withRun(runs, end.agentId, now, run => ({ ...run, inTool: Math.max(0, run.inTool - 1), lastActivityAt: now }))
}

export function onUsage(runs: readonly AgentRun[], step: { agentId: string; model: string; usage: Usage }, now: number): AgentRun[] {
  const { usage } = step
  const used = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

  return withRun(runs, step.agentId, now, run => ({
    ...live(run),
    model: step.model || run.model,
    contextTokens: used,
    tokens: run.tokens + used,
  }))
}

export function onComplete(runs: readonly AgentRun[], end: { agentId: string; isOk: boolean }, now: number): AgentRun[] {
  return withRun(runs, end.agentId, now, run => ({ ...run, status: end.isOk ? 'done' : 'failed', endedAt: now }))
}

export function onStep(runs: readonly AgentRun[], report: { agentId: string; done: number; total?: number; note?: string }, now: number): AgentRun[] {
  return withRun(runs, report.agentId, now, run => {
    const total = Math.max(1, Math.round(report.total ?? run.step?.total ?? 1))
    const done = Math.min(total, Math.max(0, Math.round(report.done)))
    const note = report.note?.trim() ? clip(report.note, NOTE_MAX) : null

    return { ...live(run), step: { done, total, note }, lastActivityAt: now }
  })
}

/** The engine's AgentStatus as the panel's. */
function statusOf(status: string): AgentRun['status'] {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'ended'

  return 'running'
}

/**
 * Checks the records against the engine's list: adds an agent the hooks
 * missed, and settles a running one the list says finished or no longer has.
 */
export function reconcile(
  runs: readonly AgentRun[],
  list: readonly { id: string; type: string; description: string; status: string }[],
  now: number,
): AgentRun[] {
  let next = runs.map(run => {
    const listed = list.find(one => one.id === run.id)
    if (run.status !== 'running') return listed !== undefined && statusOf(listed.status) === 'running' ? live(run) : run
    if (listed === undefined) return now - run.startedAt > GRACE_MS ? { ...run, status: 'ended' as const, endedAt: now } : run
    const status = statusOf(listed.status)

    return status === 'running' ? run : { ...run, status, endedAt: now }
  })
  for (const one of list) {
    if (next.some(run => run.id === one.id)) continue
    const status = statusOf(one.status)
    // A finished agent past the cap was dropped on purpose; adding it back would push out one with real data.
    if (status !== 'running' && next.length >= MAX_RUNS) continue
    next = [...next, { ...blank(one.id, now), type: one.type || 'agent', description: one.description, status, endedAt: status === 'running' ? null : now }]
  }

  return cap(next)
}

export function isQuiet(run: AgentRun, now: number): boolean {
  return run.status === 'running' && run.inTool === 0 && now - run.lastActivityAt > QUIET_MS
}

/** No window size per subagent reaches a mod: a `[1m]` model is 1M, any other 200k. */
export function contextWindowOf(model: string): number {
  return /\[1m\]/i.test(model) ? 1_000_000 : 200_000
}

export function contextPercent(run: AgentRun): number {
  return Math.min(100, Math.round((run.contextTokens / contextWindowOf(run.model)) * 100))
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function shortModel(model: string): string {
  const name = model.replace(/^claude-/, '').replace(/\[1m\]$/i, '')

  return name === '' ? '?' : name
}

export function stepText(run: AgentRun): string | null {
  if (run.step === null) return null

  return `step ${run.step.done}/${run.step.total}${run.step.note === null ? '' : ` ${run.step.note}`}`
}

export function activityText(run: AgentRun): string | null {
  if (run.lastTool === null) return null

  return run.lastDetail === null ? run.lastTool : `${run.lastTool}  ${run.lastDetail}`
}

/** One line for a finished agent. */
export function finishedText(run: AgentRun): string {
  const took = elapsed((run.endedAt ?? run.startedAt) - run.startedAt)
  const parts = [took, ...(run.model === '' ? [] : [shortModel(run.model)]), `${run.tools} tools`, tokens(run.tokens)]
  if (run.status === 'failed' || run.status === 'ended') parts.push(run.status)

  return parts.join(' · ')
}

export function agentSummary(runs: readonly AgentRun[]): string {
  if (runs.length === 0) return 'No subagent has run in this session yet.'
  const states = (['running', 'done', 'failed', 'ended'] as const)
    .map(status => [status, runs.filter(run => run.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
  const total = runs.reduce((sum, run) => sum + run.tokens, 0)

  return ['Agents', ...states, `${tokens(total)} tokens`].join(' · ')
}

