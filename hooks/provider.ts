/*
 * Provider router, the Nexus side: profiles (a hub's URL, key and models),
 * their checks, and the words the pane, the HUD and the commands use. Pure;
 * register.tsx talks to the router and the store.
 */

export type ProviderModels = { opus?: string; sonnet?: string; haiku?: string }

export type ProviderProfile = {
  name: string
  hubUrl: string
  apiKey: string
  models: ProviderModels
  contextWindow: number
  fallback: boolean
  isDefault: boolean
}

export type ProfileDraft = {
  name?: string
  hubUrl?: string
  apiKey?: string
  models?: ProviderModels
  contextWindow?: string | number
  fallback?: boolean
  isDefault?: boolean
}

export const DEFAULT_WINDOW = 200_000
const TIERS = ['opus', 'sonnet', 'haiku'] as const
const NAME = /^[a-z0-9-]{1,32}$/

export function normalizeHubUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** A stored or typed value as text; anything that is not a string counts as missing. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanModels(models: ProviderModels | undefined): ProviderModels {
  const out: ProviderModels = {}
  for (const tier of TIERS) {
    const value = text(models?.[tier])
    if (value !== '') out[tier] = value
  }

  return out
}

export function primaryModel(models: ProviderModels): string | undefined {
  return TIERS.map(tier => models[tier]).find((one): one is string => typeof one === 'string' && one !== '')
}

export function validateProfile(
  draft: ProfileDraft,
  others: readonly ProviderProfile[],
): { profile: ProviderProfile; errors: null } | { profile: null; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const name = text(draft.name).toLowerCase()
  if (name === 'claude') errors.name = 'claude is the subscription route; pick another name'
  else if (!NAME.test(name)) errors.name = 'use 1-32 lowercase letters, digits or dashes'
  else if (others.some(one => one.name === name)) errors.name = `a profile named ${name} already exists`
  const hubUrl = normalizeHubUrl(text(draft.hubUrl))
  if (!/^https?:\/\/[^\s/]+/.test(hubUrl)) errors.hubUrl = 'an http(s) URL, such as https://hub.example.com/v1'
  const apiKey = text(draft.apiKey)
  if (apiKey === '') errors.apiKey = 'the hub needs a key'
  const models = cleanModels(draft.models)
  if (primaryModel(models) === undefined) errors.models = 'fill at least one of the opus, sonnet or haiku models'
  const rawWindow = draft.contextWindow === undefined || draft.contextWindow === '' ? DEFAULT_WINDOW : Number(draft.contextWindow)
  if (!Number.isInteger(rawWindow) || rawWindow < 8000) errors.contextWindow = 'a whole number of tokens, 8000 or more'
  if (Object.keys(errors).length > 0) return { profile: null, errors }

  return {
    profile: { name, hubUrl, apiKey, models, contextWindow: rawWindow, fallback: draft.fallback === true, isDefault: draft.isDefault === true },
    errors: null,
  }
}

/** The profiles a store holds: broken entries and repeated names left out, the first of a name kept. */
export function readProfiles(stored: unknown): ProviderProfile[] {
  if (!Array.isArray(stored)) return []
  const kept: ProviderProfile[] = []
  for (const one of stored) {
    if (one === null || typeof one !== 'object') continue
    const result = validateProfile(one as ProfileDraft, kept)
    if (result.profile !== null) kept.push(result.profile)
  }

  return kept
}

export function maskKey(key: string): string {
  const one = key.trim()

  return one.length < 12 ? '••••' : `${one.slice(0, 4)}…${one.slice(-4)}`
}

/** The router this session runs behind: a loopback ANTHROPIC_BASE_URL and its control token, or none. */
export function routerLinkFrom(baseUrl: string | undefined, controlToken: string | undefined): { url: string; token: string } | null {
  if (baseUrl === undefined || controlToken === undefined || controlToken.length < 32) return null
  const match = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\/?$/.exec(baseUrl.trim())

  return match === null ? null : { url: `http://127.0.0.1:${match[2]}`, token: controlToken }
}

