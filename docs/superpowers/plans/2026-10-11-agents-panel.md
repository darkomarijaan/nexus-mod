# Agents panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Panel `/agents-nexus` yang menampilkan setiap subagent sesi ini secara live (model, context, tool, aktivitas terakhir, langkah) dan tetap menyimpan yang sudah selesai, plus tool `step` opsional dan kirim pesan ke subagent.

**Architecture:** Semua logika di modul pure baru `hooks/agents.ts` (fungsi `(runs, input, now) → runs` per event, rekonsiliasi, teks tampilan). `hooks/register.tsx` hanya wiring: hook `agent.spawn`, `tool.call`, `turn.step`, `turn.complete` dan `refreshHud` memanggil fungsi pure lewat satu helper `trackAgents`, lalu pane `PANE.agents` menggambar atom `agentRuns`.

**Tech Stack:** TypeScript + JSX (`h`), Claude Code mod API 2.1.296 (`claude-code`, `claude-code/testing`).

**Spec:** `docs/superpowers/specs/2026-10-11-agents-panel-design.md`

## Global Constraints

- Claude Code ≥ 2.1.296; tanpa dependensi npm.
- `hooks/register.tsx` satu-satunya modul yang menyentuh `$`; logika baru di sibling pure dengan unit test.
- Setiap atom wajib dideklarasikan di `types/index.d.ts` → `PluginState.nexus`, atau `claude plugin validate` gagal.
- Setting baru di tiga tempat: `userConfig` di `.claude-plugin/plugin.json`, `NexusConfig` + `readConfig` di `hooks/config.ts`, `statusText`; plus tabel Settings di README.
- Nama perintah berakhiran `-nexus`; teks yang dilihat pengguna dalam bahasa Inggris.
- Tanpa biaya dalam dolar; panel tidak terbuka sendiri; tidak ada stop paksa.
- Jangan pernah menulis alamat hub asli atau nama profil hub asli pemilik repo (repo publik); contoh dan test memakai `https://hub.example.com/v1` dan `myhub`. Sebelum push, cari keduanya dengan `git grep` (polanya ada di catatan lokal pemilik, tidak di repo) dan pastikan kosong.
- Commit diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Variabel lokal di `register.tsx` tidak boleh bernama sama dengan fungsi yang menerima `$` (mis. `git`): loader mod menolaknya ("the function handed $ … is assigned to elsewhere").
- Test: `claude plugin test .` (semua file, ±20 detik; baca hasil satu file dengan `claude plugin test . 2>&1 | grep -A60 "agents.test"`), `claude plugin validate .`, type-check strict dengan tsconfig sementara di scratchpad (`npx -y -p typescript@5.6.3 tsc -p <tsconfig>`).

## Review Focus

1. **Subagent baru yang belum muncul di `$.agent.list`**: rekonsiliasi tidak boleh langsung menandainya `ended`. Diharapkan: record yang mulai < 10 detik lalu dibiarkan `running`. (Test di Task 1.)
2. **Pencatatan gagal** (mis. `clock.now` tidak tersedia, atom gagal ditulis): tool call dan giliran subagent tetap berjalan, hasilnya tidak berubah. (Test di Task 2.)
3. **Lebih dari 50 subagent**: subagent yang masih `running` tidak pernah dibuang; yang dibuang adalah yang selesai paling lama. (Test di Task 1.)
4. **Tool `step` dipanggil thread utama, atau dengan angka liar** (`done` > `total`, negatif, `total` 0): tidak mengubah apa pun dari thread utama; angka dirapikan untuk subagent. (Test di Task 1 dan Task 3.)
5. **Kirim pesan ke subagent yang sudah selesai atau ke engine yang menolak**: tidak ada Input untuk subagent yang tidak `running`; penolakan engine menjadi toast, bukan error. (Test di Task 4.)

---

### Task 0: Commit hitungan git di HUD yang sudah selesai

Working tree masih berisi pekerjaan hitungan git (sudah lulus 252 test, validate dan tsc). Commit dulu supaya Agents panel mulai dari tree bersih.

**Files:** `hooks/gitstat.ts`, `tests/gitstat.test.ts`, `hooks/register.tsx`, `hooks/state.ts`, `hooks/theme.ts`, `tests/theme.test.ts`, `types/index.d.ts`, `README.md`

- [ ] **Step 1: Pastikan masih hijau**

Run: `claude plugin test . 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"`
Expected: `252 pass`, `0 fail`

- [ ] **Step 2: Commit**

