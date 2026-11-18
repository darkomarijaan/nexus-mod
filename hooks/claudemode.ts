/*
 * Auto Model, the hook side: the /automodel-nexus arguments, the settings the
 * router is given, and the status text. The routing itself lives in the bridge
 * (bridge/claude-mode.mjs), the only place that sees a request's body.
 */

export type ClaudeModeName = 'auto' | 'off' | 'opus' | 'sonnet' | 'haiku'

export const CLAUDE_MODES: readonly ClaudeModeName[] = ['auto', 'off', 'opus', 'sonnet', 'haiku']

export const isClaudeMode = (value: unknown): value is ClaudeModeName => typeof value === 'string' && (CLAUDE_MODES as readonly string[]).includes(value)

/** The person's stored pick; anything but a known mode is no pick. */
export const readModePick = (stored: unknown): ClaudeModeName | null => (isClaudeMode(stored) ? stored : null)

/** The optional Jev classifier. Off unless the person turns it on; the key is never a setting, only the name of its variable. */
export type JevSettings = { mode: 'off' | 'gray' | 'always'; url: string; keyEnv: string; model: string; timeoutMs: number; minConfidence: number }

export const DEFAULT_JEV: JevSettings = {
  mode: 'off',
  url: 'https://api.commandcode.ai/provider/v1/systemone',
  keyEnv: 'CMD_API_KEY',
  model: 'typesafe/jev-1.14.0',
  timeoutMs: 1500,
  minConfidence: 0.5,
}

// The router refuses a bad Jev value (and says why in the status), so a bad setting is cleaned here before it is sent.
const JEV_URL = /^(?:https:\/\/[^\s/@?#]+|http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?)(?:[/?#]\S*)?$/
// The variables a Jev key may live in: the same list as the router's, so no other variable of the environment can ever be asked for.
const JEV_KEY_NAMES = ['CMD_API_KEY', 'TYPESAFE_API_KEY', 'JEV_API_KEY']
const JEV_KEY_ENV = { test: (name: string) => JEV_KEY_NAMES.includes(name) || /^NEXUS_JEV_[A-Z0-9_]{1,50}$/.test(name) }
const JEV_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/

export function readJev(raw: { mode?: unknown; url?: unknown; keyEnv?: unknown; model?: unknown; timeoutMs?: unknown; minConfidence?: unknown }): JevSettings {
  const word = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  const jevMode = word(raw.mode, 'off').toLowerCase()
  const url = word(raw.url, DEFAULT_JEV.url)
  const keyEnv = word(raw.keyEnv, DEFAULT_JEV.keyEnv)
  const model = word(raw.model, DEFAULT_JEV.model)
  const timeout = typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) ? Math.floor(raw.timeoutMs) : DEFAULT_JEV.timeoutMs
  const confidence = typeof raw.minConfidence === 'number' && raw.minConfidence >= 0 && raw.minConfidence <= 1 ? raw.minConfidence : DEFAULT_JEV.minConfidence

  return {
    mode: jevMode === 'gray' || jevMode === 'always' ? jevMode : 'off',
    url: JEV_URL.test(url) ? url : DEFAULT_JEV.url,
    keyEnv: JEV_KEY_ENV.test(keyEnv) ? keyEnv : DEFAULT_JEV.keyEnv,
    model: JEV_MODEL.test(model) ? model : DEFAULT_JEV.model,
    timeoutMs: Math.min(5000, Math.max(200, timeout)),
    minConfidence: confidence,
  }
}

/** The person's stored Jev pick (`/automodel-nexus jev gray|off`); anything else is no pick and the setting decides. */
export const readJevPick = (stored: unknown): 'gray' | 'always' | 'off' | null => (stored === 'gray' || stored === 'always' || stored === 'off' ? stored : null)

export type ClaudeModeCommand =
  | { kind: 'status' }
  | { kind: 'recent' }
  | { kind: 'set'; mode: ClaudeModeName }
  | { kind: 'reset' }
  | { kind: 'jev'; value: 'gray' | 'always' | 'off' | 'reset' }
  | { kind: 'error'; message: string }

export function parseModeArgs(args: string): ClaudeModeCommand {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'status') return { kind: 'status' }
  if (word === 'recent' || word === 'log') return { kind: 'recent' }
  if (word === 'reset') return { kind: 'reset' }
  const [first, second] = word.split(/\s+/)
  if (first === 'jev') {
    if (second === undefined || second === 'status') return { kind: 'status' }
    if (second === 'gray' || second === 'on') return { kind: 'jev', value: 'gray' }
    if (second === 'always') return { kind: 'jev', value: 'always' }
    if (second === 'off' || second === 'reset') return { kind: 'jev', value: second }

    return { kind: 'error', message: `Unknown Jev argument "${second.slice(0, 20)}". Use: jev gray | jev always | jev off | jev reset` }
  }
  if (isClaudeMode(word)) return { kind: 'set', mode: word }

  return { kind: 'error', message: `Unknown argument "${args.trim().slice(0, 40)}". Use: auto | opus | sonnet | haiku | off | recent | reset | jev gray|always|off|reset` }
}

