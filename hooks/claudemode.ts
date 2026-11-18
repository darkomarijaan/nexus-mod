/*
 * Claude Mode, the hook side: the /automodel-nexus arguments, the settings the
 * router is given, and the status text. The routing itself lives in the bridge
 * (bridge/claude-mode.mjs), the only place that sees a request's body.
 */

export type ClaudeModeName = 'auto' | 'off' | 'opus' | 'sonnet' | 'haiku'

export const CLAUDE_MODES: readonly ClaudeModeName[] = ['auto', 'off', 'opus', 'sonnet', 'haiku']

export const isClaudeMode = (value: unknown): value is ClaudeModeName => typeof value === 'string' && (CLAUDE_MODES as readonly string[]).includes(value)

/** The person's stored pick; anything but a known mode is no pick. */
export const readModePick = (stored: unknown): ClaudeModeName | null => (isClaudeMode(stored) ? stored : null)

export type ClaudeModeCommand = { kind: 'status' } | { kind: 'recent' } | { kind: 'set'; mode: ClaudeModeName } | { kind: 'reset' } | { kind: 'error'; message: string }

export function parseModeArgs(args: string): ClaudeModeCommand {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'status') return { kind: 'status' }
  if (word === 'recent' || word === 'log') return { kind: 'recent' }
  if (word === 'reset') return { kind: 'reset' }
  if (isClaudeMode(word)) return { kind: 'set', mode: word }

  return { kind: 'error', message: `Unknown argument "${args.trim().slice(0, 40)}". Use: auto | opus | sonnet | haiku | off | recent | reset` }
}

export type ClaudeModeSettings = {
  mode: ClaudeModeName
  models: { opus: string; sonnet: string; haiku: string }
  maxEscalations: number
  prices: string
}

/** What the router is given: the person's pick beats the settings' mode. */
export function modePayload(settings: ClaudeModeSettings, pick: ClaudeModeName | null) {
  return {
    mode: pick ?? settings.mode,
    models: settings.models,
    maxEscalations: Math.min(2, Math.max(0, Math.floor(settings.maxEscalations))),
    ...(settings.prices.trim() === '' ? {} : { prices: settings.prices.trim() }),
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
}
export type ClaudeModeSnapshot = {
  mode: string
  models: Record<string, string>
  totals: { requests: number; fallbacks: number; escalations: number; tokensIn: number; tokensOut: number; cost: number; baseline: number; byTier: Record<string, number> }
  recent: Entry[]
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
    `Claude Mode: ${snap.mode} (${how})`,
    `  opus ${snap.models.opus} · sonnet ${snap.models.sonnet} · haiku ${snap.models.haiku}`,
    `  requests ${totals.requests}: opus ${totals.byTier.opus ?? 0}, sonnet ${totals.byTier.sonnet ?? 0}, haiku ${totals.byTier.haiku ?? 0}; escalations ${totals.escalations}, fallbacks ${totals.fallbacks}`,
  ]
  if (totals.tokensIn + totals.tokensOut > 0) {
    lines.push(`  tokens in ${totals.tokensIn} out ${totals.tokensOut}; est. cost ${usd(totals.cost)} (${usd(totals.baseline)} on the session's own model)`)
  }
  lines.push('  /automodel-nexus auto | opus | sonnet | haiku | off | recent | reset')

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

      return `${one.level ?? one.mode} → ${one.model} [${one.reasons.join(',')}] ${one.status} ${one.ms}ms${extra.length > 0 ? ` · ${extra.join(' · ')}` : ''}`
    })
    .join('\n')
}
