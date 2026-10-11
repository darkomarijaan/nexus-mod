import { describe, expect, test } from 'claude-code/testing'

import {
  activityText,
  agentSummary,
  contextPercent,
  contextWindowOf,
  elapsed,
  finishedText,
  isQuiet,
  onComplete,
  onSpawn,
  onStep,
  onToolCall,
  onUsage,
  reconcile,
  shortModel,
  stepText,
  type AgentRun,
} from '../hooks/agents'

const T0 = 1_000_000
const USAGE = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 16_000, cache_creation_input_tokens: 500 }

const spawned = (id = 'a1', now = T0): AgentRun[] =>
  onSpawn([], { agentId: id, type: 'Explore', description: 'Find coupon call sites', model: 'claude-haiku-5-5' }, now)

describe('agent events', () => {
  test('a spawn is a running record with nothing done yet', () => {
    expect(spawned()).toEqual([
      {
        id: 'a1',
        type: 'Explore',
        description: 'Find coupon call sites',
        model: 'claude-haiku-5-5',
        status: 'running',
        startedAt: T0,
        endedAt: null,
        tools: 0,
        lastTool: null,
        lastDetail: null,
        lastActivityAt: T0,
        contextTokens: 0,
        tokens: 0,
        step: null,
      },
    ])
  })

  test('a tool call counts and becomes the last activity', () => {
    const [run] = onToolCall(spawned(), { agentId: 'a1', tool: 'Grep', detail: 'applyCoupon' }, T0 + 5000)
    expect(run).toMatchObject({ tools: 1, lastTool: 'Grep', lastDetail: 'applyCoupon', lastActivityAt: T0 + 5000 })
  })

  test('usage sets the context and adds to the tokens', () => {
    let runs = onUsage(spawned(), { agentId: 'a1', model: 'claude-haiku-5-5', usage: USAGE }, T0)
    runs = onUsage(runs, { agentId: 'a1', model: 'claude-haiku-5-5', usage: { ...USAGE, cache_read_input_tokens: 20_000 } }, T0)
    expect(runs[0]).toMatchObject({ contextTokens: 22_000, tokens: 18_000 + 22_000 })
  })

  test('completion is done on an answer, failed otherwise', () => {
    expect(onComplete(spawned(), { agentId: 'a1', isOk: true }, T0 + 9000)[0]).toMatchObject({ status: 'done', endedAt: T0 + 9000 })
    expect(onComplete(spawned(), { agentId: 'a1', isOk: false }, T0 + 9000)[0]).toMatchObject({ status: 'failed' })
  })

  test('an event for an unknown agent makes a basic record', () => {
    const [run] = onToolCall([], { agentId: 'zz', tool: 'Read', detail: 'a.ts' }, T0)
    expect(run).toMatchObject({ id: 'zz', type: 'unknown', status: 'running', tools: 1, lastTool: 'Read' })
  })

  test('steps are tidied: total at least 1, done between 0 and total, note clipped', () => {
    expect(onStep(spawned(), { agentId: 'a1', done: 9, total: 4, note: 'writing tests' }, T0)[0]?.step).toEqual({ done: 4, total: 4, note: 'writing tests' })
    expect(onStep(spawned(), { agentId: 'a1', done: -2, total: 0 }, T0)[0]?.step).toEqual({ done: 0, total: 1, note: null })
    const later = onStep(onStep(spawned(), { agentId: 'a1', done: 1, total: 5 }, T0), { agentId: 'a1', done: 2 }, T0 + 1000)
    expect(later[0]?.step).toEqual({ done: 2, total: 5, note: null })
    expect(later[0]?.lastActivityAt).toBe(T0 + 1000)
    expect(onStep(spawned(), { agentId: 'a1', done: 1, total: 3, note: 'x'.repeat(200) }, T0)[0]?.step?.note?.length).toBeLessThanOrEqual(60)
  })
})