export type ClaudeModeSettings = {
  mode: ClaudeModeName
  models: { opus: string; sonnet: string; haiku: string }
  maxEscalations: number
  prices: string
  /** Left out, the router keeps whatever Jev settings it has (an older caller). */
  jev?: JevSettings
}

/** What the router is given: the person's pick beats the settings' mode. */
export function modePayload(settings: ClaudeModeSettings, pick: ClaudeModeName | null, jevPick: 'gray' | 'always' | 'off' | null = null) {
  return {
    mode: pick ?? settings.mode,
    models: settings.models,
    maxEscalations: Math.min(2, Math.max(0, Math.floor(settings.maxEscalations))),
    ...(settings.prices.trim() === '' ? {} : { prices: settings.prices.trim() }),
    // The person's pick (`/automodel-nexus jev`) beats the setting, as the mode pick does.
    ...(settings.jev === undefined ? {} : { jev: { ...settings.jev, mode: jevPick ?? settings.jev.mode } }),
  }
}

type Entry = {
  mode: string
  level: string | null
  model: string
  status: number
  ms: number
  cost: number | null
  reasons: string[]
  escalation: { from: string; to: string; why: string } | null
  fallbacks: { model: string | null; status: number }[]
  /** The model Claude Code asked for. Missing in entries from an older router. */
  incoming?: string
  /** Counts and kinds of the request, never text. Missing in entries from an older router. */
  shape?: { messages: number; tools: number; maxTokens: number | null; last: string | null; stream: boolean; system: boolean }
}
export type ClaudeModeSnapshot = {
  mode: string
  models: Record<string, string>
  totals: { requests: number; fallbacks: number; escalations: number; tokensIn: number; tokensOut: number; cost: number; baseline: number; byTier: Record<string, number> }
  recent: Entry[]
  /** Missing from an older router. */
  jev?: {
    mode: string
    model: string
    keyEnv: string
    keyPresent: boolean
    /** Why the router refused the last Jev settings it was given; null when it took them. */
    problem?: string | null
    paused: boolean
    authFailed: boolean
    calls: number
    used: number
    lowConf: number
    timeouts: number
    errors: number
    skipped: number
    tokensIn: number
    tokensOut: number
  }
}

/** The tier a model id belongs to under the snapshot's model ids; null when it matches none. */
const tierOf = (snap: ClaudeModeSnapshot, model: string): string | null => Object.keys(snap.models).find(tier => snap.models[tier] === model) ?? null

/**
 * The HUD badge: `mode auto·sonnet` (auto, with the tier the last request went to), `mode opus`
 * (manual), or null when routing is off or the router gave no snapshot.
 */