export function fallbackChoices(profiles: readonly ProviderProfile[]): ProviderProfile[] {
  return profiles.filter(one => one.fallback).sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

export function needsCompaction(tokens: number | null, window: number, share: number): boolean {
  return tokens !== null && tokens >= window * share
}

export function hubBadge(route: string, model: string | null): string {
  return model === null ? `⇄ ${route}` : `⇄ ${route} · ${model}`
}

export type DraftStep = 'name' | 'hubUrl' | 'apiKey' | 'opus' | 'sonnet' | 'haiku' | 'contextWindow' | 'fallback'

export const DRAFT_STEPS: readonly DraftStep[] = ['name', 'hubUrl', 'apiKey', 'opus', 'sonnet', 'haiku', 'contextWindow', 'fallback']

export function nextStep(step: DraftStep): DraftStep | null {
  return DRAFT_STEPS[DRAFT_STEPS.indexOf(step) + 1] ?? null
}

/** The pane's answers as a profile draft; fallback answers: no, yes, yes-default. */
export function draftToProfile(values: Record<string, string>): ProfileDraft {
  return {
    name: values.name,
    hubUrl: values.hubUrl,
    apiKey: values.apiKey,
    models: { opus: values.opus, sonnet: values.sonnet, haiku: values.haiku },
    contextWindow: values.contextWindow,
    fallback: values.fallback === 'yes' || values.fallback === 'yes-default',
    isDefault: values.fallback === 'yes-default',
  }
}

export function parseProviderArgs(
  args: string,
):
  | { verb: 'pane' }
  | { verb: 'status' }
  | { verb: 'use'; name: string }
  | { verb: 'test'; name: string }
  | { verb: 'error'; message: string } {
  const [verb = '', name = ''] = args.trim().toLowerCase().split(/\s+/)
  if (verb === '') return { verb: 'pane' }
  if (verb === 'status') return { verb: 'status' }
  if (verb === 'use') return name === '' ? { verb: 'error', message: 'Name a profile: /provider-nexus use <name> (or claude).' } : { verb: 'use', name }

  if (verb === 'test') return name === '' ? { verb: 'error', message: 'Name a profile: /provider-nexus test <name>.' } : { verb: 'test', name }
  // `/provider-nexus myhub` is `use myhub`.
  if (name === '') return { verb: 'use', name: verb }

  return { verb: 'error', message: 'Use /provider-nexus, /provider-nexus <name|claude>, /provider-nexus status or /provider-nexus test <name>.' }
}

/** What resumes this conversation under the launcher, from the project folder. `;` on Windows: PowerShell 5.1 has no `&&`. */
export function restartCommand(cwd: string, sessionId: string, isWindows: boolean): string {
  return `cd "${cwd}"${isWindows ? ';' : ' &&'} claude-nexus --resume ${sessionId}`
}

/** A switch asked for in a plain session, carried out once the same project starts again under claude-nexus. */
export type PendingRoute = { name: string; cwd: string; at: number }

/** How long a copied restart command stays good for. */
export const PENDING_ROUTE_MS = 15 * 60_000

const sameFolder = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The profile to switch to at start, or null: anything malformed, stale or from another folder is ignored. */
export function pendingRouteFor(raw: unknown, cwd: string, now: number): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { name, cwd: from, at } = raw as Record<string, unknown>
  if (typeof name !== 'string' || name === '' || typeof from !== 'string' || typeof at !== 'number') return null
  if (now - at < 0 || now - at > PENDING_ROUTE_MS || !sameFolder(from, cwd)) return null

  return name
}

/** One key flips between Claude and a hub: on a hub, back to Claude; on Claude, the hub used last, else the default fallback, else the first fallback, else the first profile. */
export function toggleTarget(route: string, lastHub: string | null, profiles: { name: string; fallback: boolean; isDefault: boolean }[]): string | null {
  if (route !== 'claude') return 'claude'
  if (lastHub !== null && profiles.some(one => one.name === lastHub)) return lastHub

  return (profiles.find(one => one.isDefault) ?? profiles.find(one => one.fallback) ?? profiles[0])?.name ?? null
}
