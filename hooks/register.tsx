import { atom, read, update } from 'claude-code'
import type { ApiContentBlock, EngineInterface, Register } from 'claude-code'

import type {
  NexusCheck,
  NexusCheckpoint,
  NexusDesign,
  NexusDesignOption,
  NexusHud,
  NexusPeer,
  NexusPeerStatus,
  NexusProviderView,
  NexusRouterLink,
  NexusShieldAlert,
  NexusSpeed,
  NexusTask,
  NexusTurn,
  NexusVerify,
  NexusWork,
} from '../types'
import { type NexusConfig, readConfig } from './config'
import { comparePage, designPage, isHex, tokensOf } from './design'
import {
  anchorText,
  contextReport,
  crossedWindows,
  footerText,
  isNoisyCommand,
  lastRequestIn,
  mcpServerOf,
  offDescription,
  tokens,
  trimOutput,
  type Window,
  WINDOW_NAMES,
  windowKey,
} from './lean'
import {
  type DraftStep,
  DRAFT_STEPS,
  draftToProfile,
  fallbackChoices,
  hubBadge,
  maskKey,
  needsCompaction,
  nextStep,
  normalizeHubUrl,
  parseProviderArgs,
  pendingRouteFor,
  primaryModel,
  readProfiles,
  restartCommand,
  routerLinkFrom,
  toggleTarget,
  type PendingRoute,
  type ProviderProfile,
  validateProfile,
} from './provider'
import { masksIn, maskSecrets } from './secrets'
import { claudeThemeFor, paint, type Theme, THEMES, isTheme, themedBar, themeListText, themeOf } from './theme'
import { isMutatingCommand, mayPush, scanCommand, type ShieldHit } from './shield'
import {
  addSample,
  cacheAge,
  commitSubject,
  compactInstructions,
  forecastText,
  type Handoff,
  handoffLine,
  handoffText,
  type LoopState,
  NO_LOOP,
  nextStepFrom,
  type Sample,
  trackCall,
} from './insights'
import { DESIGN_TOOL, EMPTY_HUD, EMPTY_WORK, IDLE_PROVIDER, IDLE_TURN, IDLE_VERIFY, PANE } from './state'
import {
  ago,
  applyTaskUpdate,
  callSignature,
  clip,
  compact,
  describeInput,
  limitLabel,
  parseAssumptions,
  peerStatus,
  readLimits,
  readTicks,
  shortHash,
  slash,
  stamp,
  tail,
  taskMeter,
  tasksFromTodos,
  tokensPerSecond,
  untilReset,
  cacheHitPercent,
  cutoffLabel,
} from './util'

/*
 * Nexus: one runtime suite. The engine follows `$` only within this file, so
 * every function that touches the engine lives here, in five parts:
 *   1. host       paths, git, processes, the browser
 *   2. workspace  HUD data, checkpoints, checks, ideas, design lens, preview
 *   3. guards     command shield, assumption review, secret masking
 *   4. delivery   quiet-work and summary rules, auto lint/test with self-heal
 *   5. layout     the one coordinator that draws the band, the drawers,
 *                 the spinner and the tool rows
 * Pure logic (rules, patterns, page builders) sits in the sibling modules.
 */

type Engine = EngineInterface

// Session state the drawings read; a write redraws exactly its readers.
const hud = atom({ plugin: 'nexus', key: 'hud' } as const, EMPTY_HUD)
const turn = atom({ plugin: 'nexus', key: 'turn' } as const, IDLE_TURN)
const verify = atom({ plugin: 'nexus', key: 'verify' } as const, IDLE_VERIFY)
const checkpoints = atom(
  { plugin: 'nexus', key: 'checkpoints' } as const,
  [] as NexusCheckpoint[],
)
const design = atom(
  { plugin: 'nexus', key: 'design' } as const,
  null as NexusDesign | null,
)
const ideas = atom({ plugin: 'nexus', key: 'ideas' } as const, [] as string[])
const busy = atom({ plugin: 'nexus', key: 'busy' } as const, null as string | null)
const selectedPeer = atom(
  { plugin: 'nexus', key: 'selectedPeer' } as const,
  null as string | null,
)
const healAttempts = atom({ plugin: 'nexus', key: 'healAttempts' } as const, 0)
const shieldAlert = atom(
  { plugin: 'nexus', key: 'shieldAlert' } as const,
  null as NexusShieldAlert | null,
)
const bridgePort = atom(
  { plugin: 'nexus', key: 'bridgePort' } as const,
  null as number | null,
)
// Claude's todo/task list, which drives the HUD's progress meter.
const tasks = atom({ plugin: 'nexus', key: 'tasks' } as const, [] as NexusTask[])
// Speed, cache hits and any cut-off of the latest main-thread model response.
const speed = atom({ plugin: 'nexus', key: 'speed' } as const, null as NexusSpeed | null)
// What the session did across turns: handoff, compaction and commit read it.
const work = atom({ plugin: 'nexus', key: 'work' } as const, EMPTY_WORK)
// The theme (skin) every drawing reads; /skin-nexus writes it and $.store keeps it.
const themeName = atom({ plugin: 'nexus', key: 'theme' } as const, 'default')
// The provider route this session uses, the profiles (keys masked) and the pane's draft.
const provider = atom({ plugin: 'nexus', key: 'provider' } as const, IDLE_PROVIDER)
// The router a claude-nexus session runs behind; its control token lives here once the env forgets it.
const routerLink = atom({ plugin: 'nexus', key: 'routerLink' } as const, null as NexusRouterLink | null)
// The listening loop's generation: a reload starts a newer one, and the older ends at its next turn of the loop.
const routerWatcher = atom({ plugin: 'nexus', key: 'routerWatcher' } as const, 0)
// When Claude's limit resets after a fallback, so a turn's end can offer the way back.
const claudeBackAt = atom({ plugin: 'nexus', key: 'claudeBackAt' } as const, null as number | null)

// Readings of each usage window, for the forecast; the module's own, so a
// reload starts them over.
const limitSamples = new Map<string, Sample[]>()

function recordLimits(limits: readonly { kind: string; percentUsed: number }[], at: number): void {
  for (const limit of limits) {
    const keep = limit.kind === 'five_hour' ? 45 * 60_000 : 12 * 3_600_000
    limitSamples.set(limit.kind, addSample(limitSamples.get(limit.kind) ?? [], { at, pct: limit.percentUsed }, keep))
  }
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

// ═══ 1. Host ═════════════════════════════════════════════════════════════

async function homeDir($: Engine): Promise<string> {
  return slash((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.')
}

async function isWindows($: Engine): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT' || /^[A-Za-z]:/.test(await $.session.root())
}

async function nexusDir($: Engine): Promise<string> {
  return `${await homeDir($)}/.claude/nexus`
}

async function projectRoot($: Engine): Promise<string> {
  return slash(await $.session.root())
}

/** Wraps a package manager so Windows finds its .cmd shim without a shell. */
async function viaShim($: Engine, argv: string[]): Promise<string[]> {
  return (await isWindows($)) ? ['cmd', '/d', '/s', '/c', ...argv] : argv
}

async function currentBranch($: Engine): Promise<string | null> {
  try {
    const run = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: await $.session.root(),
      timeoutMs: 4000,
    })

    return run.exitCode === 0 ? run.stdout.trim() || null : null
  } catch {
    return null
  }
}

/** Opens a URL or a file in the person's default browser or app. */
async function openExternal($: Engine, target: string): Promise<boolean> {
  const argv = (await isWindows($))
    ? ['rundll32', 'url.dll,FileProtocolHandler', target]
    : (await $.fs.exists('/System/Library'))
      ? ['open', target]
      : ['xdg-open', target]
  try {
    return (await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0
  } catch {
    return false
  }
}

/** A short system sound: `done` when work finished, `attention` when Claude waits on the person. */
async function playSound($: Engine, kind: 'done' | 'attention'): Promise<void> {
  const argv = (await isWindows($))
    ? [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object Media.SoundPlayer "$env:SystemRoot\\Media\\${kind === 'done' ? 'Windows Notify System Generic.wav' : 'Windows Exclamation.wav'}").PlaySync()`,
      ]
    : (await $.fs.exists('/System/Library'))
      ? ['afplay', `/System/Library/Sounds/${kind === 'done' ? 'Glass' : 'Funk'}.aiff`]
      : ['paplay', `/usr/share/sounds/freedesktop/stereo/${kind === 'done' ? 'complete' : 'dialog-warning'}.oga`]
  try {
    await $.process.run(argv, { timeoutMs: 8000 })
  } catch {
    // no player here: the notification still shows
  }
}

/** A path as the project knows it: relative to its root where it is inside it. */
async function projectPath($: Engine, path: string): Promise<string> {
  const root = `${await projectRoot($)}/`
  const one = slash(path)

  return one.toLowerCase().startsWith(root.toLowerCase()) ? one.slice(root.length) : one
}

// ═══ 2. Workspace ════════════════════════════════════════════════════════

// ── HUD ──────────────────────────────────────────────────────────────────

// The machine's running process ids, read at most every 20 seconds.
let liveRead: { at: number; pids: Set<number> | null } = { at: 0, pids: null }

/** Every running process id, or null when they cannot be read (then no session is hidden). */
async function livePids($: Engine): Promise<Set<number> | null> {
  const now = await $.clock.now()
  if (now - liveRead.at < 20_000) return liveRead.pids
  let pids: Set<number> | null = null
  try {
    const run = (await isWindows($))
      ? await $.process.run(['tasklist', '/FO', 'CSV', '/NH'], { timeoutMs: 8000 })
      : await $.process.run(['ps', '-A', '-o', 'pid='], { timeoutMs: 8000 })
    if (run.exitCode === 0) {
      const found = [...run.stdout.matchAll(/^(?:"[^"]*",")?\s*(\d+)/gm)].map(match => Number(match[1]))
      pids = found.length > 0 ? new Set(found) : null
    }
  } catch {
    // no process list here: show every session file
  }
  liveRead = { at: now, pids }

  return pids
}

/** Reads the session file every running Claude Code process keeps under ~/.claude/sessions. */
async function readPeers($: Engine): Promise<NexusPeer[]> {
  const dir = `${await homeDir($)}/.claude/sessions`
  const selfId = await $.session.id()
  const own = await read($, turn)
  const alive = await livePids($)
  let entries: Awaited<ReturnType<Engine['fs']['list']>>
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const peers: NexusPeer[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Record<string, unknown>
      const id = String(raw.sessionId ?? '')
      if (id === '') continue
      const isSelf = id === selfId
      const pid = Number(raw.pid ?? 0)
      // A file left behind by a session that crashed or was killed.
      if (!isSelf && alive !== null && pid > 0 && !alive.has(pid)) continue
      const rawStatus = String(raw.status ?? 'idle')
      const status: NexusPeerStatus = isSelf
        ? own.isWaiting
          ? 'waiting'
          : own.isWorking
            ? 'working'
            : 'done'
        : peerStatus(rawStatus)
      peers.push({
        id,
        pid,
        name: String(raw.name ?? id.slice(0, 8)),
        cwd: slash(String(raw.cwd ?? '')),
        rawStatus,
        status,
        updatedAt: Number(raw.statusUpdatedAt ?? raw.updatedAt ?? entry.mtimeMs),
        version: String(raw.version ?? ''),
        isSelf,
      })
    } catch {
      // a file caught mid-write; the next tick reads it
    }
  }
  const rank = { working: 0, waiting: 1, done: 2 } as const

  return peers.sort((a, b) =>
    a.isSelf !== b.isSelf ? (a.isSelf ? -1 : 1) : rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt,
  )
}

let branchReadAt = 0

/** Refreshes every HUD field; the branch at most every 15 seconds unless forced. */
async function refreshHud($: Engine, isForced = false): Promise<void> {
  const now = await $.clock.now()
  const [model, usage, peers, agents, before] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    readPeers($),
    $.agent.list().catch(() => []),
    read($, hud),
  ])
  let branch = before.branch
  if (isForced || now - branchReadAt > 15_000) {
    branchReadAt = now
    branch = await currentBranch($)
  }
  const next: NexusHud = {
    branch,
    model,
    tokens: usage.context.tokens ?? null,
    window: usage.context.window,
    percent: usage.context.percent ?? null,
    limits: readLimits(usage.rateLimits ?? []),
    peers,
    agents: agents
      .filter(agent => agent.status !== 'completed' && agent.status !== 'killed')
      .map(agent => ({ id: agent.id, description: agent.description, type: agent.type, status: agent.status })),
    at: now,
  }
  await update($, hud, () => next)
}

// ── Checkpoints: a private shadow repo per project ───────────────────────

const SHADOW_EXCLUDES = [
  '.git/',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  'dist/',
  'build/',
  'target/',
  'coverage/',
  '.claude/ideas.md',
  '*.log',
]

const KEEP_CHECKPOINTS = 40

async function shadowDir($: Engine): Promise<string> {
  return `${await nexusDir($)}/shadow/${await shortHash(await projectRoot($))}`
}

async function shadowGit($: Engine, args: string[], timeoutMs = 120_000) {
  const root = await projectRoot($)
  const dir = await shadowDir($)
  if (!(await $.fs.exists(`${dir}/HEAD`))) {
    const made = await $.process.run(['git', 'init', '-q', '--bare', dir], { timeoutMs: 20_000 })
    if (made.exitCode !== 0) throw new Error(`git init failed: ${made.stderr.trim()}`)
    await $.fs.write(`${dir}/info/exclude`, `${SHADOW_EXCLUDES.join('\n')}\n`)
  }

  return $.process.run(
    [
      'git',
      '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false',
      '-c', 'core.quotepath=off',
      '-c', 'core.longpaths=true',
      '-c', 'user.name=nexus',
      '-c', 'user.email=nexus@localhost',
      `--git-dir=${dir}`,
      `--work-tree=${root}`,
      ...args,
    ],
    { cwd: root, timeoutMs },
  )
}

async function checkpointsKey($: Engine): Promise<string> {
  return `checkpoints.${await shortHash(await projectRoot($))}`
}

async function listCheckpoints($: Engine): Promise<NexusCheckpoint[]> {
  const stored = await $.store.get(await checkpointsKey($))

  return Array.isArray(stored) ? (stored as NexusCheckpoint[]) : []
}

/** Commits the whole working tree (ignored files aside) to the shadow repo. */
async function snapshot(
  $: Engine,
  label: string,
  kind: NexusCheckpoint['kind'],
  turnId: string | null,
): Promise<NexusCheckpoint> {
  const at = await $.clock.now()
  const added = await shadowGit($, ['add', '-A', '--ignore-errors', '.'])
  if (added.exitCode !== 0 && !/warning/i.test(added.stderr)) {
    throw new Error(`snapshot failed: ${added.stderr.trim().slice(0, 300)}`)
  }
  const tree = await shadowGit($, ['write-tree'], 60_000)
  if (tree.exitCode !== 0) throw new Error(`snapshot tree failed: ${tree.stderr.trim()}`)
  // A commit with no parent, held by a ref of its own: dropping the ref lets
  // gc free that snapshot, which a chain of commits on a branch never allows.
  const committed = await shadowGit($, ['commit-tree', tree.stdout.trim(), '-m', label], 30_000)
  if (committed.exitCode !== 0) throw new Error(`snapshot commit failed: ${committed.stderr.trim()}`)
  const sha = committed.stdout.trim()
  const held = await shadowGit($, ['update-ref', `${CHECKPOINT_REF}${sha}`, sha], 10_000)
  if (held.exitCode !== 0) throw new Error(`snapshot ref failed: ${held.stderr.trim()}`)
  const checkpoint: NexusCheckpoint = { sha, label, at, turnId, kind }
  const before = await listCheckpoints($)
  const list = [...before, checkpoint].slice(-KEEP_CHECKPOINTS)
  await $.store.set(await checkpointsKey($), list)
  await update($, checkpoints, () => list)
  for (const dropped of before) {
    if (!list.some(one => one.sha === dropped.sha)) {
      await shadowGit($, ['update-ref', '-d', `${CHECKPOINT_REF}${dropped.sha}`], 10_000).catch(() => undefined)
    }
  }

  return checkpoint
}

const CHECKPOINT_REF = 'refs/nexus/checkpoints/'
const PRUNE_EVERY_MS = 7 * 86_400_000

/**
 * Frees the snapshots no checkpoint keeps, at most once a week per project.
 * Snapshots made before 0.3.1 sit on a branch whose chain keeps all of them;
 * the kept ones get refs of their own first, then the branch goes.
 */
async function pruneShadow($: Engine): Promise<void> {
  if (!(await $.fs.exists(`${await shadowDir($)}/HEAD`))) return
  const key = `shadowPrunedAt.${await shortHash(await projectRoot($))}`
  const now = await $.clock.now()
  const last = await $.store.get(key).catch(() => null)
  if (typeof last === 'number' && now - last < PRUNE_EVERY_MS) return
  await $.store.set(key, now)
  let isHeld = true
  for (const one of await listCheckpoints($)) {
    const held = await shadowGit($, ['update-ref', `${CHECKPOINT_REF}${one.sha}`, one.sha], 10_000)
    isHeld = isHeld && held.exitCode === 0
  }
  if (isHeld) {
    const heads = await shadowGit($, ['for-each-ref', '--format=%(refname)', 'refs/heads/'], 10_000)
    for (const ref of heads.stdout.split('\n').map(line => line.trim()).filter(Boolean)) {
      await shadowGit($, ['update-ref', '-d', ref], 10_000)
    }
  }
  // Not --prune=now: another session's snapshot may be between its tree and its ref.
  await shadowGit($, ['gc', '--quiet', '--prune=1.hour.ago'], 600_000)
}

/** Puts the working tree back to `target`, after a safety snapshot of the present. */
async function restore($: Engine, target: NexusCheckpoint) {
  const root = await projectRoot($)
  const safety = await snapshot($, `safety before rollback to ${target.sha.slice(0, 8)}`, 'safety', null)
  const diff = await shadowGit($, ['diff', '--name-status', '--no-renames', '-z', target.sha, safety.sha], 60_000)
  if (diff.exitCode !== 0) throw new Error(`diff failed: ${diff.stderr.trim()}`)
  const fields = diff.stdout.split('\0').filter(Boolean)
  const restored: string[] = []
  const added: string[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === 'A') added.push(fields[i + 1] ?? '')
    else restored.push(fields[i + 1] ?? '')
  }
  // A file the target lacks that predates it was ignored back then (its
  // .gitignore changed since): keep it rather than delete it.
  const kept: string[] = []
  const removed: string[] = []
  for (const path of added) {
    try {
      if ((await $.fs.stat(`${root}/${path}`)).mtimeMs < target.at - 2000) kept.push(path)
      else removed.push(path)
    } catch {
      removed.push(path)
    }
  }
  for (let i = 0; i < kept.length; i += 100) {
    await shadowGit($, ['rm', '--cached', '-q', '--', ...kept.slice(i, i + 100)], 60_000)
  }
  const reset = await shadowGit($, ['read-tree', '-u', '--reset', target.sha])
  if (reset.exitCode !== 0) throw new Error(`restore failed: ${reset.stderr.trim()}`)

  return { restored, removed, kept }
}

async function runRollback($: Engine, args: string): Promise<string> {
  const arg = args.trim().toLowerCase()
  // Anything else is a typo, never a rollback: restoring the wrong checkpoint costs work.
  if (arg !== '' && arg !== 'list' && arg !== 'undo' && !/^[1-9]\d*$/.test(arg)) {
    return `Nothing rolled back: "${clip(args.trim(), 40)}" is not a choice. Use /rollback-nexus (the latest turn), /rollback-nexus <n> (a number from /rollback-nexus list), /rollback-nexus list, or /rollback-nexus undo.`
  }
  const all = await listCheckpoints($)
  const now = await $.clock.now()
  const turns = all.filter(one => one.kind === 'turn')
  if (arg === 'list') {
    if (turns.length === 0) return 'No checkpoints yet. One is taken before the first file change of each turn.'

    return [
      'Checkpoints, newest first (/rollback-nexus <n> restores one):',
      ...turns
        .slice()
        .reverse()
        .slice(0, 15)
        .map((one, index) => `  ${index + 1}. ${one.sha.slice(0, 8)}  ${ago(one.at, now)} ago  ${clip(one.label, 70)}`),
    ].join('\n')
  }
  if ((await read($, turn)).isWorking) return 'A turn is still running. Let it finish (or press Esc), then roll back.'
  const back = arg === '' || arg === 'undo' ? 1 : Number(arg)
  const target = arg === 'undo' ? all.filter(one => one.kind === 'safety').at(-1) : turns.at(-back)
  if (target === undefined) {
    if (arg === 'undo') return 'There is no rollback to undo.'

    return turns.length === 0
      ? 'No checkpoint yet: nothing has changed since Nexus started watching this project.'
      : `Nothing rolled back: there ${turns.length === 1 ? 'is 1 checkpoint' : `are ${turns.length} checkpoints`}. See /rollback-nexus list.`
  }
  await update($, busy, () => 'Rolling back')
  try {
    const report = await restore($, target)
    await update($, verify, () => ({ phase: 'idle' as const, checks: [], at: now }))
    void refreshHud($, true).catch(() => undefined)
    const kept = report.kept.length > 0 ? ` Kept ${report.kept.length} older ignored file(s).` : ''

    return `Rolled the project back to checkpoint ${target.sha.slice(0, 8)} (${ago(target.at, now)} ago): restored ${report.restored.length} file(s), removed ${report.removed.length} file(s) created since.${kept} Files on disk no longer match what earlier messages describe. Undo with /rollback-nexus undo.`
  } catch (error) {
    return `Rollback failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    await update($, busy, () => null)
  }
}