export function modeBadge(snap: ClaudeModeSnapshot | null): string | null {
  if (snap === null || snap.mode === 'off') return null
  if (snap.mode !== 'auto') return `mode ${snap.mode}`
  const last = snap.recent.at(-1)
  const tier = last === undefined ? null : tierOf(snap, last.model)

  return tier === null ? 'mode auto' : `mode auto·${tier}`
}

const usd = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`

export function modeStatusText(snap: ClaudeModeSnapshot): string {
  const { totals } = snap
  const how = snap.mode === 'auto' ? 'router picks the model' : snap.mode === 'off' ? 'requests go as Claude Code sent them' : 'manual: always this model'
  const lines = [
    `Auto Model: ${snap.mode} (${how})`,
    `  opus ${snap.models.opus} · sonnet ${snap.models.sonnet} · haiku ${snap.models.haiku}`,
    `  requests ${totals.requests}: opus ${totals.byTier.opus ?? 0}, sonnet ${totals.byTier.sonnet ?? 0}, haiku ${totals.byTier.haiku ?? 0}; escalations ${totals.escalations}, fallbacks ${totals.fallbacks}`,
  ]
  if (totals.tokensIn + totals.tokensOut > 0) {
    lines.push(`  tokens in ${totals.tokensIn} out ${totals.tokensOut}; est. cost ${usd(totals.cost)} (${usd(totals.baseline)} on the session's own model)`)
  }
  const { jev } = snap
  // With Jev off (the default) there is nothing to say about it, unless the router refused a setting.
  if (jev !== undefined && typeof jev.problem === 'string') lines.push(`  Jev: a setting was refused (${jev.problem}); the last good one stays`)
  if (jev !== undefined && (jev.mode === 'gray' || jev.mode === 'always')) {
    if (jev.authFailed) lines.push('  Jev: the key was rejected, using the rules (/automodel-nexus reset tries again)')
    else if (!jev.keyPresent) lines.push(`  Jev: on, but no key in ${jev.keyEnv}; using the rules (run \`claude-nexus jev-key\` in a terminal to add it)`)
    else if (jev.paused) lines.push('  Jev: paused after repeated failures; using the rules for a few minutes')
    else lines.push(`  Jev: ${jev.model}, ${jev.mode === 'always' ? 'every turn' : 'gray zone only'}; asked ${jev.calls}, used ${jev.used}, low confidence ${jev.lowConf}, timeouts ${jev.timeouts}, errors ${jev.errors}, skipped ${jev.skipped}; tokens in ${jev.tokensIn} out ${jev.tokensOut}`)
  }
  lines.push('  /automodel-nexus auto | opus | sonnet | haiku | off | recent | reset | jev gray|always|off|reset')

  return lines.join('\n')
}

export function modeRecentText(snap: ClaudeModeSnapshot): string {
  if (snap.recent.length === 0) return 'No routed requests yet.'

  return snap.recent
    .slice(-10)
    .map(one => {
      const extra = [
        one.escalation === null ? '' : `escalated ${one.escalation.from}→${one.escalation.to} (${one.escalation.why})`,
        one.fallbacks.length === 0 ? '' : `fallback after ${one.fallbacks.map(f => f.status).join(',')}`,
        one.cost === null ? '' : usd(one.cost),
      ].filter(Boolean)

      const head = `${one.level ?? one.mode} → ${one.model} [${one.reasons.join(',')}] ${one.status} ${one.ms}ms${extra.length > 0 ? ` · ${extra.join(' · ')}` : ''}`
      const { shape } = one
      const asked = one.incoming === undefined ? [] : [`asked ${one.incoming}`]
      const form = shape === undefined ? [] : [`${shape.messages} msgs`, `${shape.tools} tools`, `max ${shape.maxTokens ?? '-'}`, `last ${shape.last ?? '-'}`]
      const detail = [...asked, ...form]

      return detail.length === 0 ? head : `${head}\n    ↳ ${detail.join(' · ')}`
    })
    .join('\n')
}