```bash
git add hooks/gitstat.ts tests/gitstat.test.ts hooks/register.tsx hooks/state.ts hooks/theme.ts tests/theme.test.ts types/index.d.ts README.md
git commit -m "HUD: commits to push and pull, and files staged, changed, untracked, in conflict

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Modul pure `hooks/agents.ts`

**Files:**
- Create: `hooks/agents.ts`
- Create: `tests/agents.test.ts`
- Modify: `types/index.d.ts` (tipe `NexusAgentRun`, sebelum `declare module`)

**Interfaces:**
- Consumes: `tokens(count: number): string` dari `hooks/lean.ts`; `clip(text: string, max: number): string` dari `hooks/util.ts`.
- Produces (dipakai Task 2–4):
  - `type AgentRun = NexusAgentRun`
  - `STEP_TOOL = 'mcp__nexus__step'`, `STEP_DESCRIPTION: string`, `STEP_SCHEMA: object`
  - `onSpawn(runs, { agentId, type, description, model }, now): AgentRun[]`
  - `onToolCall(runs, { agentId, tool, detail }, now): AgentRun[]`
  - `onUsage(runs, { agentId, model, usage }, now): AgentRun[]` dengan `usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }`
  - `onComplete(runs, { agentId, isOk }, now): AgentRun[]`
  - `onStep(runs, { agentId, done, total?, note? }, now): AgentRun[]`
  - `reconcile(runs, list: { id: string; type: string; description: string; status: string }[], now): AgentRun[]`
  - `isQuiet(run, now): boolean`, `contextWindowOf(model): number`, `contextPercent(run): number`, `elapsed(ms): string`, `shortModel(model): string`, `stepText(run): string | null`, `activityText(run): string | null`, `finishedText(run): string`, `agentSummary(runs): string`

- [ ] **Step 1: Tambah tipe di `types/index.d.ts`** (tepat sebelum `declare module 'claude-code' {`)

```ts
/** One subagent of this session as the Agents panel shows it. */
export type NexusAgentRun = {
  id: string
  type: string
  description: string
  model: string
  /** ended: gone from the engine's list without a turn.complete seen. */
  status: 'running' | 'done' | 'failed' | 'ended'
  startedAt: number
  endedAt: number | null
  tools: number
  lastTool: string | null
  lastDetail: string | null
  lastActivityAt: number
  /** The last request's input, cache reads and writes, and output. */
  contextTokens: number
  /** Every request's, summed. */
  tokens: number
  step: { done: number; total: number; note: string | null } | null
}
```

- [ ] **Step 2: Tulis test yang gagal** — `tests/agents.test.ts`

```ts
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
```

- [ ] **Step 3: Jalankan, pastikan gagal**

Run: `claude plugin test . 2>&1 | grep -A6 "agents.test"`
Expected: `cannot import "../hooks/agents"`

- [ ] **Step 4: Implementasi `hooks/agents.ts`**

```ts
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
  }
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
    ...run,
    tools: run.tools + 1,
    lastTool: call.tool,
    lastDetail: call.detail === '' ? null : call.detail,
    lastActivityAt: now,
  }))
}