describe('reconcile with the engine list', () => {
  test('an agent the hooks missed is added from the list', () => {
    const runs = reconcile([], [{ id: 'b2', type: 'Plan', description: 'Draft it', status: 'completed' }], T0)
    expect(runs[0]).toMatchObject({ id: 'b2', type: 'Plan', description: 'Draft it', status: 'done', endedAt: T0 })
  })

  test('a running agent gone from the list is ended; one the list says finished takes that status', () => {
    const started = spawned('a1', T0 - 60_000)
    expect(reconcile(started, [], T0)[0]).toMatchObject({ status: 'ended', endedAt: T0 })
    expect(reconcile(started, [{ id: 'a1', type: 'Explore', description: '', status: 'failed' }], T0)[0]).toMatchObject({ status: 'failed' })
    expect(reconcile(started, [{ id: 'a1', type: 'Explore', description: '', status: 'killed' }], T0)[0]).toMatchObject({ status: 'ended' })
    expect(reconcile(started, [{ id: 'a1', type: 'Explore', description: '', status: 'waiting' }], T0)[0]).toMatchObject({ status: 'running' })
  })

  test('a just-spawned agent not listed yet stays running', () => {
    expect(reconcile(spawned('a1', T0 - 5000), [], T0)[0]?.status).toBe('running')
  })

  test('finished records are never changed', () => {
    const done = onComplete(spawned(), { agentId: 'a1', isOk: true }, T0 + 1000)
    expect(reconcile(done, [], T0 + 60_000)).toEqual(done)
  })
})

describe('at most 50 records', () => {
  test('the oldest finished ones go; running ones stay', () => {
    let runs: AgentRun[] = []
    for (let i = 0; i < 49; i++) runs = onComplete(onSpawn(runs, { agentId: `d${i}`, type: 'Explore', description: '', model: '' }, T0 + i), { agentId: `d${i}`, isOk: true }, T0 + i)
    runs = onSpawn(runs, { agentId: 'r1', type: 'Plan', description: '', model: '' }, T0 + 100)
    runs = onSpawn(runs, { agentId: 'r2', type: 'Plan', description: '', model: '' }, T0 + 101)
    expect(runs).toHaveLength(50)
    expect(runs.some(run => run.id === 'd0')).toBe(false)
    expect(runs.filter(run => run.status === 'running').map(run => run.id)).toEqual(['r1', 'r2'])
  })
})

describe('what the panel shows', () => {
  const base = spawned()[0] as AgentRun

  test('quiet after two minutes without a tool or a step', () => {
    expect(isQuiet(base, T0 + 120_000)).toBe(false)
    expect(isQuiet(base, T0 + 120_001)).toBe(true)
    expect(isQuiet({ ...base, status: 'done' }, T0 + 999_999)).toBe(false)
  })

  test('the context window from the model name, and the share used', () => {
    expect(contextWindowOf('claude-opus-5-5[1m]')).toBe(1_000_000)
    expect(contextWindowOf('claude-haiku-5-5')).toBe(200_000)
    expect(contextPercent({ ...base, contextTokens: 50_000 })).toBe(25)
    expect(contextPercent({ ...base, contextTokens: 900_000 })).toBe(100)
  })

  test('durations, model names, steps and activity read short', () => {
    expect([elapsed(48_000), elapsed(185_000), elapsed(3_780_000)]).toEqual(['48s', '3m 05s', '1h 03m'])
    expect([shortModel('claude-opus-5-5[1m]'), shortModel('claude-haiku-5-5'), shortModel('')]).toEqual(['opus-5-5', 'haiku-5-5', '?'])
    expect(stepText(base)).toBeNull()
    expect(stepText({ ...base, step: { done: 3, total: 5, note: 'writing tests' } })).toBe('step 3/5 writing tests')
    expect(activityText(base)).toBeNull()
    expect(activityText({ ...base, lastTool: 'Bash', lastDetail: 'npm test' })).toBe('Bash  npm test')
  })

  test('a finished line: time, model, tools, tokens, and how it ended', () => {
    const done = { ...base, status: 'done' as const, endedAt: T0 + 48_000, tools: 9, tokens: 31_000 }
    expect(finishedText(done)).toBe('48s · haiku-5-5 · 9 tools · 31k')
    expect(finishedText({ ...done, status: 'failed' })).toBe('48s · haiku-5-5 · 9 tools · 31k · failed')
    expect(finishedText({ ...done, status: 'ended', model: '' })).toBe('48s · 9 tools · 31k · ended')
  })

  test('the summary counts each state and every token', () => {
    const runs: AgentRun[] = [
      base,
      { ...base, id: 'a2' },
      { ...base, id: 'a3', status: 'done', tokens: 52_000 },
      { ...base, id: 'a4', status: 'failed', tokens: 12_000 },
    ]
    expect(agentSummary(runs)).toBe('Agents · 2 running · 1 done · 1 failed · 64k tokens')
    expect(agentSummary([])).toBe('No subagent has run in this session yet.')
  })
})