// ── Lint and test detection ──────────────────────────────────────────────

type CheckPlan = { name: string; argv: string[] }

async function readJson($: Engine, path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(path))

    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function readText($: Engine, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

/** The lint, type and test commands the project already defines. */
async function detectChecks($: Engine): Promise<CheckPlan[]> {
  const root = await projectRoot($)
  const has = (name: string) => $.fs.exists(`${root}/${name}`)
  const plans: CheckPlan[] = []

  const pkg = await readJson($, `${root}/package.json`)
  if (pkg !== null) {
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>
    const pm = (await has('pnpm-lock.yaml'))
      ? 'pnpm'
      : (await has('yarn.lock'))
        ? 'yarn'
        : (await has('bun.lockb')) || (await has('bun.lock'))
          ? 'bun'
          : 'npm'
    for (const script of ['lint', 'typecheck', 'type-check']) {
      if (typeof scripts[script] === 'string') {
        plans.push({ name: `${pm} run ${script}`, argv: await viaShim($, [pm, 'run', script]) })
      }
    }
    const test = scripts.test
    if (typeof test === 'string' && !/no test specified/i.test(test)) {
      plans.push({ name: `${pm} test`, argv: await viaShim($, [pm, 'test']) })
    }
  }

  const pyproject = await readText($, `${root}/pyproject.toml`)
  if (/\[tool\.ruff/.test(pyproject) || (await has('ruff.toml')) || (await has('.ruff.toml'))) {
    plans.push({ name: 'ruff check', argv: ['ruff', 'check', '.'] })
  }
  const hasPytest =
    /\[tool\.pytest/.test(pyproject) ||
    (await has('pytest.ini')) ||
    (await has('conftest.py')) ||
    /\[tool:pytest\]/.test(await readText($, `${root}/setup.cfg`)) ||
    ((await has('tests')) && pyproject !== '')
  if (hasPytest) plans.push({ name: 'pytest', argv: ['python', '-m', 'pytest', '-q', '-x'] })

  if (await has('Cargo.toml')) plans.push({ name: 'cargo test', argv: ['cargo', 'test', '--quiet'] })
  if (await has('go.mod')) {
    plans.push({ name: 'go vet', argv: ['go', 'vet', './...'] })
    plans.push({ name: 'go test', argv: ['go', 'test', './...'] })
  }

  return plans
}

async function runChecks($: Engine, plans: readonly CheckPlan[], timeoutMs: number): Promise<NexusCheck[]> {
  const root = await projectRoot($)
  const results: NexusCheck[] = []
  for (const plan of plans) {
    const started = await $.clock.now()
    try {
      const run = await $.process.run(plan.argv, {
        cwd: root,
        timeoutMs,
        env: { CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
      })
      results.push({
        name: plan.name,
        isOk: run.exitCode === 0,
        ms: (await $.clock.now()) - started,
        tail: tail(`${run.stdout}\n${run.stderr}`, 40),
      })
    } catch (error) {
      results.push({
        name: plan.name,
        isOk: false,
        ms: (await $.clock.now()) - started,
        tail: `could not run: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return results
}

// ── Prompt enhancer ──────────────────────────────────────────────────────

const ENHANCE_RULES = `You rewrite a developer's rough request to Claude Code into a clear, self-contained prompt.
- Keep their intent, language and scope. Never invent features or requirements they did not imply.
- Shape: one line "Goal: ...", then "Context:" naming the concrete project files or folders involved (from the listing, written as @path) and any installed skill or command that clearly fits (as /name), then "Acceptance criteria:" as a short checklist of verifiable outcomes, then "Out of scope:" only when the request implies limits.
- Under 180 words. Output only the rewritten prompt: no preamble, no quotes, no code fences.`

async function projectContext($: Engine): Promise<string> {
  const root = await projectRoot($)
  const lines: string[] = []
  try {
    const top = (await $.fs.list(root)).filter(entry => !entry.name.startsWith('.') || entry.name === '.claude')
    const names = (list: typeof top) => list.map(entry => (entry.kind === 'dir' ? `${entry.name}/` : entry.name)).join(', ')
    lines.push(`Project root entries: ${names(top.slice(0, 60))}`)
    for (const dir of ['src', 'app', 'lib', 'components', 'pages', 'packages', 'tests']) {
      if (top.some(entry => entry.name === dir && entry.kind === 'dir')) {
        lines.push(`${dir}/: ${names((await $.fs.list(`${root}/${dir}`)).slice(0, 40))}`)
      }
    }
  } catch {
    // an unreadable root still gets the request rewritten
  }
  const guide = await readText($, `${root}/CLAUDE.md`)
  if (guide !== '') lines.push(`CLAUDE.md (start):\n${guide.split(/\r?\n/).slice(0, 40).join('\n')}`)
  try {
    const commands = (await $.command.list()).filter(command => command.source !== 'builtin')
    lines.push(
      `Installed skills and commands: ${commands
        .slice(0, 50)
        .map(command => `/${command.name} (${clip(command.description, 60)})`)
        .join('; ')}`,
    )
  } catch {
    // no listing
  }

  return lines.join('\n')
}

/**
 * Rewrites a rough prompt as Goal / Context / Acceptance criteria into the
 * prompt box, for the person to read before sending. `given` is the text of
 * /enhance-nexus; without it, the box's own draft.
 */
async function enhancePrompt($: Engine, cfg: NexusConfig, given?: string): Promise<void> {
  const box = await $.prompt.read()
  const draft = given === undefined ? box : { text: given }
  if (draft.text.trim() === '') {
    $.ui.toast('Type a rough prompt first, then Enhance.')
    return
  }
  await update($, busy, () => 'Enhancing prompt')
  try {
    const result = await $.model.complete({
      model: cfg.helperModel,
      system: ENHANCE_RULES,
      prompt: `${await projectContext($)}\n\nThe developer's rough request:\n${draft.text}`,
      maxTokens: 900,
      timeoutMs: 45_000,
    })
    if (!result.isAnswered) {
      $.ui.toast(`Enhance failed (${result.reason}). Your prompt is unchanged.`)
      return
    }
    if ((await $.prompt.read()).text !== box.text) {
      $.ui.toast('The prompt changed while enhancing; kept your edits.')
      return
    }
    await $.prompt.fill({ text: result.text.trim(), mode: 'replace' })
  } finally {
    await update($, busy, () => null)
  }
}

async function sendPrompt($: Engine): Promise<void> {
  const draft = await $.prompt.read()
  if (draft.text.trim() === '') {
    $.ui.toast('Nothing to send.')
    return
  }
  await $.prompt.fill({ text: '', mode: 'replace' })
  // The person's own words, as if Enter sent them: no "the nexus plugin sent a message" frame.
  await $.prompt.submit({ text: draft.text, asUser: true })
}

// ── Idea scratchpad ──────────────────────────────────────────────────────

async function ideasPath($: Engine): Promise<string> {
  return `${await projectRoot($)}/.claude/ideas.md`
}

async function loadIdeas($: Engine): Promise<void> {
  const lines = (await readText($, await ideasPath($))).split(/\r?\n/).filter(line => line.startsWith('- '))
  await update($, ideas, () => lines.slice(-12))
}

async function addIdea($: Engine, text: string): Promise<void> {
  const idea = text.trim().replace(/\s+/g, ' ')
  if (idea === '') return
  const path = await ideasPath($)
  const body =
    (await readText($, path)) || '# Ideas\n\nCaptured with Nexus /idea-nexus. Kept local; never sent to Claude.\n'
  const line = `- [${stamp(await $.clock.now())}] ${idea}`
  await $.fs.write(path, `${body.trimEnd()}\n${line}\n`)
  await update($, ideas, list => [...list, line].slice(-12))
  $.ui.toast('Idea saved')
}

// ── Design lens ──────────────────────────────────────────────────────────

async function previewsDir($: Engine): Promise<string> {
  return `${await nexusDir($)}/previews`
}

async function previewUrl($: Engine, file: string): Promise<string> {
  const port = await read($, bridgePort)
  if (port !== null) return `http://127.0.0.1:${port}/p/${encodeURIComponent(file)}`
  const path = `${await previewsDir($)}/${file}`

  return (await isWindows($)) ? `file:///${path}` : `file://${path}`
}

async function pickDesign($: Engine, setId: string, optionId: string): Promise<void> {
  const current = await read($, design)
  if (current === null || current.id !== setId) {
    $.ui.toast('That preview is no longer the current one.')
    return
  }
  const option = current.options.find(one => one.id === optionId)
  if (option === undefined) return
  await update($, design, () => null)
  await $.ui.close({ id: PANE.design }).catch(() => undefined)
  $.ui.toast(`Sent "${option.name}" to Claude`)
  await $.prompt.submit({
    text: `I chose design option "${option.name}" for "${current.title}". Apply it using these design tokens:\n\n\`\`\`json\n${JSON.stringify(tokensOf(option), null, 2)}\n\`\`\``,
  })
}

function readOptions(raw: unknown): NexusDesignOption[] {
  if (!Array.isArray(raw)) return []

  return raw
    .slice(0, 6)
    .map((one, index): NexusDesignOption | undefined => {
      if (one === null || typeof one !== 'object') return undefined
      const o = one as Record<string, unknown>
      if (typeof o.name !== 'string' || o.name.trim() === '') return undefined
      const colors =
        o.colors !== null && typeof o.colors === 'object'
          ? Object.fromEntries(
              Object.entries(o.colors as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            )
          : undefined
      const fonts = o.fonts !== null && typeof o.fonts === 'object' ? (o.fonts as NexusDesignOption['fonts']) : undefined

      return {
        id: typeof o.id === 'string' && o.id !== '' ? o.id : `o${index + 1}`,
        name: o.name.trim(),
        ...(typeof o.description === 'string' ? { description: o.description } : {}),
        ...(colors === undefined ? {} : { colors }),
        ...(fonts === undefined ? {} : { fonts }),
        ...(typeof o.radius === 'string' ? { radius: o.radius } : {}),
        ...(typeof o.spacing === 'string' ? { spacing: o.spacing } : {}),
        ...(typeof o.html === 'string' ? { html: o.html } : {}),
      }
    })
    .filter((one): one is NexusDesignOption => one !== undefined)
}

/** Runs the browser bridge for the session's life, relaying picks made in a preview. */
async function runBridge($: Engine): Promise<void> {
  const dir = await previewsDir($)
  await $.fs.write(`${dir}/.keep`, '')
  let buffer = ''
  try {
    const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/bridge/server.mjs`, dir] })
    for await (const chunk of child) {
      if (chunk.stream !== 'stdout') continue
      buffer += chunk.text
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (line.startsWith('NEXUS_PORT ')) {
          const port = Number(line.slice(11))
          await update($, bridgePort, () => (port > 0 ? port : null))
        } else if (line.startsWith('NEXUS_SELECT ')) {
          try {
            const pick = JSON.parse(line.slice(13)) as { set: string; option: string }
            await pickDesign($, pick.set, pick.option)
          } catch {
            // a malformed line from the page
          }
        }
      }
    }
  } catch {
    // node missing or the bridge died: previews fall back to file:// and the pane
  } finally {
    await update($, bridgePort, () => null)
  }
}

// ── Before/after preview of a dev server ─────────────────────────────────

type Shot = { file: string; at: number }

async function findBrowser($: Engine): Promise<string | undefined> {
  const local = slash((await $.env.get('LOCALAPPDATA')) ?? '')
  const candidates = (await isWindows($))
    ? [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        `${local}/Google/Chrome/Application/chrome.exe`,
      ]
    : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ]
  for (const path of candidates) {
    if (await $.fs.exists(path)) return path
  }

  return undefined
}

async function probeDevServer($: Engine): Promise<string | undefined> {
  for (const port of [5173, 3000, 8080, 4200, 8000, 5000, 4321]) {
    const url = `http://localhost:${port}/`
    try {
      if ((await $.http.fetch(url)).status < 500) return url
    } catch {
      // nothing listening there
    }
  }

  return undefined
}

async function runPreview($: Engine, cfg: NexusConfig, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const isBase = words.includes('base') || words.includes('before')
  const url = words.find(word => /^https?:\/\//.test(word)) ?? (cfg.devServerUrl || (await probeDevServer($)))
  if (url === undefined) {
    return 'No dev server answered on localhost (5173, 3000, 8080, 4200, 8000, 5000, 4321). Start it, or pass a URL: /preview-nexus http://localhost:5173'
  }
  const browser = await findBrowser($)
  if (browser === undefined) return 'No Chrome, Edge or Chromium found to take headless screenshots.'
  const dir = await previewsDir($)
  const now = await $.clock.now()
  const file = `shot-${now.toString(36)}.png`
  await $.fs.write(`${dir}/.keep`, '')
  await update($, busy, () => `Capturing ${url}`)
  try {
    await $.process.run(
      [browser, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900', `--screenshot=${dir}/${file}`, url],
      { timeoutMs: 60_000 },
    )
  } catch (error) {
    return `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    await update($, busy, () => null)
  }
  if (!(await $.fs.exists(`${dir}/${file}`))) return `The browser did not write a screenshot of ${url}.`

  const key = `shots.${await shortHash(url)}`
  const stored = await $.store.get(key)
  const shots = Array.isArray(stored) ? (stored as Shot[]) : []
  const shot: Shot = { file, at: now }
  if (isBase || shots.length === 0) {
    await $.store.set(key, [shot])

    return `Captured the BEFORE snapshot of ${url}. Make your changes, then run /preview-nexus again to compare.`
  }
  const base = shots[0] ?? shot
  await $.store.set(key, [base, shot])
  const page = `compare-${now.toString(36)}.html`
  await $.fs.write(`${dir}/${page}`, comparePage(`Before / After: ${url}`, base.file, file, stamp(base.at), stamp(now)))
  const target = await previewUrl($, page)
  const opened = await openExternal($, target)

  return `Captured the AFTER snapshot of ${url} and ${opened ? 'opened' : 'wrote'} the before/after comparison: ${target}  (/preview-nexus base starts a new baseline)`
}

// ── Sessions ─────────────────────────────────────────────────────────────

const PAUSE_TEXT =
  '[Nexus] The person asked this session to pause: finish the step you are on, then stop and wait for their next message.'

async function messagePeer($: Engine, sessionId: string, text: string): Promise<void> {
  try {
    await $.session.send({ to: { sessionId }, text })
    $.ui.toast('Message sent')
  } catch (error) {
    $.ui.toast(`Could not reach that session: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function openPane($: Engine, id: string, title: string): Promise<void> {
  if (id === PANE.sessions) void refreshHud($, true).catch(() => undefined)
  await $.ui.open({ id, title, focus: true, closeOnEscape: true })
}

// ── Theme ────────────────────────────────────────────────────────────────

// Across sessions and projects: the person's last /skin-nexus pick.
const THEME_KEY = 'theme'

async function storedTheme($: Engine): Promise<string | null> {
  const stored = await $.store.get(THEME_KEY).catch(() => null)

  return typeof stored === 'string' && isTheme(stored) ? stored : null
}

// The person's own Claude Code theme, kept while a skin has changed it.
const OWN_CLAUDE_THEME_KEY = 'claudeTheme.own'
// True while Nexus itself sets Claude Code's theme, so its config.set hook
// does not take that change for the person's own pick.
let isSyncingTheme = false

/**
 * Moves Claude Code's own theme (/theme) to the one the skin pairs with, or
 * back to the person's own; says why when Claude Code refused the change.
 */
async function syncClaudeTheme($: Engine, theme: Theme): Promise<string | undefined> {
  const row = (await $.config.list().catch(() => [])).find(one => one.key === 'theme')
  if (row === undefined || typeof row.value !== 'string') return undefined
  if (row.isLocked) return "Claude Code's theme is locked by policy; only the Nexus skin changed."
  const stored = await $.store.get(OWN_CLAUDE_THEME_KEY).catch(() => null)
  const own = typeof stored === 'string' ? stored : row.value
  const target = claudeThemeFor(theme, own)
  if (theme.claudeTheme === null) await $.store.delete(OWN_CLAUDE_THEME_KEY).catch(() => undefined)
  else if (typeof stored !== 'string') await $.store.set(OWN_CLAUDE_THEME_KEY, row.value)
  if (target === row.value || (row.options !== undefined && !row.options.includes(target))) return undefined
  isSyncingTheme = true
  const answer = await $.config
    .set({ key: 'theme', value: target })
    .catch(() => ({ deny: 'Claude Code refused it' }))
    .finally(() => {
      isSyncingTheme = false
    })

  return answer.deny === undefined ? undefined : `Claude Code's theme stayed ${row.value}: ${answer.deny}`
}

/**
 * Switches the skin now and remembers it, with Claude Code's theme when the
 * sync is on; null forgets the pick, back to the configured one.
 */
async function setTheme($: Engine, cfg: NexusConfig, name: string | null): Promise<{ theme: Theme; note?: string }> {
  const theme = themeOf(name ?? cfg.theme)
  if (name === null) await $.store.delete(THEME_KEY).catch(() => undefined)
  else await $.store.set(THEME_KEY, theme.name)
  await update($, themeName, () => theme.name)
  const note = cfg.syncClaudeTheme ? await syncClaudeTheme($, theme).catch(() => undefined) : undefined

  return note === undefined ? { theme } : { theme, note }
}

/** One line for a switch: the skin, and Claude Code's theme note when there is one. */
function skinText(prefix: string, picked: { theme: Theme; note?: string }): string {
  return picked.note === undefined ? `${prefix}${picked.theme.name}` : `${prefix}${picked.theme.name}. ${picked.note}`
}

async function runTheme($: Engine, cfg: NexusConfig, args: string): Promise<string | undefined> {
  const wanted = args.trim().toLowerCase()
  if (wanted === '') {
    await openPane($, PANE.theme, 'Skin')

    return undefined
  }
  if (wanted === 'list') return themeListText(await read($, themeName))
  if (!isTheme(wanted) && wanted !== 'reset') return `No skin named "${wanted}". Skins: ${THEMES.map(theme => theme.name).join(', ')}`
  await $.ui.close({ id: PANE.theme }).catch(() => undefined)
  if (wanted === 'reset') return skinText('Skin back to the configured one: ', await setTheme($, cfg, null))

  return skinText('Skin: ', await setTheme($, cfg, wanted))
}

// ── Session handoff ──────────────────────────────────────────────────────

async function handoffKey($: Engine): Promise<string> {
  return `handoff.${await shortHash(await projectRoot($))}`
}

async function readHandoff($: Engine): Promise<Handoff | null> {
  const stored = await $.store.get(await handoffKey($))

  return stored !== null && typeof stored === 'object' && 'at' in stored ? (stored as Handoff) : null
}

function checksText(v: NexusVerify): string | null {
  if (v.phase === 'idle' || v.phase === 'running') return null
  if (v.phase === 'none') return 'no lint or test command found'

  return v.checks.map(check => `${check.isOk ? '✓' : '✗'} ${check.name}`).join('  ')
}

/** Saves what this session did, for the next session in the project. Cheap: no model call. */
async function saveHandoff($: Engine): Promise<void> {
  const [done, list, v] = await Promise.all([read($, work), read($, tasks), read($, verify)])
  if (done.turns === 0) return
  const record: Handoff = {
    at: await $.clock.now(),
    files: done.files,
    tasks: list.map(task => ({ label: task.label, status: task.status })),
    checks: checksText(v),
    lastPrompt: done.lastPrompt,
    turns: done.turns,
  }
  await $.store.set(await handoffKey($), record)
}

// ── Long turns and next steps ────────────────────────────────────────────

// The running main-thread turn: when it began, and whether it was flagged.
const longTurn = { startedAt: null as number | null, isWarned: false }

/** A turn running far longer than usual: say so once, so a stuck run does not burn the limit unseen. */
async function watchLongTurn($: Engine, cfg: NexusConfig): Promise<void> {
  if (!cfg.loopGuard || longTurn.startedAt === null || longTurn.isWarned) return
  const ran = (await $.clock.now()) - longTurn.startedAt
  if (ran < 20 * 60_000) return
  longTurn.isWarned = true
  const minutes = Math.round(ran / 60_000)
  $.ui.toast(`This turn has run ${minutes} minutes. Press Esc to stop it if it looks stuck.`, { timeoutMs: 12_000 })
  if (cfg.notify) await $.ui.notify(`A turn has run ${minutes} minutes. Check that it is not stuck.`).catch(() => undefined)
}

/** Offers a next step as the prompt's dim suggestion once the turn has settled. */
async function suggestLater($: Engine, text: string): Promise<void> {
  await $.clock.sleep(400)
  await $.prompt.suggest({ text })
}

// ── Commit helper ────────────────────────────────────────────────────────

async function git($: Engine, args: string[], timeoutMs = 30_000) {
  return $.process.run(['git', ...args], { cwd: await $.session.root(), timeoutMs })
}

const COMMIT_RULES = `You write git commit subjects. Reply with ONE line only: an imperative summary under 72 characters (e.g. "Add login form validation"), no period, no quotes, no prefix.`

/** Drafts a message from the diff, asks the person, then commits every change in the work tree. */
async function runCommit($: Engine, cfg: NexusConfig): Promise<string> {
  if ((await currentBranch($)) === null) return 'Not a git repository: nothing to commit.'
  const status = await git($, ['status', '--porcelain', '-uall'])
  const changed = status.stdout.split(/\r?\n/).filter(line => line.trim() !== '').map(line => line.slice(3))
  if (changed.length === 0) {
    await update($, work, now => ({ ...now, commitReady: false }))

    return 'The work tree is clean: nothing to commit.'
  }
  await update($, busy, () => 'Drafting commit message')
  let subject: string | undefined
  try {
    const stat = await git($, ['diff', 'HEAD', '--stat'])
    const patch = await git($, ['diff', 'HEAD', '--unified=1'])
    const answer = await $.model.complete({
      model: cfg.helperModel,
      system: COMMIT_RULES,
      prompt: `Changed files:\n${changed.join('\n')}\n\n${stat.stdout}\n\n${patch.stdout.slice(0, 12_000)}`,
      maxTokens: 60,
      timeoutMs: 30_000,
    })
    subject = answer.isAnswered ? commitSubject(answer.text) : undefined
  } catch {
    subject = undefined
  } finally {
    await update($, busy, () => null)
  }
  subject ??= `Update ${changed.length} file${changed.length === 1 ? '' : 's'}`
  const shown = changed.slice(0, 8).join(', ') + (changed.length > 8 ? `, and ${changed.length - 8} more` : '')
  const answer = await $.ui
    .ask(`Commit ${changed.length} changed file${changed.length === 1 ? '' : 's'} (${shown}) as:\n"${subject}"`, {
      header: 'Commit',
      options: ['Commit', 'Cancel'],
    })
    .catch(() => 'Cancel')
  if (answer !== 'Commit') return 'Commit cancelled; nothing was staged.'
  const added = await git($, ['add', '-A'])
  if (added.exitCode !== 0) return `git add failed: ${added.stderr.trim()}`
  const made = await git($, ['commit', '-q', '-m', subject], 120_000)
  if (made.exitCode !== 0) return `git commit failed: ${(made.stderr || made.stdout).trim().slice(0, 600)}`
  const sha = (await git($, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
  await update($, work, now => ({ ...now, commitReady: false }))

  return `Committed ${changed.length} file${changed.length === 1 ? '' : 's'} as ${sha}: ${subject}`
}

// ═══ 3. Guards ═══════════════════════════════════════════════════════════

const ALLOW = 'Allow once'
const BLOCK = 'Block it'

function field(e: unknown, key: string): string | undefined {
  const value = (e as Record<string, unknown>)[key]

  return typeof value === 'string' ? value : undefined
}

async function setWaiting($: Engine, isWaiting: boolean): Promise<void> {
  await update($, turn, now => ({ ...now, isWaiting }))
}

/** Shows the high-contrast shield drawer and asks; true only on an explicit allow. */
async function confirmDanger($: Engine, tool: string, command: string, hits: readonly ShieldHit[]): Promise<boolean> {
  await update($, shieldAlert, () => ({ tool, command, reasons: hits.map(hit => hit.why) }))
  await setWaiting($, true)
  void $.ui.open({ id: PANE.shield, title: '⛔ Command Shield' }).catch(() => undefined)
  try {
    const answer = await $.ui.ask(
      `⛔ COMMAND SHIELD: this command ${hits.map(hit => hit.why).join('; ')}.\n\n    ${clip(command, 400)}\n\nLet it run?`,
      { header: 'Shield', options: [BLOCK, ALLOW] },
    )

    return answer === ALLOW
  } catch {
    return false
  } finally {
    await update($, shieldAlert, () => null)
    await setWaiting($, false)
    await $.ui.close({ id: PANE.shield }).catch(() => undefined)
  }
}

/** The text a call would write into a file or a shell, and the text an edit must find. */
function writesOf(tool: string, e: unknown): { path?: string; written: string[]; matched: string[] } {
  const input = e as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? [value] : [])
  const path = field(e, 'file_path') ?? field(e, 'notebook_path')
  if (SHELL_TOOLS.has(tool)) return { written: text(input.command), matched: [] }
  if (tool === 'Write') return { path, written: text(input.content), matched: [] }
  if (tool === 'Edit') return { path, written: text(input.new_string), matched: text(input.old_string) }
  if (tool === 'NotebookEdit') return { path, written: text(input.new_source), matched: [] }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    const edits = input.edits as Record<string, unknown>[]

    return { path, written: edits.flatMap(one => text(one.new_string)), matched: edits.flatMap(one => text(one.old_string)) }
  }

  return { written: [], matched: [] }
}

function carriesMask(tool: string, e: unknown): boolean {
  const { written, matched } = writesOf(tool, e)

  return [...written, ...matched].some(text => masksIn(text).length > 0)
}

const MASK_ALLOW = 'Write the mask anyway'

/**
 * Keeps a mask the sanitizer put over a secret from being written back in the
 * secret's place: Claude saw only the mask, so a file it rewrites from what it
 * read would lose the real value. A mask the file already holds on disk (a
 * test of the sanitizer, say) is the file's own text and passes.
 */
async function guardMasks($: Engine, tool: string, e: unknown): Promise<string | undefined> {
  if (!carriesMask(tool, e)) return undefined
  const { path, written, matched } = writesOf(tool, e)
  const onDisk = path === undefined ? '' : await $.fs.read(path).catch(() => '')
  const foreign = (texts: readonly string[]) => [...new Set(texts.flatMap(masksIn))].filter(mask => !onDisk.includes(mask))
  const inMatch = foreign(matched)
  if (inMatch.length > 0) {
    return `Nexus: old_string contains ${inMatch.join(', ')}, a mask Nexus put over a secret when you read the file. The file on disk holds the real value, so this can never match. Choose an old_string that stops short of the masked value, or ask the user to edit that line.`
  }
  const masks = foreign(written)
  if (masks.length === 0) return undefined
  const where = path === undefined ? '' : ` into ${clip(await projectPath($, path), 80)}`
  await setWaiting($, true)
  try {
    const answer = await $.ui.ask(
      `⚠ SECRET MASK: this ${tool} would write ${masks.join(', ')}${where}.\n\nNexus hid that secret from Claude, so the mask would take the real value's place. Let it write the mask anyway?`,
      { header: 'Secrets', options: [BLOCK, MASK_ALLOW] },
    )
    if (answer === MASK_ALLOW) return undefined
  } catch {
    // nobody to ask: keep the secret
  } finally {
    await setWaiting($, false)
  }

  return `Nexus blocked this ${tool}: it would write ${masks.join(', ')} where a real secret was. Nexus masked that secret when you read it, so you do not know its value. Leave the lines that hold secrets untouched (change the other lines with Edit instead of rewriting the file), or ask the user to fill the value in themselves.`
}

const AUDIT_RULES = `You review a coding assistant's intended work for UNSTATED assumptions: implicit architecture choices, library or pattern picks, data or API shapes, scope interpretations, UI decisions, or file locations the user never specified.
Return JSON only, no prose: {"assumptions": ["...", "..."]}
- At most 4 items, the ones that would be most costly if wrong. Fewer is better; [] when nothing material is assumed.
- Each item is one plain statement the user can confirm, under 90 characters, no commas (e.g. "Store cart state in the existing Zustand store").
- Never list things the user explicitly asked for.`

async function lastUserRequest($: Engine): Promise<string> {
  try {
    const found = [...(await $.session.messages())]
      .reverse()
      .find(message => message.role === 'user' && message.text.trim() !== '')

    return clip(found?.text ?? '', 4000)
  } catch {
    return ''
  }
}

/**
 * Pulls the unstated assumptions out of a plan (or, before an edit, out of the
 * conversation), lets the person tick the right ones in a review dialog, and
 * returns the correction for the model when anything was rejected.
 */
async function reviewAssumptions(
  $: Engine,
  cfg: NexusConfig,
  source: 'plan' | 'edit',
  plan: string | undefined,
): Promise<string | undefined> {
  await update($, busy, () => 'Reviewing assumptions')
  let raw: string | undefined
  try {
    if (plan !== undefined) {
      const result = await $.model.complete({
        model: cfg.helperModel,
        system: AUDIT_RULES,
        prompt: `The user's request:\n${await lastUserRequest($)}\n\nThe assistant's plan:\n${clip(plan, 12000)}`,
        maxTokens: 600,
        timeoutMs: 45_000,
      })
      raw = result.isAnswered ? result.text : undefined
    } else {
      const result = await $.model.fork({
        prompt: `${AUDIT_RULES}\n\nApply this to the change you are about to make to the user's files right now.`,
      })
      raw = result.isAnswered ? result.text : undefined
    }
  } finally {
    await update($, busy, () => null)
  }
  const labels = parseAssumptions(raw)
  if (labels.length === 0) return undefined

  await setWaiting($, true)
  try {
    let rejected: string[] = []
    let correction = ''
    if (labels.length === 1) {
      const only = labels[0] ?? ''
      const answer = await $.ui.ask(`Claude is assuming: "${only}". Is that right?`, {
        header: 'Assumption',
        options: ['Yes, correct', 'No, wrong'],
      })
      if (answer === 'No, wrong') rejected = [only]
      else if (answer !== 'Yes, correct') correction = answer
    } else {
      const answer = await $.ui.ask(
        `Claude made ${labels.length} unstated assumptions ${source === 'plan' ? 'in its plan' : 'before editing'}. Tick the ones that are RIGHT; unticked ones count as wrong. Type under Other to correct one.`,
        { header: 'Assumptions', options: labels, multiSelect: true },
      )
      ;({ rejected, correction } = readTicks(answer, labels))
    }
    if (rejected.length === 0 && correction === '') {
      $.ui.toast('Assumptions confirmed')

      return undefined
    }

    return [
      `Nexus assumption review: the user did not confirm everything ${source === 'plan' ? 'this plan assumes' : 'you assumed before editing'}.`,
      rejected.length > 0 ? `Wrong assumptions:\n${rejected.map(one => `- ${one}`).join('\n')}` : '',
      correction !== '' ? `The user's correction: ${correction}` : '',
      source === 'plan'
        ? 'Revise the plan to match, then present it again.'
        : 'Do not edit files on these assumptions. Adjust your approach to the correction (ask the user if it is still unclear), then continue.',
    ]
      .filter(Boolean)
      .join('\n\n')
  } catch {
    // dismissed: the person chose not to review, so the work goes on
    return undefined
  } finally {
    await setWaiting($, false)
  }
}

function maskBlock(block: ApiContentBlock, found: { count: number; kinds: Set<string> }): ApiContentBlock {
  const loose = block as unknown as Record<string, unknown>
  const mask = (text: string) => {
    const result = maskSecrets(text)
    found.count += result.count
    for (const kind of result.kinds) found.kinds.add(kind)

    return result.text
  }
  if (loose.type === 'text' && typeof loose.text === 'string') {
    return { ...loose, text: mask(loose.text) } as unknown as ApiContentBlock
  }
  if (loose.type === 'tool_result') {
    const content = loose.content
    if (typeof content === 'string') return { ...loose, content: mask(content) } as unknown as ApiContentBlock
    if (Array.isArray(content)) {
      return {
        ...loose,
        content: content.map(inner => {
          const part = inner as Record<string, unknown>

          return part.type === 'text' && typeof part.text === 'string' ? { ...part, text: mask(part.text) } : part
        }),
      } as unknown as ApiContentBlock
    }
  }

  return block
}

// ── Lean: noisy output, MCP servers per project, the quota guard ─────────

const OUTPUT_FILES = 30

/** Keeps a command's whole output in a ring of files Claude can Read; the path, or null. */
async function saveOutput($: Engine, command: string, text: string): Promise<string | null> {
  try {
    const stored = await $.store.get('outputs.next')
    const slot = typeof stored === 'number' ? stored % OUTPUT_FILES : 0
    await $.store.set('outputs.next', slot + 1)
    const path = `${await nexusDir($)}/outputs/out-${slot}.log`
    await $.fs.write(path, `$ ${command}\n\n${text}`)

    return path
  } catch {
    return null
  }
}

/** A long, routine shell output folded before Claude reads it; the rest of the result untouched. */
async function trimShellResult<R extends { result?: unknown; isError?: boolean; deny?: string }>($: Engine, command: string, answer: R): Promise<R> {
  if (answer.deny !== undefined || answer.isError === true || !isNoisyCommand(command)) return answer
  const out = answer.result as Record<string, unknown> | undefined
  if (out === undefined || out === null || typeof out.stdout !== 'string') return answer
  if (out.interrupted === true || out.isImage === true || out.persistedOutputPath !== undefined || out.backgroundTaskId !== undefined) return answer
  const stdout = trimOutput(out.stdout)
  const stderr = typeof out.stderr === 'string' ? trimOutput(out.stderr) : undefined
  if (stdout === undefined && stderr === undefined) return answer
  const file = await saveOutput($, command, `${out.stdout}${typeof out.stderr === 'string' && out.stderr !== '' ? `\n\n--- stderr ---\n${out.stderr}` : ''}`)
  const dropped = (stdout?.dropped ?? 0) + (stderr?.dropped ?? 0)
  const note = `[Nexus folded ${dropped} routine lines of this output${file === null ? '' : `; the full output is at ${file}, Read it if you need a folded part`}]`

  return {
    ...answer,
    result: {
      ...out,
      stdout: `${stdout?.text ?? out.stdout}\n\n${note}`,
      ...(stderr === undefined ? {} : { stderr: stderr.text }),
    },
  }
}

// MCP servers turned off in this project; session.start loads them, /mcp-nexus changes them.
let mcpOff: string[] = []

async function mcpOffKey($: Engine): Promise<string> {
  return `mcpOff.${await shortHash(await projectRoot($))}`
}

async function loadMcpOff($: Engine): Promise<void> {
  const stored = await $.store.get(await mcpOffKey($)).catch(() => null)
  mcpOff = Array.isArray(stored) ? stored.filter((one): one is string => typeof one === 'string') : []
}

async function runMcp($: Engine, args: string): Promise<string> {
  const [verb = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const name = rest.join(' ')
  const tools = await $.tool.list().catch(() => [])
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
  const sizes = usage?.context.breakdown?.mcpTools ?? []
  const servers = new Map<string, { tools: number; tokens: number }>()
  for (const tool of tools) {
    const server = mcpServerOf(tool.name)
    if (server === undefined || server === $.plugin.name) continue
    const one = servers.get(server) ?? { tools: 0, tokens: 0 }
    one.tools += 1
    servers.set(server, one)
  }
  for (const size of sizes) {
    const one = servers.get(size.serverName)
    if (one !== undefined && size.isLoaded) one.tokens += size.tokens
  }
  for (const server of mcpOff) if (!servers.has(server)) servers.set(server, { tools: 0, tokens: 0 })
  const known = [...servers.keys()]

  if (verb === 'off' || verb === 'on') {
    if (name === '') return `Name a server: /mcp-nexus ${verb} <server>. Servers: ${known.join(', ') || 'none connected'}.`
    if (name === $.plugin.name) return 'Nexus keeps its own tools on.'
    if (verb === 'off' && !servers.has(name)) return `No MCP server "${name}" is connected. Servers: ${known.join(', ') || 'none'}.`
    mcpOff = verb === 'off' ? [...new Set([...mcpOff, name])] : mcpOff.filter(one => one !== name)
    await $.store.set(await mcpOffKey($), mcpOff)
    $.ui.invalidate('tool.describe')

    return verb === 'off'
      ? `"${name}" is off in this project: its tools wait behind ToolSearch with a one-line note, and a call to one is refused. /mcp-nexus on ${name} brings it back.`
      : `"${name}" is on again in this project.`
  }
  if (verb !== 'list') return 'Use /mcp-nexus (list), /mcp-nexus off <server> or /mcp-nexus on <server>.'
  if (servers.size === 0) return 'No MCP server is connected to this session.'

  return [
    'MCP servers in this project (tokens: tools kept in front of Claude):',
    ...[...servers.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([server, one]) => `  ${mcpOff.includes(server) ? '○ off' : '● on '}  ${server.padEnd(28)}${String(one.tools).padStart(4)} tools  ${tokens(one.tokens).padStart(6)}`),
    '',
    'Turn one off here with /mcp-nexus off <server>; /context-nexus shows where the rest of the context goes.',
  ].join('\n')
}

const QUOTA_KEEP = 'Keep going'
const QUOTA_STOP = 'Stop this turn'
const QUOTA_SEND = 'Send it'
const QUOTA_HOLD = 'Hold it'

/** The windows that just passed the guard, said plainly, and when the last of them resets (null if unknown); null when none did. Each window is raised once per reset, across sessions. */
async function crossedQuota($: Engine, cfg: NexusConfig, limits: readonly Window[]): Promise<{ text: string; resetsAt: number | null } | null> {
  const stored = await $.store.get('quotaRaised').catch(() => null)
  const raised = new Set(Array.isArray(stored) ? stored.filter((one): one is string => typeof one === 'string') : [])
  const crossed = crossedWindows(limits, cfg.quotaGuard, raised)
  if (crossed.length === 0) return null
  for (const one of crossed) raised.add(windowKey(one))
  await $.store.set('quotaRaised', [...raised].slice(-12)).catch(() => undefined)
  const now = await $.clock.now()

  const resets = crossed.map(one => one.resetsAt)
  // Claude is back once every crossed window has reset.
  const resetsAt = resets.some(one => one === null) ? null : Math.max(...(resets as number[]))

  return {
    text: crossed
      .map(one => `the ${WINDOW_NAMES[one.kind]} limit is at ${Math.round(one.percentUsed)}%${one.resetsAt === null ? '' : ` (resets in ${untilReset(one.resetsAt, now)})`}`)
      .join(' and '),
    resetsAt,
  }
}

/** Mid-turn, asks whether the turn goes on; an answer of stop ends it. */
async function askQuotaMidTurn($: Engine, what: string, turnId: string, switchTo?: string, resetsAt: number | null = null, isLinked = true): Promise<void> {
  await setWaiting($, true)
  try {
    // In a plain session the way to a hub is a restart under claude-nexus, so the offer says so.
    const switchLabel = switchTo === undefined ? undefined : isLinked ? `Switch to ${switchTo} now` : `Go on with ${switchTo} (copies a restart command)`
    const options = switchLabel === undefined ? [QUOTA_KEEP, QUOTA_STOP] : [QUOTA_KEEP, switchLabel, QUOTA_STOP]
    const answer = await $.ui.ask(`⚠ QUOTA: ${what}. Let this turn keep going?`, { header: 'Quota', options })
    if (answer === QUOTA_STOP) {
      await $.turn.abort({ turnId })
      $.ui.toast('Turn stopped to save quota.')
    } else if (switchTo !== undefined && !isLinked && answer === switchLabel) {
      $.ui.toast(await restartOn($, switchTo), { timeoutMs: 15_000 })
    } else if (switchTo !== undefined && answer === switchLabel) {
      $.ui.toast(await useRoute($, switchTo, { askCompact: false }))
      // Claude comes back when the crossed window resets: the turn's end offers the way back then.
      if (resetsAt !== null && (await read($, provider)).route === switchTo) await update($, claudeBackAt, () => resetsAt)
    }
  } catch {
    // nobody to ask: the turn goes on
  } finally {
    await setWaiting($, false)
  }
}

// ── Provider router: the claude-nexus session's link to its router ───────

const PROVIDERS_KEY = 'providers'

// A second copy of the link, for a `/clear` or in-process `/resume` that resets state: the module is not reloaded by either.
let linkCopy: NexusRouterLink | null = null

/** The router link: from state, else this module's copy, else the env the launcher set (then taken out of what tools inherit). */
async function ensureRouterLink($: Engine): Promise<NexusRouterLink | null> {
  const kept = await read($, routerLink)
  if (kept !== null) {
    linkCopy = kept
    return kept
  }
  if (linkCopy !== null) {
    // State lost the link while the router lives on: put it back, and bring the HUD's route in line with the router's.
    const link = linkCopy
    await update($, routerLink, () => link)
    await update($, provider, now => ({ ...now, linked: true }))
    await providerStatus($).catch(() => undefined)

    return link
  }
  const link = routerLinkFrom(await $.env.get('ANTHROPIC_BASE_URL'), await $.env.get('NEXUS_ROUTER_TOKEN'))
  if (link === null) return null
  linkCopy = link
  await update($, routerLink, () => link)
  await $.env.set('NEXUS_ROUTER_TOKEN', undefined)
  await update($, provider, now => ({ ...now, linked: true }))

  return link
}

async function routerCall(
  $: Engine,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const link = await read($, routerLink)
  if (link === null) return { ok: false, status: 0, data: {} }
  let response
  try {
    response = await $.http.fetch(`${link.url}${path}`, {
      method,
      headers: { 'x-nexus-control': link.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    // an unreachable router: callers turn status 0 into their own plain sentence
    return { ok: false, status: 0, data: {} }
  }
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(response.text) as Record<string, unknown>
  } catch {
    // a body that is not JSON: the status says enough
  }

  return { ok: response.ok, status: response.status, data }
}

function summarize(profile: ProviderProfile) {
  return {
    name: profile.name,
    hubUrl: profile.hubUrl,
    key: maskKey(profile.apiKey),
    model: primaryModel(profile.models) ?? '',
    contextWindow: profile.contextWindow,
    fallback: profile.fallback,
    isDefault: profile.isDefault,
  }
}

async function loadProfiles($: Engine): Promise<ProviderProfile[]> {
  const list = readProfiles(await $.store.get(PROVIDERS_KEY).catch(() => null))
  const last = await $.store.get(LAST_HUB_KEY).catch(() => null)
  await update($, provider, now => ({ ...now, profiles: list.map(summarize), lastHub: typeof last === 'string' ? last : null }))

  return list
}

async function saveProfiles($: Engine, list: ProviderProfile[]): Promise<void> {
  await $.store.set(PROVIDERS_KEY, list)
  await update($, provider, now => ({ ...now, profiles: list.map(summarize) }))
}

const NOT_LINKED =
  'This is a plain claude session, so it stays on Claude. /provider-nexus <name> copies a command that resumes this conversation under claude-nexus, on that profile.'

/** The hub switched to last, kept across sessions for the one-key toggle. */
const LAST_HUB_KEY = 'providerLast'
/** A switch asked for in a plain session, waiting for the same project to start under claude-nexus. */
const PENDING_ROUTE_KEY = 'providerPending'

/** In a plain session: copy the command that resumes this conversation under claude-nexus, and remember to switch to the profile there. */
async function restartOn($: Engine, name: string, surface?: Parameters<Engine['ui']['copy']>[0]['surface']): Promise<string> {
  if (name === 'claude') return 'This plain claude session is already on Claude.'
  if (!(await loadProfiles($)).some(one => one.name === name)) return `No profile named ${name}. /provider-nexus opens the list.`
  const cwd = await $.session.root()
  const command = restartCommand(cwd, await $.session.id(), await isWindows($))
  const pending: PendingRoute = { name, cwd, at: await $.clock.now() }
  await $.store.set(PENDING_ROUTE_KEY, pending).catch(() => undefined)
  const copied = await $.ui.copy({ text: command, ...(surface === undefined ? {} : { surface }) }).catch(() => ({ isCopied: false as const }))

  return copied.isCopied
    ? `Copied. Type /exit, paste it and press Enter: this conversation goes on under claude-nexus, on ${name}.`
    : `Type /exit, then run: ${command}  (this conversation goes on under claude-nexus, on ${name})`
}

/** At start under claude-nexus: the switch a plain session asked for in this folder, if it is still fresh. Taken once. */
async function takePendingRoute($: Engine): Promise<string | null> {
  const raw = await $.store.get(PENDING_ROUTE_KEY).catch(() => null)
  if (raw === null || raw === undefined) return null
  await $.store.delete(PENDING_ROUTE_KEY).catch(() => undefined)

  return pendingRouteFor(raw, await $.session.root(), await $.clock.now())
}

/** After a hub compaction, success or not, the next waits this long. */
const HUB_COMPACT_COOLDOWN_MS = 60_000

const COMPACT_THEN_SWITCH = 'Compact, then switch'
const SWITCH_ANYWAY = 'Switch anyway'
const CANCEL = 'Cancel'

/** Hands a profile, key included, to the router as the route. */
const postRoute = ($: Engine, profile: ProviderProfile) =>
  routerCall($, 'POST', '/__nexus/route', {
    route: profile.name,
    profile: { hubUrl: profile.hubUrl, apiKey: profile.apiKey, models: profile.models, contextWindow: profile.contextWindow },
  })

/** Points the router at Claude or a profile; the text says what happened. */
async function useRoute($: Engine, name: string, options: { askCompact?: boolean; surface?: Parameters<Engine['ui']['copy']>[0]['surface'] } = {}): Promise<string> {
  if ((await ensureRouterLink($)) === null) return restartOn($, name, options.surface)
  if (name === 'claude') {
    const answer = await routerCall($, 'POST', '/__nexus/route', { route: 'claude' })
    if (!answer.ok) return `The router refused: ${String(answer.data.error ?? answer.status)}`
    await update($, provider, now => ({ ...now, route: 'claude', model: null }))
    await update($, claudeBackAt, () => null)

    return 'Back on Claude (subscription).'
  }
  const profile = (await loadProfiles($)).find(one => one.name === name)
  if (profile === undefined) return `No profile named ${name}. /provider-nexus opens the list.`
  const tokens = (await read($, hud)).tokens
  // Asking to compact sends a request to Claude: not while Claude's limit holds one.
  if (options.askCompact !== false && needsCompaction(tokens, profile.contextWindow, 0.8)) {
    const choice = await $.ui
      .ask(`The context (${tokens ?? 0} tokens) is past 80% of ${profile.name}'s window (${profile.contextWindow}). Compact first?`, {
        header: 'Provider',
        options: [COMPACT_THEN_SWITCH, SWITCH_ANYWAY, CANCEL],
      })
      .catch(() => CANCEL)
    if (choice === CANCEL) return 'Not switched.'
    if (choice === COMPACT_THEN_SWITCH) await $.session.compact({ instructions: 'Keep file paths, open tasks and decisions.' }).catch(() => undefined)
  }
  const answer = await postRoute($, profile)
  if (!answer.ok) return `The router refused: ${String(answer.data.error ?? answer.status)}`
  const model = primaryModel(profile.models) ?? null
  await update($, provider, now => ({ ...now, route: profile.name, model, lastHub: profile.name }))
  await $.store.set(LAST_HUB_KEY, profile.name).catch(() => undefined)

  return `Now on ${profile.name}${model === null ? '' : ` (${model})`}. Requests go to ${profile.hubUrl}; /provider-nexus use claude goes back.`
}

async function providerStatus($: Engine): Promise<string> {
  if ((await ensureRouterLink($)) === null) return NOT_LINKED
  const answer = await routerCall($, 'GET', '/__nexus/status')
  if (!answer.ok) return 'The router did not answer. Is this session still running under claude-nexus?'
  const route = String(answer.data.route ?? 'claude')
  const model = typeof answer.data.model === 'string' ? answer.data.model : null
  await update($, provider, now => ({ ...now, route, model }))
  const counts = answer.data.counts as { claude?: number; hub?: number } | undefined

  return [
    `Route: ${route === 'claude' ? 'Claude (subscription)' : hubBadge(route, model)}`,
    `Requests this session: ${counts?.claude ?? 0} to Claude, ${counts?.hub ?? 0} to hubs`,
    `Profiles: ${(await loadProfiles($)).map(one => one.name).join(', ') || 'none yet (/provider-nexus to add one)'}`,
  ].join('\n')
}

const DONT_SWITCH = "Don't switch"
const continueOn = (name: string) => `Continue on ${name}`

async function decide($: Engine, id: string, action: 'retry' | 'release'): Promise<void> {
  await routerCall($, 'POST', '/__nexus/decision', { id, action }).catch(() => undefined)
}

/** What becomes of a held request: continue it on a hub (retry) or let Claude's refusal through (release). May throw. */
async function limitAction($: Engine, cfg: NexusConfig, event: Record<string, unknown>): Promise<'retry' | 'release'> {
  if (typeof event.resetsAt === 'number') {
    const resetsAt = event.resetsAt
    await update($, claudeBackAt, () => resetsAt)
  }
  // Already on a hub (the person switched, or a subagent's request was held): nothing to choose.
  if ((await read($, provider)).route !== 'claude') return 'retry'
  const choices = fallbackChoices(await loadProfiles($))
  if (cfg.fallbackMode === 'off' || choices.length === 0) return 'release'
  const tokens = (await read($, hud)).tokens
  const now = await $.clock.now()
  const window = event.window === 'seven_day' ? 'weekly' : event.window === 'five_hour' ? '5-hour' : 'plan'
  const when = typeof event.resetsAt === 'number' ? ` (resets in ${untilReset(event.resetsAt, now)})` : ''
  let target: string | undefined
  if (cfg.fallbackMode === 'auto') {
    target = choices[0]?.name
  } else {
    await setWaiting($, true)
    try {
      // A hub whose window is smaller than the context would fail the retried request; say so on its choice.
      const labelled = choices.slice(0, 3).map(one => ({
        name: one.name,
        label: `${continueOn(one.name)}${tokens !== null && tokens > one.contextWindow ? ` — context ${tokens} tokens exceeds its window; this turn will likely fail` : ''}`,
      }))
      const answer = await $.ui.ask(`Claude's ${window} limit is reached${when}. Continue this turn on a hub?`, {
        header: 'Provider',
        options: [...labelled.map(one => one.label), DONT_SWITCH],
      })
      target = labelled.find(one => one.label === answer)?.name
    } catch {
      target = undefined
    } finally {
      await setWaiting($, false)
    }
  }
  if (target === undefined) return 'release'
  // The held request waits on this: switch the route only; the compaction ask would itself go to the exhausted Claude.
  const text = await useRoute($, target, { askCompact: false })
  $.ui.toast(text, { timeoutMs: 8000 })

  return (await read($, provider)).route === target ? 'retry' : 'release'
}

async function handleRouterEvent($: Engine, cfg: NexusConfig, event: Record<string, unknown>): Promise<void> {
  if (event.type === 'upstream-error') {
    $.ui.toast(`The hub ${String(event.route)} answered ${String(event.status)}. /provider-nexus use claude goes back to Claude.`, { timeoutMs: 8000 })
    return
  }
  if (event.type === 'route' && typeof event.route === 'string') {
    // Whoever changed the route, the badge says where requests really go.
    const route = event.route
    const model = route === 'claude' || typeof event.model !== 'string' ? null : event.model
    await update($, provider, now => ({ ...now, route, model }))
    return
  }
  if (event.type !== 'limit' || typeof event.id !== 'string') return
  let action: 'retry' | 'release' = 'release'
  try {
    action = await limitAction($, cfg, event)
  } catch {
    // whatever went wrong, the held request must not wait out its timeout
    action = 'release'
  }
  await decide($, event.id, action)
}

/**
 * Listens to the router for the session's life. Each start takes over: it writes a newer generation and an older
 * loop (from before a reload) ends at its next turn. Without `isTakeover` a loop is only started when none ever was.
 * An unreachable router is polled again after a growing pause (2 s up to 30 s), never given up on.
 */
async function watchRouter($: Engine, cfg: NexusConfig, isTakeover: boolean): Promise<void> {
  if (!isTakeover && (await read($, routerWatcher)) !== 0) return
  const mine = await update($, routerWatcher, now => now + 1)
  let failures = 0
  try {
    while ((await read($, routerWatcher)) === mine) {
      const answer = await routerCall($, 'GET', '/__nexus/events?wait=25').catch(() => ({ ok: false, status: 0, data: {} as Record<string, unknown> }))
      if (!answer.ok) {
        failures += 1
        await $.clock.sleep(Math.min(30_000, 2000 * 2 ** (failures - 1)))
        continue
      }
      failures = 0
      // Events this poll already took are handled even if a newer loop has come: the router will not serve them again.
      const events = Array.isArray(answer.data.events) ? (answer.data.events as Record<string, unknown>[]) : []
      for (const event of events) await handleRouterEvent($, cfg, event).catch(() => undefined)
    }
  } catch {
    // a wait that was cut short: this loop ends, and the next start can begin another
  } finally {
    await update($, routerWatcher, now => (now === mine ? 0 : now)).catch(() => undefined)
  }
}

const STEP_LABEL: Record<DraftStep, string> = {
  name: 'Name (lowercase, e.g. myhub)',
  hubUrl: 'Hub URL (e.g. https://hub.example.com/v1)',
  apiKey: 'API key (shown while you type; masked once saved)',
  opus: 'Model for opus requests',
  sonnet: 'Model for sonnet requests (empty: same as the first one filled)',
  haiku: 'Model for haiku requests (empty: same as the first one filled)',
  contextWindow: 'Context window in tokens (empty: 200000)',
  fallback: 'Offer this profile when Claude quota runs out?',
}

async function fetchHubModels($: Engine, hubUrl: string, apiKey: string): Promise<string[]> {
  try {
    const response = await $.http.fetch(`${normalizeHubUrl(hubUrl)}/models`, {
      headers: { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) return []
    const parsed = JSON.parse(response.text) as { data?: { id?: string }[] }

    return (parsed.data ?? []).map(one => one.id).filter((id): id is string => typeof id === 'string').slice(0, 60)
  } catch {
    return []
  }
}

/**
 * The hub key being typed in the form. Held here and nowhere else: never in state (what a reload,
 * the HUD or a peer could read), and the draft keeps only its mask. A reload mid-form loses it.
 */
let draftKey: string | null = null

async function closeDraft($: Engine): Promise<void> {
  draftKey = null
  await update($, provider, now => (now.draft === null ? now : { ...now, draft: null }))
}

async function startDraft($: Engine, editing: string | null): Promise<void> {
  draftKey = null
  const profile = editing === null ? undefined : (await loadProfiles($)).find(one => one.name === editing)
  const values: Record<string, string> =
    profile === undefined
      ? {}
      : {
          name: profile.name,
          hubUrl: profile.hubUrl,
          apiKeyMask: maskKey(profile.apiKey),
          opus: profile.models.opus ?? '',
          sonnet: profile.models.sonnet ?? '',
          haiku: profile.models.haiku ?? '',
          contextWindow: String(profile.contextWindow),
          fallback: profile.isDefault ? 'yes-default' : profile.fallback ? 'yes' : 'no',
        }
  await update($, provider, now => ({ ...now, draft: { step: 'name' as const, editing, values, models: [], error: null } }))
}

async function submitDraftField($: Engine, value: string): Promise<void> {
  const view = await read($, provider)
  const draft = view.draft
  if (draft === null) return
  const stored = draft.editing === null ? undefined : (await loadProfiles($)).find(one => one.name === draft.editing)
  const values = { ...draft.values }
  if (draft.step === 'apiKey') {
    // An empty answer keeps the key typed before, or the stored profile's on an edit.
    if (value.trim() !== '') draftKey = value.trim()
  } else {
    values[draft.step] = value.trim()
  }
  const key = draftKey ?? stored?.apiKey ?? ''
  let models = draft.models
  if (draft.step === 'apiKey') models = await fetchHubModels($, values.hubUrl ?? '', key)
  const step = nextStep(draft.step)
  if (step !== null) {
    await update($, provider, now => ({ ...now, draft: { ...draft, step, values, models, error: null } }))
    return
  }
  const all = await loadProfiles($)
  const others = all.filter(one => one.name !== draft.editing)
  const result = validateProfile(draftToProfile({ ...values, apiKey: key }), others)
  if (result.profile === null) {
    const [field, message] = Object.entries(result.errors)[0] ?? ['name', 'check the fields']
    const back = (field === 'models' ? 'opus' : field) as DraftStep
    await update($, provider, now => ({ ...now, draft: { ...draft, step: back, values, models, error: message } }))
    return
  }
  const saved = result.profile
  const list = [...others.map(one => (saved.isDefault ? { ...one, isDefault: false } : one)), saved]
  await saveProfiles($, list)
  await closeDraft($)
  // The profile in use was edited: the router still holds the old key, models and URL.
  if (draft.editing !== null && saved.name === (await read($, provider)).route && (await read($, routerLink)) !== null) {
    const pushed = await postRoute($, saved)
    if (!pushed.ok) $.ui.toast(`Saved ${saved.name}, but the router did not take the change: /provider-nexus use ${saved.name} sends it again.`, { timeoutMs: 8000 })
  }
  $.ui.toast(`Saved ${saved.name} (key ${maskKey(saved.apiKey)}).`)
}

async function testProfile($: Engine, name: string): Promise<string> {
  const profile = (await loadProfiles($)).find(one => one.name === name)
  if (profile === undefined) return `No profile named ${name}.`
  const models = [...new Set(Object.values(profile.models).filter((one): one is string => typeof one === 'string' && one !== ''))]
  const hideKey = (text: string) => maskSecrets(text).text.split(profile.apiKey).join(maskKey(profile.apiKey))
  const lines: string[] = []
  for (const model of models) {
    const started = await $.clock.now()
    try {
      const response = await $.http.fetch(`${profile.hubUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': profile.apiKey, authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] }),
      })
      const took = (await $.clock.now()) - started
      lines.push(response.ok ? `✓ ${model}  ${took} ms` : `✗ ${model}  HTTP ${response.status}: ${clip(hideKey(response.text), 160)}`)
    } catch (error) {
      lines.push(`✗ ${model}  ${clip(hideKey(error instanceof Error ? error.message : String(error)), 160)}`)
    }
  }
  const text = lines.join('\n')
  await update($, provider, now => ({ ...now, tests: { ...now.tests, [name]: text } }))

  return `${profile.name} (${profile.hubUrl}):\n${text}`
}

// ═══ 4. Delivery ═════════════════════════════════════════════════════════

function deliveryRules(cfg: NexusConfig): string {
  const parts: string[] = []
  if (cfg.executiveSummary) {
    parts.push(`# Delivery (Nexus)
- Work quietly: no progress recaps or interim summaries between tool calls. At most one short line before a tool call, and only when it helps.
- When this turn changed files, end with one final reply in plain English for a non-specialist (no jargon, no code unless asked), under exactly these three headings:
  **What Changed**: one line per file touched, naming the file and what changed in it in everyday words.
  **Verification Status**: the lint, type-check and test commands you ran and whether they passed; say plainly if you ran none. Nexus re-runs the project's checks when you stop and sends any failure back to you.
  **Next Steps**: what the person may want to do or decide next, or "None".
- When the turn changed no files, answer plainly without those headings.`)
  }
  if (cfg.designLens) {
    parts.push(`# Visual design options (Nexus)
When you would offer a choice between UI layouts, color palettes, typography or component themes, call the ${DESIGN_TOOL} tool with 2 to 6 concrete options (real hex colors, real font stacks, and optionally a small self-contained HTML sample using inline styles and the CSS variables --c-<colorName>, --font-heading, --font-body, --radius) instead of describing them in text. Then end your turn with one short line; the person's pick arrives as their next message, with its design tokens.`)
  }

  return parts.join('\n\n')
}

// ═══ 5. Layout ═══════════════════════════════════════════════════════════

const DOT: Record<NexusPeerStatus, string> = { working: 'green', waiting: 'yellow', done: 'gray' }

// Tools whose rows carry what the person reads: diffs, questions, plans.
const LOUD = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'TodoWrite',
  'Agent',
  'Task',
  DESIGN_TOOL,
])

/** One cell of the HUD grid: a name, a bar for its percent, a detail, and a colored note after it. */
type Gauge = {
  key: string
  name: string
  percent: number | null
  color: string
  detail: string
  note?: { text: string; color: string }
}

const usedColor = (pct: number) => (pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green')

/** The grid's two columns: account limits on the left, the model's readings on the right. */
function hudGauges(view: NexusHud, rate: NexusSpeed | null, now: number, isWorking: boolean, icons: Theme['icons']): { left: Gauge[]; right: Gauge[] } {
  const left: Gauge[] = []
  for (const kind of ['five_hour', 'seven_day']) {
    const limit = view.limits.find(one => one.kind === kind)
    const label = limit === undefined ? undefined : limitLabel(limit, now)
    if (limit === undefined || label === undefined) continue
    // At the present pace, the window runs out before it resets.
    const out = forecastText(limitSamples.get(kind) ?? [], limit.resetsAt, now)
    left.push({
      key: kind,
      name: label.name,
      percent: label.used,
      color: out === undefined ? usedColor(label.used) : 'red',
      detail: label.reset,
      ...(out === undefined ? {} : { note: { text: `${icons.warn} ${out}`, color: 'red' } }),
    })
  }
  const right: Gauge[] = []
  if (view.tokens !== null && view.window !== null) {
    const pct = view.percent ?? Math.round((view.tokens / view.window) * 100)
    right.push({ key: 'ctx', name: 'Ctx', percent: pct, color: usedColor(pct), detail: `${compact(view.tokens)}/${compact(view.window)}` })
  }
  const speedText = rate?.tps != null ? `${icons.speed} ${rate.tps} tok/s` : ''
  // How long since the last request: past the cache's life the next reply starts cold.
  const age = rate === null ? undefined : cacheAge(rate.at, now, isWorking)
  const note = age === undefined ? {} : { note: { text: age.text, color: age.color } }
  if (rate?.cacheHit != null) {
    const hit = rate.cacheHit
    right.push({
      key: 'cache',
      name: 'Cache',
      percent: hit,
      color: hit >= 70 ? 'green' : hit >= 30 ? 'yellow' : 'red',
      detail: speedText === '' ? '' : `${speedText} · `,
      ...note,
    })
  } else if (speedText !== '') {
    right.push({ key: 'speed', name: 'Speed', percent: null, color: 'green', detail: `${speedText} · `, ...note })
  }

  return { left, right }
}

/**
 * The task the HUD names: Claude's todo list in progress with its real share
 * done; else a running agent, the checks, or the tool at work, with no
 * percent, since nothing measures how far those are.
 */
function activeTask(
  list: readonly NexusTask[],
  view: NexusHud,
  t: NexusTurn,
  v: NexusVerify,
  working: string | null,
): { label: string; percent?: number; count?: string } | undefined {
  const meter = taskMeter(list)
  if (meter !== undefined && (t.isWorking || meter.done < meter.total)) {
    return { label: meter.label, percent: meter.percent, count: `${meter.done}/${meter.total}` }
  }
  if (!t.isWorking && v.phase !== 'running') return undefined
  const agent = view.agents.find(one => one.status === 'running')
  if (agent !== undefined) return { label: `${agent.type}: ${agent.description}` }
  if (v.phase === 'running') return { label: 'Running lint and tests' }
  if (working !== null) return { label: working }
  if (t.tool !== null) return { label: `${t.tool}${t.detail ? ` ${t.detail}` : ''}` }

  return undefined
}

function verifyLabel(v: NexusVerify, icons: Theme['icons']): { text: string; color?: string } | undefined {
  switch (v.phase) {
    case 'running':
      return { text: `${icons.busy} checking`, color: 'yellow' }
    case 'passed':
      return { text: `${icons.ok} ${v.checks.length} check${v.checks.length === 1 ? '' : 's'} passed`, color: 'green' }
    case 'failed':
      return { text: `${icons.fail} ${v.checks.filter(check => !check.isOk).length} failing`, color: 'red' }
    case 'none':
      return { text: '· no checks found' }
    default:
      return undefined
  }
}

const COMMANDS = [
  { name: 'sessions-nexus', description: 'Nexus: every Claude Code session on this machine; inspect, pause or message one', immediate: true },
  { name: 'idea-nexus', description: 'Nexus: capture an idea to .claude/ideas.md without interrupting Claude', argumentHint: '[text]', immediate: true },
  { name: 'rollback-nexus', description: 'Nexus: put the project back as it was before the latest turn (your own edits since then too)', argumentHint: '[list | n | undo]' },
  { name: 'preview-nexus', description: 'Nexus: before/after screenshots of the frontend dev server', argumentHint: '[url] [base]' },
  { name: 'nexus', description: 'Nexus: status of every module and the keys' },
  { name: 'handoff-nexus', description: 'Nexus: what the last session in this project did, so Claude can pick it up' },
  { name: 'commit-nexus', description: 'Nexus: commit the work tree with a drafted message, after you confirm it' },
  { name: 'skin-nexus', description: 'Nexus: change the skin (theme) of the HUD and drawers', argumentHint: '[name | list | reset]', immediate: true },
  { name: 'enhance-nexus', description: 'Nexus: rewrite a rough prompt as Goal / Context / Acceptance criteria into the prompt box', argumentHint: '<rough prompt>', immediate: true },
  { name: 'context-nexus', description: 'Nexus: where the context goes before you type (MCP, CLAUDE.md, skills, agents) and what could go', immediate: true },
  { name: 'provider-nexus', description: 'Nexus: switch this claude-nexus session between Claude and a hub profile', argumentHint: '[status | use <name|claude> | test <name>]', immediate: true },
  { name: 'mcp-nexus', description: 'Nexus: turn MCP servers off or on for this project', argumentHint: '[list | off <server> | on <server>]', immediate: true },
] as const

const DESIGN_SCHEMA = {
  type: 'object',
  required: ['title', 'options'],
  properties: {
    title: { type: 'string', description: 'What the person is choosing, e.g. "Dashboard color palette"' },
    kind: { type: 'string', enum: ['palette', 'layout', 'theme', 'typography', 'component'] },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string', description: 'One sentence on the character of this option' },
          colors: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Role name to hex, e.g. {"bg":"#0f1115","fg":"#e8e8ea","accent":"#7c5cff"}',
          },
          fonts: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' }, mono: { type: 'string' } } },
          radius: { type: 'string', description: 'Corner radius, e.g. "10px"' },
          spacing: { type: 'string', description: 'Base spacing unit, e.g. "8px"' },
          html: {
            type: 'string',
            description:
              'Optional small self-contained HTML sample, inline styles only, using var(--c-<colorName>), var(--font-heading), var(--font-body), var(--radius)',
          },
        },
      },
    },
  },
}

function statusText(cfg: NexusConfig, theme: string): string {
  const on = (flag: boolean) => (flag ? 'on ' : 'off')

  return [
    'Nexus',
    `  Command Shield      ${on(cfg.shield)}  protected branches: ${cfg.protectedBranches.join(', ') || 'none'}`,
    `  Secret Sanitizer    ${on(cfg.sanitizer)}`,
    `  Turn checkpoints    ${on(cfg.checkpoints)}  /rollback-nexus [list | n | undo]`,
    `  Assumption review   ${cfg.assumptionAudit}`,
    `  Auto lint/test      ${on(cfg.autoVerify)}  self-heal attempts: ${cfg.maxHealAttempts}`,
    `  Quiet transcript    ${on(cfg.quietTranscript)}`,
    `  Executive summary   ${on(cfg.executiveSummary)}`,
    `  Design Lens         ${on(cfg.designLens)}  /preview-nexus [url] [base]`,
    `  Done/approval alert ${on(cfg.notify)}  after turns of ${Math.round(cfg.notifyAfterMs / 1000)}s or more`,
    `  Compaction guard    ${on(cfg.compactGuard)}  reminds Claude of your last request after compaction`,
    `  Trim noisy output   ${on(cfg.trimOutput)}`,
    `  Quota guard         ${cfg.quotaGuard === 0 ? 'off' : `at ${cfg.quotaGuard}%`}`,
    `  Turn footer         ${on(cfg.turnFooter)}`,
    `  Provider router     /provider-nexus  (sessions started with claude-nexus)`,
    `  Context audit       /context-nexus   MCP servers per project: /mcp-nexus${mcpOff.length > 0 ? ` (off here: ${mcpOff.join(', ')})` : ''}`,
    `  Session handoff     ${on(cfg.handoff)}  /handoff-nexus`,
    `  Loop detector       ${on(cfg.loopGuard)}`,
    `  Subagent cap        ${cfg.maxAgents === 0 ? 'none' : cfg.maxAgents}`,
    `  Next-step suggest   ${on(cfg.suggestNext)}`,
    `  Commit helper       ${on(cfg.commitHelper)}  /commit-nexus`,
    `  Skin                ${theme}  /skin-nexus [name | list | reset]${cfg.syncClaudeTheme ? "  (Claude Code's theme follows)" : ''}`,
    '',
    'HUD: branch, model, sessions (green working, yellow waiting, gray idle), running',
    '  subagents; 5h and weekly usage with resets and a red forecast when the pace runs',
    '  out first; context; cache hits with tok/s and how warm the cache is; a red',
    '  warning when a reply was cut off; the active task with its progress.',
    '',
    'Keys: ctrl+x tab focuses the bar above the prompt, then',
    '  e Enhance   g Send   s Sessions   i Idea   z Rollback   p Preview   t Skin   c Commit',
    '  (so ctrl+x tab s opens Sessions, ctrl+x tab z rolls back)',
    '  The same without the keys: /enhance-nexus <prompt>, /sessions-nexus, /idea-nexus, /rollback-nexus, /preview-nexus, /skin-nexus, /commit-nexus',
    'Turn any module on or off: /plugin configure nexus@nexus-mod',
  ].join('\n')
}

// ═══ Registration ════════════════════════════════════════════════════════

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  // ── Session start: commands, the design tool, the bridge, the HUD clock ──
  // The handoff the previous session left, read once at start (this session overwrites it as it works).
  let previousHandoff: Handoff | null = null
  let lastContextPct = 0
  // A hub compaction under way, and when the last one ended: one at a time, and not again within a minute.
  let compactingForHub = false
  let hubCompactedAt = Number.NEGATIVE_INFINITY
  // A quota window crossed while idle: asked about before the next prompt goes.
  let quotaPending: string | null = null
  // The note a compaction leaves for Claude, until it is delivered.
  let pendingAnchor: string | null = null

  on('session.start', async ($, e, next) => {
    for (const command of COMMANDS) await $.command.register(command)
    if (cfg.handoff) {
      previousHandoff = await readHandoff($).catch(() => null)
      const now = await $.clock.now()
      if (previousHandoff !== null && now - previousHandoff.at < 14 * 86_400_000) {
        $.ui.toast(handoffLine(previousHandoff, now), { timeoutMs: 10_000 })
      }
    }
    if (cfg.designLens) {
      await $.tool.register({
        name: 'design_options',
        description:
          'Show the person 2-6 visual design options (color palettes, layouts, component themes, typography) as live cards in their browser and a terminal pane, instead of describing them in text. Their pick comes back as their next message with its design tokens. After calling it, end your turn with one short line.',
        inputSchema: DESIGN_SCHEMA,
        isDeferred: false,
      })
      void runBridge($)
    }
    const picked = (await storedTheme($)) ?? cfg.theme
    await update($, themeName, () => picked)
    const saved = await listCheckpoints($)
    await update($, checkpoints, () => saved)
    if (cfg.checkpoints) void pruneShadow($).catch(() => undefined)
    await loadIdeas($)
    await loadMcpOff($)
    await loadProfiles($)
    if ((await ensureRouterLink($)) !== null) {
      // A plain session in this folder asked to go on here, on a hub: switch now (no compaction ask: nothing has been sent yet).
      const pending = await takePendingRoute($)
      if (pending === null) void providerStatus($).catch(() => undefined)
      else void useRoute($, pending, { askCompact: false }).then(text => $.ui.toast(text, { timeoutMs: 10_000 })).catch(() => undefined)
      void watchRouter($, cfg, true).catch(() => undefined)
    }
    void refreshHud($, true).catch(() => undefined)
    $.clock.every(4000, () => {
      void refreshHud($).catch(() => undefined)
      void watchLongTurn($, cfg).catch(() => undefined)
    })

    return next(e)
  })

  // ── Commands ──────────────────────────────────────────────────────────
  on('command.run', { command: 'sessions-nexus' }, async $ => {
    await openPane($, PANE.sessions, 'Sessions')

    return {}
  })

  on('command.run', { command: 'idea-nexus' }, async ($, e) => {
    if (e.args.trim() !== '') await addIdea($, e.args)
    else await openPane($, PANE.idea, 'Idea scratchpad')

    return {}
  })

  on('command.run', { command: 'rollback-nexus' }, async ($, e) => ({ text: await runRollback($, e.args) }))

  on('command.run', { command: 'preview-nexus' }, async ($, e) => ({ text: await runPreview($, cfg, e.args) }))

  on('command.run', { command: 'nexus' }, async $ => ({ text: statusText(cfg, await read($, themeName)) }))

  on('command.run', { command: 'handoff-nexus' }, async $ => {
    const record = previousHandoff ?? (await readHandoff($))
    if (record === null) return { text: 'No earlier session of this project has a handoff yet.' }

    return { text: handoffText(record, await $.clock.now()) }
  })

  on('command.run', { command: 'commit-nexus' }, async $ => ({ text: await runCommit($, cfg) }))

  on('command.run', { command: 'context-nexus' }, async $ => {
    const usage = await $.session.usage({ breakdown: 'full' })
    const breakdown = usage.context.breakdown
    if (breakdown === undefined) return { text: 'No context breakdown yet: send one message first, then run /context-nexus again.' }

    return { text: contextReport(breakdown, mcpOff, await projectRoot($)) }
  })

  on('command.run', { command: 'enhance-nexus' }, async ($, e) => {
    if (e.args.trim() === '') return { text: 'Write the rough prompt after the command: /enhance-nexus add a CSV export to the orders page. The rewrite lands in the prompt box for you to read before sending.' }
    void enhancePrompt($, cfg, e.args).catch(() => undefined)

    return { text: `Enhancing with ${cfg.helperModel}; the rewrite lands in the prompt box in a few seconds. Read it, edit it, then press Enter.` }
  })

  on('command.run', { command: 'mcp-nexus' }, async ($, e) => ({ text: await runMcp($, e.args) }))

  on('command.run', { command: 'provider-nexus' }, async ($, e) => {
    if ((await ensureRouterLink($)) !== null) void watchRouter($, cfg, false).catch(() => undefined)
    const parsed = parseProviderArgs(e.args)
    if (parsed.verb === 'error') return { text: parsed.message }
    if (parsed.verb === 'status') return { text: await providerStatus($) }
    if (parsed.verb === 'use') return { text: await useRoute($, parsed.name) }
    if (parsed.verb === 'test') return { text: await testProfile($, parsed.name) }
    await closeDraft($)
    await loadProfiles($)
    await openPane($, PANE.provider, 'Providers')

    return {}
  })

  // Esc or the close mark ends a half-typed form; the key it held goes too.
  on('ui.close', { id: PANE.provider }, async ($, e, next) => {
    const result = await next(e)
    await closeDraft($)

    return result
  })

  // ── MCP servers turned off in this project: a one-line note behind ToolSearch ─
  on('tool.describe', async ($, e, next) => {
    const server = mcpServerOf(e.tool)
    if (server === undefined || !mcpOff.includes(server)) return next(e)

    return { description: offDescription(server), isDeferred: true }
  })

  // The person picking a Claude Code theme while a skin holds it: that pick is
  // now their own, the one a skin like `default` goes back to.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const answer = await next(e)
    if (!isSyncingTheme && answer.deny === undefined && typeof answer.value === 'string') {
      const stored = await $.store.get(OWN_CLAUDE_THEME_KEY).catch(() => null)
      if (typeof stored === 'string') await $.store.set(OWN_CLAUDE_THEME_KEY, answer.value).catch(() => undefined)
    }

    return answer
  })

  on('command.run', { command: 'skin-nexus' }, async ($, e) => {
    const text = await runTheme($, cfg, e.args)

    return text === undefined ? {} : { text }
  })

  // ── The design tool the model calls ───────────────────────────────────
  on('tool.call', { tool: new RegExp(`^${DESIGN_TOOL}$`) }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const options = readOptions(input.options)
    if (options.length < 2) {
      return { deny: 'design_options needs at least two options, each with a name (and ideally colors, fonts and a small HTML sample).' }
    }
    const now = await $.clock.now()
    const id = `design-${now.toString(36)}`
    const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : 'Design options'
    const kind = typeof input.kind === 'string' ? input.kind : 'design'
    const canPost = (await read($, bridgePort)) !== null
    const file = `${id}.html`
    const set = { id, title, kind, url: '', options }
    await $.fs.write(`${await previewsDir($)}/${file}`, designPage(set, canPost))
    const url = await previewUrl($, file)
    await update($, design, () => ({ ...set, url }))
    const opened = await openExternal($, url)
    await $.ui.open({ id: PANE.design, title: clip(`Design · ${title}`, 40) }).catch(() => undefined)

    return {
      result: `Showing ${options.length} options to the person ${opened ? 'in their browser' : `at ${url}`} and in a terminal pane. Their choice will arrive as their next message with its design tokens. End your turn now with one short line; do not describe the options again.`,
    }
  })

  // ── Guards on every other tool call: shield, review, checkpoint, progress, loops ─
  let loop: LoopState = NO_LOOP
  let checkpointKey: string | null = null
  let checkpointRun: Promise<unknown> = Promise.resolve()
  let auditedTurn: string | null = null

  const shieldHits = (tool: string, command: string | undefined, branch: string | null) =>
    cfg.shield && command !== undefined && SHELL_TOOLS.has(tool)
      ? scanCommand(command, { branch, protectedBranches: cfg.protectedBranches })
      : []

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === DESIGN_TOOL || tool === 'AskUserQuestion') return next(e)
    const isMain = e.agentId === undefined
    const command = SHELL_TOOLS.has(tool) ? field(e, 'command') : undefined
    const server = mcpServerOf(tool)
    if (server !== undefined && mcpOff.includes(server)) {
      return { deny: `The MCP server "${server}" is turned off in this project by Nexus. Do without it, or ask the user to run /mcp-nexus on ${server}.` }
    }

    // 1. Command Shield
    if (command !== undefined && cfg.shield) {
      const branch = mayPush(command) ? await currentBranch($) : null
      const hits = shieldHits(tool, command, branch)
      if (hits.length > 0 && !(await confirmDanger($, tool, command, hits))) {
        return {
          deny: `Nexus Command Shield blocked this command: it ${hits.map(hit => hit.why).join('; ')}. The user declined it. Find a safer way, or ask the user to run it themselves.`,
        }
      }
    }

    // 1b. Secret masks: never written back over the real secret
    if (cfg.sanitizer) {
      const verdict = await guardMasks($, tool, e)
      if (verdict !== undefined) return { deny: verdict }
    }

    // 2. Assumption review, before the plan is shown or the first edit lands
    if (isMain && cfg.assumptionAudit !== 'off') {
      if (tool === 'ExitPlanMode') {
        const verdict = await reviewAssumptions($, cfg, 'plan', field(e, 'plan') ?? '')
        if (verdict !== undefined) return { deny: verdict }
      } else if (cfg.assumptionAudit === 'first-edit' && FILE_TOOLS.has(tool)) {
        const { id } = await read($, turn)
        if (id !== null && auditedTurn !== id) {
          auditedTurn = id
          const verdict = await reviewAssumptions($, cfg, 'edit', undefined)
          if (verdict !== undefined) return { deny: verdict }
        }
      }
    }

    // 3. Turn checkpoint, once per turn, before the first change
    const isMutating = FILE_TOOLS.has(tool) || (command !== undefined && isMutatingCommand(command))
    if (cfg.checkpoints && isMutating) {
      const { id } = await read($, turn)
      const key = id ?? 'outside-a-turn'
      if (checkpointKey !== key) {
        checkpointKey = key
        checkpointRun = (async () => {
          await update($, busy, () => 'Saving checkpoint')
          try {
            await snapshot($, `turn ${key}: before ${tool} ${clip(describeInput(e), 60)}`, 'turn', id)
          } catch (error) {
            $.ui.toast(`Checkpoint skipped: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            await update($, busy, () => null)
          }
        })()
      }
      await checkpointRun
    }

    // 4. Progress for the HUD and the spinner
    const file = field(e, 'file_path') ?? field(e, 'notebook_path')
    await update($, turn, now => ({
      ...now,
      tool,
      detail: clip(describeInput(e), 80),
      tools: now.tools + 1,
      changed:
        file !== undefined && FILE_TOOLS.has(tool) && !now.changed.includes(file) ? [...now.changed, file] : now.changed,
      hasMutated: now.hasMutated || isMutating,
    }))
    try {
      const answer = await next(e)
      // 4b. Long, routine shell output folded before Claude reads it
      const result = cfg.trimOutput && command !== undefined ? await trimShellResult($, command, answer).catch(() => answer) : answer
      if (!cfg.loopGuard || !isMain) return result
      // 5. Loop detector: the same call failing, or made, over and over
      const step = trackCall(loop, callSignature(e), result.deny !== undefined || result.isError === true)
      loop = step.state
      if (step.verdict === 'none') return result
      const note =
        step.verdict === 'failing'
          ? `Nexus loop detector: this exact ${tool} call has now failed 3 times in a row. Stop repeating it. Read the error, find the cause, and try a different approach, or ask the user.`
          : `Nexus loop detector: this exact ${tool} call has now been made 6 times in a row. You are likely stuck in a loop; step back and change approach.`
      $.ui.toast(step.verdict === 'failing' ? `Loop: ${tool} failed 3× in a row; told Claude to change approach` : `Loop: ${tool} repeated 6×; told Claude to step back`)
      if (result.deny !== undefined) return { deny: `${result.deny}\n\n${note}` }

      return { ...result, context: [...(result.context ?? []), note] }
    } finally {
      await update($, turn, now => (now.tool === tool ? { ...now, tool: null, detail: null } : now))
    }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const tool = String(e.tool)
    // The guard failed, or was asked from beneath its own call: judge from `e` alone.
    if (shieldHits(tool, SHELL_TOOLS.has(tool) ? field(e, 'command') : undefined, null).length > 0) {
      return { deny: 'Nexus Command Shield could not confirm this dangerous command with the user, so it was blocked.' }
    }
    if (cfg.sanitizer && carriesMask(tool, e)) {
      return { deny: 'Nexus could not check this call for secret masks (…[REDACTED:…]), so it was blocked to keep the real secret. Leave the masked value out of what you write.' }
    }

    return next(e)
  })

  // ── Secret Leak Sanitizer: every row, before it is stored or sent ──────
  on('session.append', ($, e, next) => {
    if (!cfg.sanitizer) return next(e)
    const found = { count: 0, kinds: new Set<string>() }
    const content = e.message.content.map(block => maskBlock(block, found))
    if (found.count === 0) return next(e)
    try {
      $.ui.toast(`Masked ${found.count} secret${found.count === 1 ? '' : 's'} (${[...found.kinds].join(', ')})`)
    } catch {
      // the row is what matters; a toast that cannot show changes nothing
    }

    return next({ ...e, message: { ...e.message, content } })
  })

  // ── Usage windows: redraw the quotas the moment a window moves ────────
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') || e.changed.includes('context')) {
      const limits = readLimits(e.rateLimits)
      const { context } = e
      const at = await $.clock.now()
      recordLimits(limits, at)
      const pct = context.percent ?? (context.tokens === undefined ? 0 : Math.round((context.tokens / context.window) * 100))
      if (cfg.compactGuard && lastContextPct < 80 && pct >= 80) {
        $.ui.toast(`Context ${pct}% full: compaction is near. Nexus will tell it to keep file paths, open tasks and check results.`, { timeoutMs: 8000 })
      }
      lastContextPct = pct
      await update($, hud, now => ({
        ...now,
        limits,
        tokens: context.tokens ?? now.tokens,
        window: context.window,
        percent: context.percent ?? now.percent,
        at,
      }))
      // On a hub, compact before the profile's own window fills.
      const view = await read($, provider)
      if (view.route !== 'claude' && !compactingForHub && at - hubCompactedAt >= HUB_COMPACT_COOLDOWN_MS) {
        const profile = view.profiles.find(one => one.name === view.route)
        if (profile !== undefined && needsCompaction(context.tokens ?? null, profile.contextWindow, 0.85)) {
          compactingForHub = true
          void $.session
            .compact({ instructions: 'Keep file paths, open tasks, check results and decisions.' })
            .catch(() => undefined)
            .then(() => $.clock.now())
            .then(ended => {
              hubCompactedAt = ended
            })
            .catch(() => {
              hubCompactedAt = at
            })
            .finally(() => {
              compactingForHub = false
            })
        }
      }
      // Quota guard: once per window, ask mid-turn; idle, ask before the next prompt
      if (cfg.quotaGuard > 0 && e.changed.includes('rateLimits')) {
        void (async () => {
          const crossed = await crossedQuota($, cfg, limits)
          if (crossed === null) return
          const what = crossed.text
          const current = await read($, turn)
          if (current.isWorking && current.id !== null) {
            const isLinked = (await read($, routerLink)) !== null
            const onClaude = (await read($, provider)).route === 'claude'
            const choice = onClaude ? fallbackChoices(await loadProfiles($))[0]?.name : undefined
            await askQuotaMidTurn($, what, current.id, choice, crossed.resetsAt, isLinked)
          } else {
            quotaPending = what
            $.ui.toast(`Quota: ${what}.`, { timeoutMs: 10_000 })
          }
        })().catch(() => undefined)
      }
    }

    return next(e)
  })

  // ── Response readings: speed from the first chunk, cache hits, cut-offs ─
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (e.agentId !== undefined) return yield* stream
    let firstAt: number | null = null
    for await (const chunk of stream) {
      if (firstAt === null) firstAt = await $.clock.now()
      yield chunk
    }
    const result = await stream.result
    try {
      const endAt = await $.clock.now()
      const { usage } = result
      const tps = usage === null || firstAt === null ? undefined : tokensPerSecond(usage.output_tokens, firstAt, endAt)
      const cacheHit = usage === null ? undefined : cacheHitPercent(usage)
      const cutoff = cutoffLabel(result.stopReason) ?? null
      if (usage !== null || cutoff !== null) {
        await update($, speed, before => ({
          // a reply too short to time keeps the last speed on show
          tps: tps ?? before?.tps ?? null,
          cacheHit: cacheHit ?? before?.cacheHit ?? null,
          cutoff,
          at: endAt,
        }))
      }
      if (cutoff !== null) $.ui.toast(`Nexus: ${cutoff}`)
    } catch {
      // the readings are a nicety only; the response stands
    }

    return result
  })

  // ── Task progress: follow Claude's todo/task list ─────────────────────
  on('tool.call', { tool: /^(TodoWrite|TaskCreate|TaskUpdate)$/ }, async ($, e, next) => {
    const tool = String(e.tool)
    const result = await next(e)
    if (result.deny !== undefined || result.isError === true) return result
    try {
      const input = e as unknown as Record<string, unknown>
      if (tool === 'TodoWrite' && e.agentId === undefined) {
        const list = tasksFromTodos(input.todos)
        await update($, tasks, () => list)
      } else if (tool === 'TaskCreate') {
        const made = (result.result ?? {}) as { task?: { id?: unknown; subject?: unknown } }
        const id = String(made.task?.id ?? '')
        const label = String(input.subject ?? made.task?.subject ?? '').trim()
        if (id !== '' && label !== '') {
          await update($, tasks, now => [...now.filter(task => task.id !== id), { id, label, status: 'pending' as const }])
        }
      } else if (tool === 'TaskUpdate') {
        await update($, tasks, now => applyTaskUpdate(now, input))
      }
    } catch {
      // the meter is a nicety; the call's result is what matters
    }

    return result
  })

  // ── Turn tracking ─────────────────────────────────────────────────────
  on('turn.start', async ($, e, next) => {
    await update($, turn, () => ({ ...IDLE_TURN, id: e.turnId, isWorking: true }))
    loop = NO_LOOP
    longTurn.startedAt = await $.clock.now()
    longTurn.isWarned = false
    // A list Claude finished last turn leaves the meter with this one.
    await update($, tasks, now => (now.length > 0 && now.every(task => task.status === 'completed') ? [] : now))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    longTurn.startedAt = null
    const finished = await read($, turn)
    await update($, turn, now => ({ ...now, isWorking: false, isWaiting: false, tool: null, detail: null }))
    void refreshHud($).catch(() => undefined)
    let footerResult: typeof result | null = null
    try {
      const files = await Promise.all(finished.changed.map(path => projectPath($, path)))
      const hasChanges = files.length > 0 || finished.hasMutated
      await update($, work, now => ({
        ...now,
        turns: now.turns + 1,
        files: [...now.files.filter(file => !files.includes(file)), ...files],
        commitReady: now.commitReady || (cfg.commitHelper && hasChanges),
      }))
      if (cfg.handoff) await saveHandoff($)
      // 2. Done alert, for a turn long enough to have walked away from
      if (cfg.notify && !e.isAborted && e.durationMs >= cfg.notifyAfterMs) {
        const took = untilReset(e.durationMs, 0)
        const first = clip(e.answer.split(/\r?\n/).find(line => line.trim() !== '') ?? 'Done', 140)
        void $.ui.notify(`Done in ${took}: ${first}`, { title: `Claude Code · ${(await projectRoot($)).split('/').pop() ?? ''}` }).catch(() => undefined)
        void playSound($, 'done')
      }
      // 8. Offer the reply's first next step as the prompt's suggestion
      const step = cfg.suggestNext && !e.isAborted ? nextStepFrom(e.answer) : undefined
      if (step !== undefined) void suggestLater($, step).catch(() => undefined)
      // 9. One dim line under the answer: time, tools, files, context, checks
      if (cfg.turnFooter && !e.isAborted && e.reason === 'answer' && finished.tools > 0) {
        const [v, h, now] = await Promise.all([read($, verify), read($, hud), $.clock.now()])
        const isThisTurn = v.at >= now - e.durationMs - 1000
        const footer = footerText({
          durationMs: e.durationMs,
          tools: finished.tools,
          files: finished.changed.length,
          contextPct: h.percent,
          checks: isThisTurn && (v.phase === 'passed' || v.phase === 'failed') ? v.phase : null,
        })

        footerResult = { ...result, text: footer }
      }
      // 10. Claude's quota is back after a fallback: offered once, at the turn's end
      const view = await read($, provider)
      const backAt = await read($, claudeBackAt)
      if (view.route !== 'claude' && backAt !== null && (await $.clock.now()) >= backAt) {
        await update($, claudeBackAt, () => null)
        void $.ui
          .ask("Claude's quota has reset. Go back to Claude?", { header: 'Provider', options: ['Back to Claude', `Stay on ${view.route}`] })
          .then(async answer => {
            if (answer === 'Back to Claude') $.ui.toast(await useRoute($, 'claude'))
          })
          .catch(() => undefined)
      }
      if (footerResult !== null) return footerResult
    } catch {
      // the turn is over either way; these are niceties
    }

    return result
  })

  // ── Attention alert: Claude waits on the person (a permission, a question) ─
  let attentionAt = 0
  on('classic.Notification', async ($, e, next) => {
    const now = await $.clock.now()
    // One sound per wait: idle reminders and repeats inside 30 s stay quiet.
    if (cfg.notify && now - attentionAt > 30_000) {
      attentionAt = now
      void playSound($, 'attention')
    }

    return next(e)
  })

  // ── Compaction guard: tell the summary what it must keep ──────────────
  on('session.compact', async ($, e, next) => {
    if (!cfg.compactGuard || e.agentId !== undefined) return next(e)
    const [done, list, v] = await Promise.all([read($, work), read($, tasks), read($, verify)])
    const keep = compactInstructions({ files: done.files, tasks: list, checks: checksText(v) })
    const result = await next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${keep}` : keep })
    // What Claude reads first after the summary: the last request word for word, open work, the rules
    if (e.trigger !== 'precompute' && result.skip === undefined) {
      pendingAnchor = anchorText({
        request: lastRequestIn(e.messages) || done.lastPrompt,
        tasks: list,
        files: done.files,
        checks: checksText(v),
        claudeMd: await readText($, `${await projectRoot($)}/CLAUDE.md`),
      })
    }

    return result
  })

  // The compaction stands: the anchor goes in now, so even a turn that goes on reads it.
  on('classic.PostCompact', async ($, e, next) => {
    if (pendingAnchor !== null) {
      const text = pendingAnchor
      pendingAnchor = null
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => {
        pendingAnchor = text
      })
    }

    return next(e)
  })

  // ── Session handoff: the last word before the session closes ──────────
  on('session.end', async ($, e, next) => {
    if (cfg.handoff) await saveHandoff($).catch(() => undefined)

    return next(e)
  })

  // ── Subagent monitor: when each started, and an optional cap ──────────
  on('agent.spawn', async ($, e, next) => {
    if (cfg.maxAgents > 0) {
      const running = (await $.agent.list().catch(() => [])).filter(agent => agent.status === 'running').length
      if (running >= cfg.maxAgents) {
        $.ui.toast(`Subagent refused: ${running} already running (limit ${cfg.maxAgents})`)

        return { deny: `Nexus allows at most ${cfg.maxAgents} subagents at once and ${running} are running. Wait for one to finish, or do this part yourself.` }
      }
    }
    const result = await next(e)
    const id = result.agentId
    if (id !== undefined) {
      const at = await $.clock.now()
      await update($, work, now => ({ ...now, agentStarts: { ...now.agentStarts, [id]: at } }))
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // The person's words: typed, from a bridge, or sent by the band's Send as theirs.
    const origin = e.origin as { kind: string; asUser?: boolean }
    const isPerson = origin.kind === 'composer' || origin.kind === 'bridge' || (origin.kind === 'plugin' && origin.asUser === true)
    if (isPerson && quotaPending !== null && !e.text.trim().startsWith('/')) {
      const what = quotaPending
      quotaPending = null
      const answer = await $.ui
        .ask(`⚠ QUOTA: ${what}. Send this prompt anyway?`, { header: 'Quota', options: [QUOTA_SEND, QUOTA_HOLD] })
        .catch(() => QUOTA_SEND)
      if (answer === QUOTA_HOLD) {
        const held = e.text
        $.clock.after(200, () => void $.prompt.fill({ text: held, mode: 'replace' }).catch(() => undefined))

        return { drop: 'Held to save quota; the prompt is back in the box.' }
      }
    }
    if (isPerson) {
      await update($, healAttempts, () => 0)
      const text = clip(e.text, 300)
      if (text !== '' && !text.startsWith('/')) await update($, work, now => ({ ...now, lastPrompt: text }))
    }
    // An anchor no PostCompact delivered rides along with the next prompt.
    if (pendingAnchor !== null && !e.text.trim().startsWith('/')) {
      const anchor = pendingAnchor
      pendingAnchor = null

      return next({ ...e, context: [...(e.context ?? []), anchor] })
    }

    return next(e)
  })

  // ── Delivery rules in the system prompt ───────────────────────────────
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = deliveryRules(cfg)
    if (text === '') return composed

    return { ...composed, sections: [...composed.sections, { id: 'nexus:delivery', text, scope: 'session' as const }] }
  })

  // ── Auto lint/test: when the model stops after changing files, run the
  //    project's own checks; a failure sends it back to fix, a few times ──
  on('classic.Stop', async ($, e, next) => {
    if (!cfg.autoVerify) return next(e)
    const now = await read($, turn)
    if (now.changed.length === 0 && !now.hasMutated) return next(e)
    const plans = await detectChecks($)
    if (plans.length === 0) {
      const at = await $.clock.now()
      await update($, verify, () => ({ phase: 'none' as const, checks: [], at }))

      return next(e)
    }
    await update($, verify, before => ({ ...before, phase: 'running' as const }))
    const checks = await runChecks($, plans, cfg.verifyTimeoutMs)
    const failed = checks.filter(check => !check.isOk)
    const at = await $.clock.now()
    const summary = checks.map(check => `${check.isOk ? '✓' : '✗'} ${check.name} (${(check.ms / 1000).toFixed(1)}s)`).join('  ')
    const note = (text: string) =>
      $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => undefined)
    if (failed.length === 0) {
      await update($, verify, () => ({ phase: 'passed' as const, checks, at }))
      await update($, healAttempts, () => 0)
      await note(`Nexus verified: ${summary}`)

      return next(e)
    }
    await update($, verify, () => ({ phase: 'failed' as const, checks, at }))
    const attempts = await read($, healAttempts)
    if (attempts >= cfg.maxHealAttempts) {
      await note(`Nexus: checks still failing after ${attempts} self-heal attempt(s): ${summary}`)

      return next(e)
    }
    await update($, healAttempts, n => n + 1)

    return {
      block: [
        `Nexus auto-verification failed (self-heal attempt ${attempts + 1} of ${cfg.maxHealAttempts}). Fix the cause, re-run the failing command yourself, then give your final reply again.`,
        ...failed.map(check => `## ${check.name}\n${check.tail}`),
      ].join('\n\n'),
    }
  })

  // ═══ Layout coordinator: every drawing goes through these hooks ═══════

  // The band above the prompt: HUD row, action bar, status row.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const [now, t, v, cps, working, list, rate, skin, route] = await Promise.all([
      read($, hud),
      read($, turn),
      read($, verify),
      read($, checkpoints),
      read($, busy),
      read($, tasks),
      read($, speed),
      read($, themeName),
      read($, provider),
    ])
    const th = themeOf(skin)
    const ic = th.icons
    const tint = (color: string) => paint(color, th)
    // r: Claude ⇄ hub in a claude-nexus session; in a plain one it copies the restart command.
    const flipTo = toggleTarget(route.route, route.lastHub, route.profiles)
    const cols = e.props.bodyColumns
    const counts = { working: 0, waiting: 0, done: 0 }
    for (const peer of now.peers) counts[peer.status] += 1
    const gauges = hudGauges(now, rate, now.at, t.isWorking, ic)
    const done = await read($, work)
    const runningAgents = now.agents.filter(agent => agent.status === 'running').length
    // Two columns side by side when they fit, else one gauge per row.
    const isGrid = cols >= 80 && gauges.left.length > 0 && gauges.right.length > 0
    const gridRows: (readonly [Gauge | undefined, Gauge | undefined])[] = isGrid
      ? Array.from({ length: Math.max(gauges.left.length, gauges.right.length) }, (_, i) => [gauges.left[i], gauges.right[i]] as const)
      : [...gauges.left, ...gauges.right].map(one => [one, undefined] as const)
    const cellWidth = (one: Gauge) => 7 + 10 + (one.percent === null ? 2 : 7) + one.detail.length + (one.note === undefined ? 0 : one.note.text.length + 1)
    const leftWidth = Math.max(36, ...gauges.left.map(one => cellWidth(one) + 4))
    const isWide = cols >= 76
    const cell = (one: Gauge | undefined, width: number | undefined) => {
      if (one === undefined) return width === undefined ? null : <Text key="hole">{' '.repeat(width)}</Text>
      const head = `${one.name.padEnd(6)} `
      const pct = one.percent === null ? '' : `${String(one.percent).padStart(4)}%  `
      const used = head.length + 10 + (pct === '' ? 2 : pct.length) + one.detail.length + (one.note === undefined ? 0 : one.note.text.length + 1)
      const pad = width === undefined ? '' : ' '.repeat(Math.max(0, width - used))

      return (
        <Text key={one.key}>
          <Text dimColor>{head}</Text>
          {one.percent === null ? <Text>{' '.repeat(10)}</Text> : <Text color={tint(one.color)}>{themedBar(one.percent, th)}</Text>}
          <Text color={tint(one.color)}>{pct === '' ? '  ' : pct}</Text>
          <Text dimColor>{one.detail}</Text>
          {one.note === undefined ? null : <Text color={tint(one.note.color)}>{` ${one.note.text}`}</Text>}
          <Text>{pad}</Text>
        </Text>
      )
    }
    const status = verifyLabel(v, ic)
    const task = activeTask(list, now, t, v, working)
    const lastCheckpoint = cps.filter(one => one.kind === 'turn').at(-1)
    const hasStatusRow = working !== null || status !== undefined || lastCheckpoint !== undefined
    const taskRoom = Math.max(12, cols - (task?.percent === undefined ? 12 : 34))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text wrap="truncate-end">
            <Text color={th.accent}>{ic.branch} {now.branch ?? 'no git'}</Text>
            {route.route !== 'claude' ? (
              <Text color={tint('magenta')}> · {hubBadge(route.route, route.model)}</Text>
            ) : (
              now.model !== '' && <Text> · {ic.model} {now.model}</Text>
            )}
            <Text dimColor> · </Text>
            <Text color={th.ok}>{ic.dot} {counts.working}{isWide ? ' working' : ''} </Text>
            <Text color={th.warn}> {ic.dot} {counts.waiting}{isWide ? ' waiting' : ''} </Text>
            <Text color={th.idle}> {ic.dot} {counts.done}{isWide ? ' idle' : ''}</Text>
            {runningAgents > 0 ? <Text color={th.agent}>{`  ${ic.agent} ${runningAgents} agent${runningAgents === 1 ? '' : 's'}`}</Text> : null}
            {rate?.cutoff ? <Text color={th.bad} bold>{`  ${ic.warn} ${rate.cutoff}`}</Text> : null}
          </Text>
        </Box>
        {gridRows.map(([one, two], index) => (
          <Box key={`gauges-${index}`} flexDirection="row">
            {cell(one, two === undefined ? undefined : leftWidth)}
            {two === undefined ? null : cell(two, undefined)}
          </Box>
        ))}
        {task !== undefined && (
          <Box flexDirection="row">
            <Text color={th.accent} wrap="truncate-end">
              [Task: {clip(task.label, taskRoom)}
              {task.percent === undefined ? '' : ` (${task.percent}%)`}]
            </Text>
            {task.percent !== undefined && (
              <Text dimColor>
                {'  '}
                {themedBar(task.percent, th)} {task.count}
              </Text>
            )}
          </Box>
        )}
        <Box flexDirection="row" columnGap={2}>
          <Button key="enhance" plain hotkey="e" label={isWide ? 'Enhance' : 'Enh'} onPress={() => void enhancePrompt($, cfg)} />
          <Button key="send" plain hotkey="g" label="Send" onPress={() => void sendPrompt($)} />
          <Button key="sessions" plain hotkey="s" label={isWide ? 'Sessions' : 'Ses'} onPress={() => void openPane($, PANE.sessions, 'Sessions')} />
          <Button key="idea" plain hotkey="i" label="Idea" onPress={() => void openPane($, PANE.idea, 'Idea scratchpad')} />
          <Button
            key="rollback"
            plain
            hotkey="z"
            label={isWide ? 'Rollback' : 'Undo'}
            onPress={async () => {
              const answer = await $.ui
                .ask('Put the project back as it was before the latest turn? Edits you made since then are undone too (/rollback-nexus undo brings them back).', { header: 'Rollback', options: ['Roll back', 'Cancel'] })
                .catch(() => 'Cancel')
              if (answer === 'Roll back') await $.command.run({ command: 'rollback-nexus', args: '' })
            }}
          />
          {isWide && (
            <Button key="preview" plain hotkey="p" label="Preview" onPress={() => void $.command.run({ command: 'preview-nexus', args: '' })} />
          )}
          {isWide && <Button key="skin" plain hotkey="t" label="Skin" onPress={() => void openPane($, PANE.theme, 'Skin')} />}
          {flipTo !== null && (
            <Button
              key="route"
              plain
              hotkey="r"
              label={flipTo === 'claude' ? '→ Claude' : `→ ${clip(flipTo, 12)}`}
              onPress={async press => $.ui.toast(await useRoute($, flipTo, { surface: press.surface }), { timeoutMs: 12_000 })}
            />
          )}
          {cfg.commitHelper && done.commitReady && now.branch !== null && (
            <Button key="commit" plain hotkey="c" label="Commit" onPress={() => void $.command.run({ command: 'commit-nexus', args: '' })} />
          )}
        </Box>
        {hasStatusRow && (
          <Box flexDirection="row" columnGap={2}>
            {working !== null && <Text color={th.warn}>{ic.busy} {working}…</Text>}
            {status !== undefined && (
              <Text {...(status.color === undefined ? { dimColor: true } : { color: tint(status.color) })}>{status.text}</Text>
            )}
            {lastCheckpoint !== undefined && (
              <Text dimColor>{ic.checkpoint} checkpoint {ago(lastCheckpoint.at, Math.max(now.at, lastCheckpoint.at))} ago</Text>
            )}
          </Box>
        )}
      </Box>
    )
  })

  // Drawer: sessions across the machine.
  on('ui.render', { component: 'Pane', requestId: PANE.sessions }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const view = await read($, hud)
    const started = (await read($, work)).agentStarts
    const chosenId = await read($, selectedPeer)
    const th = themeOf(await read($, themeName))
    const chosen = view.peers.find(peer => peer.id === chosenId) ?? view.peers[0]
    const room = Math.max(20, e.props.bodyColumns - 34)

    return (
      <Box flexDirection="column">
        <Text bold>Claude Code sessions on this machine: {view.peers.length}</Text>
        {view.peers.length === 0 && <Text dimColor>No session files found under ~/.claude/sessions.</Text>}
        {view.peers.map((peer, index) => (
          <Button
            key={`peer-${peer.id}`}
            plain
            {...(index < 9 ? { hotkey: String(index + 1) } : {})}
            onPress={() => update($, selectedPeer, () => peer.id)}
          >
            <Text color={paint(DOT[peer.status], th)}>{th.icons.dot}</Text> {peer.id === chosen?.id ? '▸ ' : ''}
            {clip(peer.name, 24)}
            {peer.isSelf ? ' (this)' : ''}{' '}
            <Text dimColor>
              {peer.status} · {ago(peer.updatedAt, view.at)} · {clip(peer.cwd, room)}
            </Text>
          </Button>
        ))}
        {view.agents.length > 0 && <Text bold>Agents in this session: {view.agents.length}</Text>}
        {view.agents.map(agent => (
          <Text key={`agent-${agent.id}`} dimColor>
            {'  '}
            {agent.status === 'running' ? '●' : '○'} {agent.type}: {clip(agent.description, room)} ({agent.status}
            {started[agent.id] === undefined ? '' : `, ${ago(started[agent.id] ?? 0, view.at)}`})
          </Text>
        ))}
        {chosen !== undefined && (
          <Box flexDirection="column" marginTop={1} borderStyle={th.border} borderColor={th.idle} paddingX={1}>
            <Text bold>{chosen.name}</Text>
            <Text dimColor>
              pid {chosen.pid} · v{chosen.version} · reports "{chosen.rawStatus}" · {chosen.id}
            </Text>
            <Text dimColor wrap="truncate-end">
              {chosen.cwd}
            </Text>
            <Box flexDirection="row" columnGap={2}>
              {!chosen.isSelf && (
                <Button key="pause" plain hotkey="p" label="Ask it to pause" onPress={() => void messagePeer($, chosen.id, PAUSE_TEXT)} />
              )}
              <Button
                key="copy"
                plain
                hotkey="c"
                label="Copy resume command"
                onPress={async press => {
                  // `;` on Windows: PowerShell 5.1 has no `&&`.
                  const then = (await isWindows($)) ? ';' : ' &&'
                  const copied = await $.ui.copy({ text: `cd "${chosen.cwd}"${then} claude --resume ${chosen.id}`, surface: press.surface })
                  $.ui.toast(copied.isCopied ? 'Copied: paste it in another terminal to switch' : 'Copy failed')
                }}
              />
              <Button key="refresh" plain hotkey="r" label="Refresh" onPress={() => void refreshHud($, true)} />
            </Box>
            {!chosen.isSelf && Input !== undefined && (
              <Input
                key="message"
                placeholder="Message this session, Enter sends"
                onSubmit={value => {
                  if (value.trim() !== '') void messagePeer($, chosen.id, value.trim())
                }}
              />
            )}
          </Box>
        )}
        <Text dimColor>1-9 select · p pause · c copy resume · r refresh · Esc close</Text>
      </Box>
    )
  })

  // Drawer: idea scratchpad.
  on('ui.render', { component: 'Pane', requestId: PANE.idea }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, ideas)

    return (
      <Box flexDirection="column">
        {Input !== undefined && (
          <Input key="idea" autoFocus placeholder="Capture an idea, Enter saves (Claude keeps working)" onSubmit={value => void addIdea($, value)} />
        )}
        {list.length === 0 && <Text dimColor>No ideas yet. They go to .claude/ideas.md and are never sent to Claude.</Text>}
        {list.slice(-8).map((line, index) => (
          <Text key={`idea-${index}`} dimColor wrap="truncate-end">
            {line}
          </Text>
        ))}
        <Button key="open" plain hotkey="o" label="Open ideas.md" onPress={async () => void (await openExternal($, await ideasPath($)))} />
      </Box>
    )
  })

  // Drawer: design lens.
  on('ui.render', { component: 'Pane', requestId: PANE.design }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const set = await read($, design)
    if (set === null) return <Text dimColor>No design options are waiting for a pick.</Text>

    return (
      <Box flexDirection="column">
        <Text bold>{set.title}</Text>
        {set.options.map((option, index) => {
          const colors = Object.entries(option.colors ?? {})
            .filter(([, value]) => isHex(value))
            .slice(0, 8)

          return (
            <Box key={`opt-${option.id}`} flexDirection="column" marginTop={1}>
              <Button
                key={`pick-${option.id}`}
                plain
                hotkey={String(index + 1)}
                label={option.name}
                onPress={() => void pickDesign($, set.id, option.id)}
              />
              {colors.length > 0 && (
                <Box flexDirection="row">
                  {colors.map(([name, value]) => (
                    <Text key={`sw-${option.id}-${name}`} backgroundColor={value}>
                      {'    '}
                    </Text>
                  ))}
                  <Text dimColor> {colors.map(([name]) => name).join(' ')}</Text>
                </Box>
              )}
              {option.fonts !== undefined && (
                <Text dimColor wrap="truncate-end">
                  {Object.entries(option.fonts)
                    .map(([role, font]) => `${role}: ${String(font)}`)
                    .join(' · ')}
                </Text>
              )}
              {option.description !== undefined && (
                <Text dimColor wrap="truncate-end">
                  {option.description}
                </Text>
              )}
            </Box>
          )
        })}
        <Box flexDirection="row" marginTop={1}>
          <Button key="open" plain hotkey="o" label="Open live cards in browser" onPress={() => void openExternal($, set.url)} />
        </Box>
        <Text dimColor>Press a number to send that option's tokens to Claude, or choose in the browser.</Text>
      </Box>
    )
  })

  // Drawer: theme picker, each theme drawn in its own colors.
  on('ui.render', { component: 'Pane', requestId: PANE.theme }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = themeOf(await read($, themeName))
    const room = Math.max(12, e.props.bodyColumns - 40)

    return (
      <Box flexDirection="column">
        <Text bold>Skin: {current.name}</Text>
        {THEMES.map((theme, index) => (
          <Button
            key={`theme-${theme.name}`}
            plain
            {...(index < 9 ? { hotkey: String(index + 1) } : {})}
            onPress={async () => {
              await $.ui.close({ id: PANE.theme }).catch(() => undefined)
              $.ui.toast(skinText('Skin: ', await setTheme($, cfg, theme.name)))
            }}
          >
            {theme.name === current.name ? '▸ ' : '  '}
            <Text color={theme.accent}>{theme.name.padEnd(8)}</Text>{' '}
            <Text color={theme.ok}>{themedBar(40, theme, 4)}</Text>
            <Text color={theme.warn}>{themedBar(70, theme, 3)}</Text>
            <Text color={theme.bad}>{themedBar(90, theme, 3)}</Text>{' '}
            <Text color={theme.agent}>{theme.icons.agent}</Text> <Text color={theme.idle}>{theme.icons.dot}</Text>{' '}
            <Text dimColor>{clip(theme.description, room)}</Text>
          </Button>
        ))}
        <Text dimColor>
          1-9 pick (remembered across sessions){cfg.syncClaudeTheme ? ", Claude Code's theme follows" : ''} · Esc close · /skin-nexus reset for the
          configured one
        </Text>
      </Box>
    )
  })

  // Providers: the profiles, the step-by-step form, a connection test.
  on('ui.render', { component: 'Pane', requestId: PANE.provider }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const Select = 'Select' in elements ? elements.Select : undefined
    const view = await read($, provider)
    const draft = view.draft

    if (draft !== null) {
      const label = STEP_LABEL[draft.step]
      const isModel = draft.step === 'opus' || draft.step === 'sonnet' || draft.step === 'haiku'

      return (
        <Box flexDirection="column">
          <Text bold>
            {draft.editing === null ? 'New profile' : `Edit ${draft.editing}`} · {DRAFT_STEPS.indexOf(draft.step) + 1}/{DRAFT_STEPS.length}
          </Text>
          {draft.error !== null && <Text color="red">{draft.error}</Text>}
          {draft.step === 'fallback' && Select !== undefined ? (
            <Select
              key="fallback"
              label={label}
              autoFocus
              options={[
                { value: 'no', label: 'No' },
                { value: 'yes', label: 'Yes' },
                { value: 'yes-default', label: 'Yes, and make it the default' },
              ]}
              value={draft.values.fallback ?? 'no'}
              onSelect={value => void submitDraftField($, value)}
            />
          ) : isModel && draft.models.length > 0 && Select !== undefined ? (
            <Select
              key={draft.step}
              label={label}
              autoFocus
              options={[{ value: '', label: '(empty)' }, ...draft.models.map(id => ({ value: id }))]}
              value={draft.values[draft.step] ?? ''}
              onSelect={value => void submitDraftField($, value)}
            />
          ) : Input !== undefined ? (
            <Input
              key={draft.step}
              label={label}
              autoFocus
              value={draft.step === 'apiKey' ? '' : (draft.values[draft.step] ?? '')}
              placeholder={draft.step === 'apiKey' && draft.values.apiKeyMask ? `keep ${draft.values.apiKeyMask}: press Enter` : ''}
              onSubmit={value => void submitDraftField($, value)}
            />
          ) : (
            <Text dimColor>This surface has no text field; add profiles from the terminal.</Text>
          )}
          <Button key="cancel" plain hotkey="x" label="Cancel" onPress={() => void closeDraft($)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>
          {view.linked
            ? `Route: ${view.route === 'claude' ? 'Claude (subscription)' : hubBadge(view.route, view.model)}`
            : 'Plain claude session (on Claude). Use copies a command that resumes this conversation under claude-nexus, on that profile.'}
        </Text>
        {view.linked && view.route !== 'claude' && <Button key="claude" plain hotkey="0" label="Use Claude" onPress={async () => $.ui.toast(await useRoute($, 'claude'))} />}
        {view.profiles.length === 0 && <Text dimColor>No profiles yet.</Text>}
        {view.profiles.map((one, index) => (
          <Box key={`p-${one.name}`} flexDirection="column">
            <Text>
              {one.name === view.route ? '● ' : '  '}
              <Text bold>{one.name}</Text> · {one.model} · {one.key} · {one.contextWindow} tok
              {one.fallback ? (one.isDefault ? ' · fallback (default)' : ' · fallback') : ''}
            </Text>
            <Box flexDirection="row" columnGap={2}>
              <Button
                key={`use-${one.name}`}
                plain
                {...(index < 9 ? { hotkey: String(index + 1) } : {})}
                label="Use"
                onPress={async press => $.ui.toast(await useRoute($, one.name, { surface: press.surface }), { timeoutMs: 12_000 })}
              />
              <Button key={`test-${one.name}`} plain label="Test" onPress={async () => void (await testProfile($, one.name))} />
              <Button key={`edit-${one.name}`} plain label="Edit" onPress={() => void startDraft($, one.name)} />
              <Button
                key={`del-${one.name}`}
                plain
                label="Delete"
                onPress={async () => {
                  const answer = await $.ui.ask(`Delete the profile ${one.name}?`, { header: 'Provider', options: ['Delete', 'Keep'] }).catch(() => 'Keep')
                  if (answer === 'Delete') await saveProfiles($, (await loadProfiles($)).filter(profile => profile.name !== one.name))
                }}
              />
            </Box>
            {view.tests[one.name] !== undefined && <Text dimColor>{view.tests[one.name]}</Text>}
          </Box>
        ))}
        <Button key="add" plain hotkey="a" label="Add profile" onPress={() => void startDraft($, null)} />
      </Box>
    )
  })

  // Drawer: command shield, high contrast.
  on('ui.render', { component: 'Pane', requestId: PANE.shield }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const alert = await read($, shieldAlert)
    if (alert === null) return <Text dimColor>No command is waiting.</Text>

    return (
      <Box flexDirection="column" borderStyle="double" borderColor="red" paddingX={1}>
        <Text backgroundColor="red" color="white" bold>
          {' ⛔ DANGEROUS COMMAND: answer in the dialog below '}
        </Text>
        {alert.reasons.map((reason, index) => (
          <Text key={`why-${index}`} color="red" bold>
            • it {reason}
          </Text>
        ))}
        <Text color="white" backgroundColor="#3b0a0a">
          {` ${alert.tool}> ${alert.command} `}
        </Text>
        <Text dimColor>"Block it" is the safe choice; Esc blocks too.</Text>
      </Box>
    )
  })

  // Progress: one animated line while tools run.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const [t, working] = await Promise.all([read($, turn), read($, busy)])
    const text = working ?? (t.tool === null ? null : `${t.tool}${t.detail ? ` · ${t.detail}` : ''}`)
    if (text === null) return next(e)

    return next({ ...e, props: { ...e.props, message: clip(`${text}  [step ${t.tools}]`, 72) } })
  })

  // Clutter suppression: routine tool rows become one dim line.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, isErrored, isInterrupted, isRunning, input } = e.props
    if (!cfg.quietTranscript || LOUD.has(tool) || isErrored || isInterrupted) return next(e)
    const { Text } = $.ui.resolve(e)

    return (
      <Text dimColor wrap="truncate-end">
        {isRunning ? '  … ' : '  ✓ '}
        {tool} {clip(describeInput(input), 100)}
      </Text>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!cfg.quietTranscript || LOUD.has(e.props.tool) || e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
}