export function onUsage(runs: readonly AgentRun[], step: { agentId: string; model: string; usage: Usage }, now: number): AgentRun[] {
  const { usage } = step
  const used = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

  return withRun(runs, step.agentId, now, run => ({
    ...run,
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

    return { ...run, step: { done, total, note }, lastActivityAt: now }
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
    if (run.status !== 'running') return run
    const listed = list.find(one => one.id === run.id)
    if (listed === undefined) return now - run.startedAt > GRACE_MS ? { ...run, status: 'ended' as const, endedAt: now } : run
    const status = statusOf(listed.status)

    return status === 'running' ? run : { ...run, status, endedAt: now }
  })
  for (const one of list) {
    if (next.some(run => run.id === one.id)) continue
    const status = statusOf(one.status)
    next = [...next, { ...blank(one.id, now), type: one.type || 'agent', description: one.description, status, endedAt: status === 'running' ? null : now }]
  }

  return cap(next)
}

export function isQuiet(run: AgentRun, now: number): boolean {
  return run.status === 'running' && now - run.lastActivityAt > QUIET_MS
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
```

- [ ] **Step 5: Jalankan, pastikan lulus**

Run: `claude plugin test . 2>&1 | grep -A40 "agents.test"` lalu `claude plugin test . 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"`
Expected: semua test `agents.test` pass; total `0 fail`

- [ ] **Step 6: Commit**

```bash
git add hooks/agents.ts tests/agents.test.ts types/index.d.ts
git commit -m "agents: pure records for the Agents panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pelacakan dari hook, `/agents-nexus`, dan pane (baca saja)

**Files:**
- Modify: `hooks/register.tsx` (import, atom, helper `trackAgents`, hook `agent.spawn` ±2915, hook baru `tool.call` untuk aktivitas, `turn.step` ±2726, `turn.complete` ±2797, `refreshHud` ±380, `COMMANDS`, perintah, pane)
- Modify: `hooks/state.ts` (`PANE.agents`)
- Modify: `types/index.d.ts` (`agentRuns` di `PluginState`)
- Test: `tests/agents.test.ts`

**Interfaces:**
- Consumes: semua fungsi Task 1; `describeInput(input: unknown): string` (`hooks/util.ts`); `themedBar`, `themeOf` (`hooks/theme.ts`); `openPane($, id, title)` (sudah ada di `register.tsx`).
- Produces: atom `agentRuns`; `async function trackAgents($: Engine, change: (runs: AgentRun[], now: number) => AgentRun[]): Promise<void>`; `PANE.agents = 'nexus-agents'`; perintah `agents-nexus`.

- [ ] **Step 1: Tulis test yang gagal** (tambahkan di akhir `tests/agents.test.ts`; tambahkan `mock` ke import `claude-code/testing`, dan `import type { On } from 'claude-code'`)

```ts
const QUIET = {
  checkpoints: false,
  autoVerify: false,
  designLens: false,
  assumptionAudit: 'off',
  handoff: false,
  notify: false,
  suggestNext: false,
  compactGuard: false,
  loopGuard: false,
  trimOutput: false,
  quotaGuard: 0,
  turnFooter: false,
} as const

const PANE = { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

/** Every string a drawn tree holds, joined, so a row can be matched as the terminal shows it. */
async function drawnText(ui: { drawn: () => Promise<unknown> }): Promise<string> {
  const flat = (one: unknown): string => {
    if (typeof one === 'string' || typeof one === 'number') return String(one)
    if (Array.isArray(one)) return one.map(flat).join('')
    if (one === null || typeof one !== 'object') return ''
    return flat((one as { children?: unknown }).children)
  }
  return flat(await ui.drawn())
}

/** The engine beneath the plugin for one subagent's life. */
function engine(on: On) {
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('tool.call', { tool: 'Grep' }, () => ({ result: {} as never }))
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', index: 0, text: '' } as never
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { ...USAGE, model: 'claude-haiku-5-5' },
    } as never
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

const spawnOne = ($: { agent: { spawn: (input: never) => Promise<unknown> } }) =>
  $.agent.spawn({
    tool_use_id: 't1',
    prompt: 'look around',
    description: 'Find coupon call sites',
    subagentType: 'Explore',
    provider: { kind: 'tool' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as never)

describe('/agents-nexus', () => {
  test('a subagent is followed from spawn to finish', { options: QUIET }, async ($, on) => {
    mock.clock(on)
    engine(on)
    await spawnOne($ as never)
    await $.tool.call({ tool: 'Grep', pattern: 'applyCoupon', agentId: 'a1' } as never)
    for await (const _ of $.turn.step({ turnId: 's1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' } as never)) {
      // drain the stream
    }
    await $.command.run({ command: 'agents-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-agents', props: PANE })
    const live = await drawnText(ui)
    expect(live).toContain('Agents · 1 running')
    expect(live).toContain('Explore')
    expect(live).toContain('Find coupon call sites')
    expect(live).toContain('haiku-5-5')
    expect(live).toContain('18k')
    expect(live).toContain('1 tools')
    expect(live).toContain('Grep  applyCoupon')
    await $.turn.complete({ answer: 'found 4', durationMs: 5000, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'a1' } as never)
    const after = await drawnText(ui)
    expect(after).toContain('1 done')
    expect(after).toContain('Finished')
    await ui.unmount()
  })

  test('the main thread is not a subagent', { options: QUIET }, async ($, on) => {
    mock.clock(on)
    engine(on)
    await $.tool.call({ tool: 'Grep', pattern: 'x' } as never)
    await $.command.run({ command: 'agents-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-agents', props: PANE })
    expect(await drawnText(ui)).toContain('No subagent has run in this session yet.')
    await ui.unmount()
  })

  test('a tool call still answers when the panel cannot record it', { options: QUIET }, async ($, on) => {
    // No clock beneath the plugin: tracking fails, the call must not.
    on('tool.call', { tool: 'Grep' }, () => ({ result: { matches: 3 } as never }))
    const answer = await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'a9' } as never)
    expect(answer.result).toEqual({ matches: 3 })
  })
})
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `claude plugin test . 2>&1 | grep -A20 "/agents-nexus"`
Expected: FAIL (perintah `agents-nexus` tidak dikenal / pane kosong)

- [ ] **Step 3: `hooks/state.ts` — tambah pane**

```ts
  provider: 'nexus-provider',
  mcp: 'nexus-mcp',
  agents: 'nexus-agents',
} as const
```

- [ ] **Step 4: `types/index.d.ts` — atom di `PluginState.nexus`** (setelah `mcpRows`)

```ts
      /** The subagents of this session for the Agents panel; never stored across sessions. */
      agentRuns: NexusAgentRun[]
```

- [ ] **Step 5: `hooks/register.tsx` — import, atom, helper**

Import (di samping import `./gitstat`):

```ts
import {
  type AgentRun,
  activityText,
  agentSummary,
  contextPercent,
  elapsed,
  finishedText,
  isQuiet,
  onComplete,
  onSpawn,
  onToolCall,
  onUsage,
  reconcile,
  shortModel,
  STEP_TOOL,
  stepText,
} from './agents'
```

Atom (setelah `const mcpView = …`):

```ts
// The subagents of this session for the Agents panel.
const agentRuns = atom({ plugin: 'nexus', key: 'agentRuns' } as const, [] as AgentRun[])
```

Helper (di bagian `// ═══ 1. Host`, setelah `refreshHud`):

```ts
/** Records a subagent event for the Agents panel; a failure here never reaches the call it watched. */
async function trackAgents($: Engine, change: (runs: AgentRun[], now: number) => AgentRun[]): Promise<void> {
  try {
    const now = await $.clock.now()
    await update($, agentRuns, runs => change(runs, now))
  } catch {
    // the panel is a view; the call it watched stands
  }
}
```

Catatan: `refreshHud` dideklarasikan sebelum `trackAgents`; fungsi `async` di-hoist, jadi pemanggilan dari `refreshHud` aman.

- [ ] **Step 6: Wiring di hook yang sudah ada**

`refreshHud`, setelah `await update($, hud, () => next)`:

```ts
  await trackAgents($, (runs, at) => reconcile(runs, agents.map(agent => ({ id: agent.id, type: agent.type, description: agent.description, status: agent.status })), at))
```

`agent.spawn`, ganti blok `if (id !== undefined) { … }`:

```ts
    if (id !== undefined) {
      const at = await $.clock.now()
      await update($, work, now => ({ ...now, agentStarts: { ...now.agentStarts, [id]: at } }))
      await trackAgents($, (runs, now) =>
        onSpawn(runs, { agentId: id, type: String(e.subagentType ?? ''), description: String(e.description ?? ''), model: String(result.model ?? '') }, now),
      )
    }
```

`turn.step`, ganti `if (e.agentId !== undefined) return yield* stream`:

```ts
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const done = yield* stream
      const usage = done.usage
      if (usage !== null) {
        await trackAgents($, (runs, now) => onUsage(runs, { agentId, model: usage.model || e.model, usage }, now))
      }

      return done
    }
```

`turn.complete`, ganti `if (e.agentId !== undefined) return result`:

```ts
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await trackAgents($, (runs, now) => onComplete(runs, { agentId, isOk: e.reason === 'answer' }, now))

      return result
    }
```

Hook aktivitas baru, tepat sebelum komentar `// ── Guards on every other tool call`:

```ts
  // ── Subagent activity for the Agents panel: the last tool each one ran ─
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const agentId = e.agentId
    if (agentId !== undefined && e.tool !== STEP_TOOL) {
      await trackAgents($, (runs, now) => onToolCall(runs, { agentId, tool: String(e.tool), detail: describeInput(e) }, now))
    }

    return result
  })
```

- [ ] **Step 7: Perintah dan pane**

`COMMANDS` (setelah `mcp-nexus`):

```ts
  { name: 'agents-nexus', description: 'Nexus: the subagents of this session, live: model, context, tools, last activity', immediate: true },
```

Handler (di samping `mcp-nexus`):

```ts
  on('command.run', { command: 'agents-nexus' }, async $ => {
    await openPane($, PANE.agents, 'Agents')

    return {}
  })
```

Pane (setelah pane `PANE.mcp`):

```tsx
  // Drawer: the subagents of this session, live, then the finished ones.
  on('ui.render', { component: 'Pane', requestId: PANE.agents }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const runs = await read($, agentRuns)
    if (runs.length === 0) return <Text dimColor>{agentSummary(runs)}</Text>
    const th = themeOf(await read($, themeName))
    const ic = th.icons
    const now = await $.clock.now()
    const room = Math.max(12, e.props.bodyColumns - 40)
    const running = runs.filter(run => run.status === 'running')
    const finished = runs.filter(run => run.status !== 'running').reverse()
    const mark = (run: AgentRun) =>
      run.status === 'running' ? (
        <Text color={th.agent}>{ic.dot}</Text>
      ) : run.status === 'done' ? (
        <Text color={th.ok}>{ic.ok}</Text>
      ) : run.status === 'failed' ? (
        <Text color={th.bad}>{ic.fail}</Text>
      ) : (
        <Text color={th.idle}>{ic.dot}</Text>
      )

    return (
      <Box flexDirection="column">
        <Text bold>{agentSummary(runs)}</Text>
        {running.length > 0 && <Text dimColor>Running</Text>}
        {running.map((run, index) => {
          const percent = contextPercent(run)
          const step = stepText(run)
          const activity = activityText(run)
          return (
            <Box key={`agent-${run.id}`} flexDirection="column">
              <Text wrap="truncate-end">
                {index + 1} {mark(run)} <Text color={th.accent}>{run.type}</Text> {clip(run.description, room)}{' '}
                {isQuiet(run, now) ? <Text color={th.warn}>{`${ic.warn} quiet `}</Text> : null}
                <Text dimColor>{elapsed(now - run.startedAt)}</Text>
              </Text>
              <Text wrap="truncate-end" dimColor>
                {'    '}
                {shortModel(run.model)} · ctx <Text color={percent >= 80 ? th.bad : th.ok}>{themedBar(percent, th, 8)}</Text> {tokens(run.contextTokens)} ·{' '}
                {run.tools} tools{step === null ? '' : ` · ${step}`}
              </Text>
              {activity !== null && (
                <Text wrap="truncate-end">
                  {'    '}
                  <Text color={th.warn}>{ic.busy}</Text> {activity}
                </Text>
              )}
            </Box>
          )
        })}
        {finished.length > 0 && <Text dimColor>Finished</Text>}
        {finished.map((run, index) => (
          <Text key={`agent-${run.id}`} wrap="truncate-end">
            {running.length + index + 1} {mark(run)} <Text color={th.accent}>{run.type}</Text> {clip(run.description, room)}{' '}
            <Text dimColor>{finishedText(run)}</Text>
          </Text>
        ))}
        <Text dimColor>Esc close</Text>
      </Box>
    )
  })
```

Pastikan `tokens` dan `clip` sudah diimpor di `register.tsx` (keduanya sudah dipakai di file ini).

- [ ] **Step 8: Jalankan, pastikan lulus**

Run: `claude plugin test . 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"` dan `claude plugin validate . 2>&1 | grep -E "✘|Validation"`
Expected: `0 fail`; `✔ Validation passed with warnings`

- [ ] **Step 9: Commit**

```bash
git add hooks/register.tsx hooks/state.ts types/index.d.ts tests/agents.test.ts
git commit -m "Agents panel: /agents-nexus follows each subagent live

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tool `step` dan setting `agentSteps`

**Files:**
- Modify: `.claude-plugin/plugin.json` (`userConfig.agentSteps`, setelah `maxAgents`)
- Modify: `hooks/config.ts` (`agentSteps`)
- Modify: `hooks/register.tsx` (registrasi tool di `session.start`, hook `tool.call` untuk `STEP_TOOL`, lewati `STEP_TOOL` di Guards, baris `statusText`)
- Test: `tests/agents.test.ts`

**Interfaces:**
- Consumes: `STEP_TOOL`, `STEP_DESCRIPTION`, `STEP_SCHEMA`, `onStep` (Task 1); `trackAgents` (Task 2).
- Produces: `NexusConfig.agentSteps: boolean`.

- [ ] **Step 1: Tulis test yang gagal** (tambahkan di `tests/agents.test.ts`)

```ts
/** The engine calls a session start makes, so `session.start` runs whole. */
function startable(on: On): string[] {
  const registered: string[] = []
  mock.store(on)
  on('session.root', () => ({ value: 'C:/app' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__nexus__${e.name}` } } as never
  })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }) as never)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: [] } }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return registered
}

const START = { cwd: 'C:/app', surface: 'terminal', isInteractive: true } as never

describe('step reports', () => {
  test('a subagent reports its steps; the panel shows them', { options: QUIET }, async ($, on) => {
    mock.clock(on)
    engine(on)
    await spawnOne($ as never)
    const answer = await $.tool.call({ tool: 'mcp__nexus__step', done: 3, total: 5, note: 'writing tests', agentId: 'a1' } as never)
    expect(answer.result).toBe('ok')
    await $.command.run({ command: 'agents-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-agents', props: PANE })
    expect(await drawnText(ui)).toContain('step 3/5 writing tests')
    await ui.unmount()
  })

  test('the main thread is told steps are for subagents', { options: QUIET }, async ($, on) => {
    mock.clock(on)
    engine(on)
    const answer = await $.tool.call({ tool: 'mcp__nexus__step', done: 1 } as never)
    expect(answer.result).toBe('ignored: only subagents report steps')
  })

  test('on by default, the step tool is registered at session start', { options: QUIET }, async ($, on) => {
    const registered = startable(on)
    await $.session.start?.(START)
    expect(registered).toContain('step')
  })

  test('agentSteps off: no step tool', { options: { ...QUIET, agentSteps: false } }, async ($, on) => {
    const registered = startable(on)
    await $.session.start?.(START)
    expect(registered).not.toContain('step')
  })
})
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `claude plugin test . 2>&1 | grep -A20 "step reports"`
Expected: FAIL (`answer.result` bukan `ok`; `step` tidak terdaftar)

- [ ] **Step 3: Setting**

`.claude-plugin/plugin.json`, setelah objek `maxAgents`:

```json
    "agentSteps": {
      "type": "boolean",
      "title": "Agent step reports",
      "description": "Give subagents a step tool to report their progress (step 3/5 writing tests) to the Agents panel. Off: the panel shows what it observes only.",
      "default": true
    },
```

`hooks/config.ts`: di `NexusConfig` setelah `maxAgents: number` tambah `agentSteps: boolean`; di `readConfig` setelah `maxAgents: …` tambah:

```ts
    agentSteps: flag(options.agentSteps, true),
```

`statusText` di `register.tsx`, setelah baris `Subagent cap`:

```ts
    `  Agents panel        /agents-nexus  step reports ${on(cfg.agentSteps)}`,
```

- [ ] **Step 4: Tool dan hook**

Import di `register.tsx`: tambahkan `onStep`, `STEP_DESCRIPTION`, `STEP_SCHEMA` ke import `./agents`.

`session.start`, setelah blok `if (cfg.designLens) { … }`:

```ts
    if (cfg.agentSteps) {
      await $.tool.register({ name: 'step', description: STEP_DESCRIPTION, inputSchema: STEP_SCHEMA, isDeferred: false })
    }
```

Hook baru, setelah hook aktivitas dari Task 2:

```ts
  // A subagent's own report of its steps; the main thread has none to make.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const agentId = e.agentId
    if (agentId === undefined) return { result: 'ignored: only subagents report steps' }
    const input = e as unknown as { done?: unknown; total?: unknown; note?: unknown }
    await trackAgents($, (runs, now) =>
      onStep(
        runs,
        {
          agentId,
          done: Number(input.done ?? 0) || 0,
          ...(input.total === undefined ? {} : { total: Number(input.total) || 1 }),
          ...(typeof input.note === 'string' ? { note: input.note } : {}),
        },
        now,
      ),
    )

    return { result: 'ok' }
  })
```

Di hook Guards, ubah baris pertama pengecualian:

```ts
    if (tool === DESIGN_TOOL || tool === STEP_TOOL || tool === 'AskUserQuestion') return next(e)
```

- [ ] **Step 5: Jalankan, pastikan lulus**

Run: `claude plugin test . 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"` dan `claude plugin validate . 2>&1 | grep -E "✘|Validation"`
Expected: `0 fail`; validate lulus

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json hooks/config.ts hooks/register.tsx tests/agents.test.ts
git commit -m "Agents panel: step reports from subagents (agentSteps, on by default)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pilih dan kirim pesan, tombol `a` di HUD

Mengikuti pola pane Sessions: `1`–`9` memilih baris (atom `selectedAgent`, seperti `selectedPeer`); untuk subagent `running` yang terpilih, muncul Input di bawah daftar dan Enter mengirim. (Spec §4.3 menyebut `m`; ruling: pakai pola Sessions yang sudah ada, tanpa tombol `m` — lebih sedikit state, perilaku sama.)

**Files:**
- Modify: `hooks/register.tsx` (atom `selectedAgent`, `messageAgent`, pane jadi Button + Input, tombol `a` di action bar)
- Modify: `types/index.d.ts` (`selectedAgent: string | null`)
- Modify: `docs/superpowers/specs/2026-10-11-agents-panel-design.md` §4.3 (selaraskan dengan ruling ini)
- Test: `tests/agents.test.ts`

**Interfaces:**
- Consumes: `agentRuns`, `trackAgents`, pane dari Task 2.
- Produces: `async function messageAgent($: Engine, agentId: string, text: string): Promise<void>`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

describe('Agents panel: pick, message, open from the HUD', () => {
  test('picking a running agent and sending a message reaches that agent', { options: QUIET }, async ($, on) => {
    mock.clock(on)
    engine(on)
    const sent: unknown[] = []
    on('session.send', (_, e) => {
      sent.push(e.to)
      return { value: undefined } as never
    })
    on('ui.toast', () => ({ value: undefined }) as never)
    await spawnOne($ as never)
    await $.command.run({ command: 'agents-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-agents', props: PANE })
    expect(((await ui.find({ key: 'agent-a1' })) as { props?: { hotkey?: string } } | undefined)?.props?.hotkey).toBe('1')
    await ui.press({ key: 'agent-a1' })
    await ui.input({ key: 'agent-message', text: 'stop after this file', submit: true } as never)
    expect(sent).toEqual([{ agentId: 'a1' }])
    await ui.unmount()
  })

  test('a finished agent offers no message box', { options: QUIET }, async ($, on) => {
    mock.clock(on)
    engine(on)
    await spawnOne($ as never)
    await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'a1' } as never)
    await $.command.run({ command: 'agents-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-agents', props: PANE })
    await ui.press({ key: 'agent-a1' })
    expect(await ui.find({ key: 'agent-message' })).toBeUndefined()
    await ui.unmount()
  })

  test('a refused message is a toast, not an error', { options: QUIET }, async ($, on) => {
    mock.clock(on)
    engine(on)
    const toasts: string[] = []
    on('session.send', () => {
      throw new Error('no such agent')
    })
    on('ui.toast', (_, e) => {
      toasts.push(String((e as { text?: unknown }).text ?? ''))
      return { value: undefined } as never
    })
    await spawnOne($ as never)
    await $.command.run({ command: 'agents-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-agents', props: PANE })
    await ui.press({ key: 'agent-a1' })
    await ui.input({ key: 'agent-message', text: 'hello', submit: true } as never)
    expect(toasts.join(' ')).toContain('Could not reach that subagent: no such agent')
    await ui.unmount()
  })

  test('the HUD offers a only once a subagent has run', { options: QUIET }, async ($, on) => {
    mock.clock(on)
    engine(on)
    const before = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await before.find({ key: 'agents' })).toBeUndefined()
    await before.unmount()
    await spawnOne($ as never)
    const after = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(((await after.find({ key: 'agents' })) as { props?: { hotkey?: string } } | undefined)?.props?.hotkey).toBe('a')
    await after.unmount()
  })
})
```

Catatan: kalau `ui.input` di kit test memakai nama field lain untuk mengirim (mis. tanpa `submit`), cek `ui.input` di `plugin-authoring/types/claude-code.d.ts` dan pakai bentuk yang dipakai `tests/provider.test.ts` (`ui.input({ key, text })` lalu tekan Enter sesuai kit). Catat sebagai ruling bila berbeda.

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `claude plugin test . 2>&1 | grep -A30 "pick, message"`
Expected: FAIL (`agent-a1` bukan Button; tombol `agents` tidak ada)

- [ ] **Step 3: State dan helper**

`types/index.d.ts`, setelah `agentRuns`:

```ts
      /** The agent picked in the Agents panel, for its message box. */
      selectedAgent: string | null
```

`register.tsx`, setelah atom `agentRuns`:

```ts
const selectedAgent = atom({ plugin: 'nexus', key: 'selectedAgent' } as const, null as string | null)
```

Setelah `messagePeer`:

```ts
async function messageAgent($: Engine, agentId: string, text: string): Promise<void> {
  try {
    await $.session.send({ to: { agentId }, text })
    $.ui.toast('Message sent to the subagent')
  } catch (error) {
    $.ui.toast(`Could not reach that subagent: ${error instanceof Error ? error.message : String(error)}`)
  }
}
```

- [ ] **Step 4: Pane — baris jadi Button, Input untuk yang terpilih**

Di pane `PANE.agents`: ambil `const elements = $.ui.resolve(e)`, `const { Box, Text, Button } = elements`, `const Input = 'Input' in elements ? elements.Input : undefined`, `const chosenId = await read($, selectedAgent)`, `const ordered = [...running, ...finished]`, `const chosen = ordered.find(run => run.id === chosenId)`.

Baris pertama setiap subagent `running` dibungkus Button (isi Text-nya tetap sama dengan Task 2):

```tsx
              <Button
                key={`agent-${run.id}`}
                plain
                {...(index < 9 ? { hotkey: String(index + 1) } : {})}
                onPress={() => update($, selectedAgent, () => run.id)}
              >
                {run.id === chosen?.id ? '▸ ' : ''}
                {mark(run)} <Text color={th.accent}>{run.type}</Text> {clip(run.description, room)}{' '}
                {isQuiet(run, now) ? <Text color={th.warn}>{`${ic.warn} quiet `}</Text> : null}
                <Text dimColor>{elapsed(now - run.startedAt)}</Text>
              </Button>
```

Baris `finished` juga jadi Button (ganti `<Text key={`agent-${run.id}`} …>` dari Task 2):

```tsx
        {finished.map((run, index) => {
          const position = running.length + index
          return (
            <Button
              key={`agent-${run.id}`}
              plain
              {...(position < 9 ? { hotkey: String(position + 1) } : {})}
              onPress={() => update($, selectedAgent, () => run.id)}
            >
              {run.id === chosen?.id ? '▸ ' : ''}
              {mark(run)} <Text color={th.accent}>{run.type}</Text> {clip(run.description, room)} <Text dimColor>{finishedText(run)}</Text>
            </Button>
          )
        })}
```

Ganti `<Text dimColor>Esc close</Text>` dengan:

```tsx
        {chosen !== undefined && chosen.status === 'running' && Input !== undefined && (
          <Input
            key="agent-message"
            placeholder={`Message ${chosen.type}, Enter sends`}
            onSubmit={value => {
              if (value.trim() !== '') void messageAgent($, chosen.id, value.trim())
            }}
          />
        )}
        <Text dimColor>1-9 pick an agent{chosen?.status === 'running' ? ', type to message it' : ''} · Esc close</Text>
```

- [ ] **Step 5: Tombol `a` di HUD**

Di render `AbovePrompt`, tambahkan `read($, agentRuns)` sebagai elemen terakhir `Promise.all` dan nama `agentList` di destrukturisasi:

```ts
    const [now, t, v, cps, working, list, rate, skin, route, pick, agentList] = await Promise.all([
      read($, hud),
      read($, turn),
      read($, verify),
      read($, checkpoints),
      read($, busy),
      read($, tasks),
      read($, speed),
      read($, themeName),
      read($, provider),
      read($, leanPick),
      read($, agentRuns),
    ])
```

Di action bar, setelah Button `idea`:

```tsx
          {agentList.length > 0 && (
            <Button key="agents" plain hotkey="a" label={isWide ? 'Agents' : 'Agt'} onPress={() => void openPane($, PANE.agents, 'Agents')} />
          )}
```

- [ ] **Step 6: Selaraskan spec §4.3**

Ganti paragraf §4.3 dengan:

```markdown
`1`–`9` memilih baris (atom `selectedAgent`, pola yang sama dengan `selectedPeer` di pane Sessions). Untuk subagent `running` yang terpilih, kotak Input muncul di bawah daftar; Enter mengirim lewat `$.session.send({ to: { agentId }, text })`. Subagent yang sudah selesai tidak punya kotak pesan. Gagal kirim memunculkan toast dengan alasannya. Tidak ada cara menghentikan subagent secara paksa di API mod 2.1.296.
```

dan di §3 baris "State" ganti "satu atom baru `agentRuns`" menjadi "dua atom baru: `agentRuns` dan `selectedAgent`".

- [ ] **Step 7: Jalankan, pastikan lulus**

Run: `claude plugin test . 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"` dan `claude plugin validate . 2>&1 | grep -E "✘|Validation"`
Expected: `0 fail`; validate lulus

- [ ] **Step 8: Commit**

```bash
git add hooks/register.tsx types/index.d.ts tests/agents.test.ts docs/superpowers/specs/2026-10-11-agents-panel-design.md
git commit -m "Agents panel: pick a subagent and message it; a opens it from the HUD

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Dokumentasi dan verifikasi penuh

**Files:**
- Modify: `README.md`
- Modify: `hooks/register.tsx` (`statusText`: baris kunci HUD)

- [ ] **Step 1: README**

Di "And the rest", setelah butir **Sessions**:

```markdown
- **Agents panel**: `/agents-nexus` (or `ctrl+x tab a` once a subagent has run) follows every subagent of the session live: its model, a context bar, how many tools it ran and the last one, how long it has run, a `⚠ quiet` mark after two minutes without a tool, and the steps it reports (`step 3/5 writing tests`). Finished ones stay listed with their time, tools and tokens. Pick one with `1`-`9` and type to send it a message. Inspired by [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress).
```

Tabel Commands, setelah `/sessions-nexus`:

```markdown
| `/agents-nexus` | The subagents of this session, live: model, context, tools, last activity, steps; message a running one |
```

Tabel Keys, setelah `i`:

```markdown
| `a` | Agents (once a subagent has run in this session) |
```

Tabel Settings, setelah `Max subagents at once`:

```markdown
| Agent step reports | on | Give subagents a `step` tool to report their progress to the Agents panel |
```

- [ ] **Step 2: `statusText`**

Baris kunci HUD di `statusText`:

```ts
    '  e Enhance   g Send   s Sessions   i Idea   a Agents   z Rollback   p Preview   t Skin   c Commit',
```

dan baris perintah tanpa kunci: tambahkan `/agents-nexus` setelah `/sessions-nexus`.

- [ ] **Step 3: Verifikasi penuh**

Run:
```bash
claude plugin test . 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
claude plugin validate . 2>&1 | grep -E "✘|Validation"
node --test bridge/*.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"
git grep -niE "<nama profil hub asli>|<domain hub asli>"   # pola dari catatan lokal, jangan ditulis di repo
```
Expected: `0 fail`; validate lulus; bridge `fail 0`; grep kosong. Lalu type-check strict (tsconfig sementara di scratchpad yang menunjuk `plugin-authoring/types/claude-code.d.ts`, `hooks`, `types`, `tests`): exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md hooks/register.tsx
git commit -m "README and /nexus: the Agents panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
