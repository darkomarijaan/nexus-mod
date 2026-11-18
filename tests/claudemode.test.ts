import { describe, expect, test } from 'claude-code/testing'

import { readConfig } from '../hooks/config'
import { DEFAULT_JEV, modeBadge, modePayload, modeRecentText, modeStatusText, parseModeArgs, readJevPick, readModePick, type ClaudeModeSnapshot } from '../hooks/claudemode'

describe('claude mode', () => {
  test('arguments', () => {
    expect(parseModeArgs('')).toEqual({ kind: 'status' })
    expect(parseModeArgs(' Opus ')).toEqual({ kind: 'set', mode: 'opus' })
    expect(parseModeArgs('auto')).toEqual({ kind: 'set', mode: 'auto' })
    expect(parseModeArgs('recent')).toEqual({ kind: 'recent' })
    expect(parseModeArgs('reset')).toEqual({ kind: 'reset' })
    expect(parseModeArgs('turbo').kind).toBe('error')
  })

  test('settings default to auto with configurable model ids', () => {
    const cfg = readConfig({})
    expect(cfg.autoModel).toBe('auto')
    expect(cfg.autoModels).toEqual({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' })
    const custom = readConfig({ autoModel: 'bogus', autoModelHaiku: ' my-haiku ', autoModelMaxEscalations: 9 })
    expect(custom.autoModel).toBe('auto')
    expect(custom.autoModels.haiku).toBe('my-haiku')
    expect(custom.autoModelMaxEscalations).toBe(2)
  })

  test('a stored pick beats the settings mode, and junk is no pick', () => {
    const cfg = readConfig({})
    const settings = { mode: cfg.autoModel, models: cfg.autoModels, maxEscalations: 2, prices: '' }
    expect(modePayload(settings, 'haiku').mode).toBe('haiku')
    expect(modePayload(settings, null).mode).toBe('auto')
    expect('prices' in modePayload(settings, null)).toBe(false)
    expect(readModePick('sonnet')).toBe('sonnet')
    expect(readModePick({})).toBeNull()
  })

  test('status and recent text', () => {
    const snap: ClaudeModeSnapshot = {
      mode: 'auto',
      models: { opus: 'o', sonnet: 's', haiku: 'h' },
      totals: { requests: 2, fallbacks: 1, escalations: 1, tokensIn: 10, tokensOut: 5, cost: 0.01, baseline: 0.02, byTier: { opus: 0, sonnet: 1, haiku: 1 } },
      recent: [{ mode: 'auto', level: 'LIGHT', model: 'h', status: 200, ms: 40, cost: 0.001, reasons: ['short'], escalation: null, fallbacks: [{ model: 'x', status: 404 }] }],
    }
    expect(modeStatusText(snap)).toContain('escalations 1, fallbacks 1')
    expect(modeRecentText(snap)).toContain('LIGHT → h [short] 200 40ms')
    expect(modeRecentText({ ...snap, recent: [] })).toBe('No routed requests yet.')
    const [first] = snap.recent
    if (first === undefined) throw new Error('fixture')
    const shaped = { ...first, incoming: 'claude-haiku-5-5', shape: { messages: 3, tools: 2, maxTokens: 64, last: 'user/tool_result', stream: true, system: true } }
    expect(modeRecentText({ ...snap, recent: [shaped] })).toContain('↳ asked claude-haiku-5-5 · 3 msgs · 2 tools · max 64 · last user/tool_result')
    expect(modeRecentText(snap)).not.toContain('↳')
  })

  test('the HUD badge: auto names the last tier, manual the pick, off and no router none', () => {
    const snap: ClaudeModeSnapshot = {
      mode: 'auto',
      models: { opus: 'o', sonnet: 's', haiku: 'h' },
      totals: { requests: 1, fallbacks: 0, escalations: 0, tokensIn: 0, tokensOut: 0, cost: 0, baseline: 0, byTier: {} },
      recent: [],
    }
    const entry = { mode: 'auto', level: null, status: 200, ms: 1, cost: null, reasons: [], escalation: null, fallbacks: [] }
    expect(modeBadge(snap)).toBe('mode auto')
    expect(modeBadge({ ...snap, recent: [{ ...entry, model: 's' }] })).toBe('mode auto·sonnet')
    expect(modeBadge({ ...snap, recent: [{ ...entry, model: 'unknown-id' }] })).toBe('mode auto')
    expect(modeBadge({ ...snap, mode: 'opus' })).toBe('mode opus')
    expect(modeBadge({ ...snap, mode: 'off' })).toBeNull()
    expect(modeBadge(null)).toBeNull()
  })
})

describe('auto model with the optional Jev classifier', () => {
  const snapshot = (jev: ClaudeModeSnapshot['jev']): ClaudeModeSnapshot => ({
    mode: 'auto',
    models: { opus: 'o', sonnet: 's', haiku: 'h' },
    totals: { requests: 0, fallbacks: 0, escalations: 0, tokensIn: 0, tokensOut: 0, cost: 0, baseline: 0, byTier: {} },
    recent: [],
    ...(jev === undefined ? {} : { jev }),
  })
  const live = { mode: 'gray', model: 'typesafe/jev-1.14.0', keyEnv: 'CMD_API_KEY', keyPresent: true, paused: false, authFailed: false, calls: 4, used: 3, lowConf: 1, timeouts: 0, errors: 0, skipped: 0, tokensIn: 1500, tokensOut: 160 }

  test('it is off by default, and a plain setup sends the router nothing about it that matters', () => {
    const cfg = readConfig({})
    expect(cfg.autoJev).toEqual(DEFAULT_JEV)
    expect(cfg.autoJev.mode).toBe('off')
  })

  test('settings are read, and a bad one falls back so the router never refuses the rest', () => {
    const on = readConfig({ autoModelJev: 'GRAY', autoModelJevTimeoutMs: 900, autoModelJevMinConfidence: 0.7, autoModelJevModel: 'typesafe/jev-9' })
    expect(on.autoJev).toMatchObject({ mode: 'gray', timeoutMs: 900, minConfidence: 0.7, model: 'typesafe/jev-9' })
    const bad = readConfig({ autoModelJev: 'maybe', autoModelJevUrl: 'http://example.com/x', autoModelJevKeyEnv: 'a b', autoModelJevModel: 'bad id; drop', autoModelJevTimeoutMs: 10, autoModelJevMinConfidence: 5 })
    expect(bad.autoJev).toEqual({ ...DEFAULT_JEV, timeoutMs: 200 })
    expect(readConfig({ autoModelJevTimeoutMs: 99999 }).autoJev.timeoutMs).toBe(5000)
    expect(readConfig({ autoModelJevUrl: 'https://user:pw@example.com/x' }).autoJev.url).toBe(DEFAULT_JEV.url)
  })

  test('the payload carries the Jev settings when given, and none for an older caller', () => {
    const base = { mode: 'auto' as const, models: { opus: 'o', sonnet: 's', haiku: 'h' }, maxEscalations: 2, prices: '' }
    expect(modePayload({ ...base, jev: DEFAULT_JEV }, null)).toMatchObject({ jev: DEFAULT_JEV })
    expect('jev' in modePayload(base, null)).toBe(false)
  })

  test('with Jev off the status says nothing about it', () => {
    expect(modeStatusText(snapshot({ ...live, mode: 'off' }))).not.toContain('Jev')
    expect(modeStatusText(snapshot(undefined))).not.toContain('Jev')
  })

  test('with Jev on the status says what is happening, and why when it cannot help', () => {
    expect(modeStatusText(snapshot(live))).toContain('Jev: typesafe/jev-1.14.0, gray zone only; asked 4, used 3, low confidence 1')
    expect(modeStatusText(snapshot({ ...live, keyPresent: false }))).toContain('Jev: on, but no key in CMD_API_KEY; using the rules')
    expect(modeStatusText(snapshot({ ...live, authFailed: true }))).toContain('the key was rejected')
    expect(modeStatusText(snapshot({ ...live, paused: true }))).toContain('paused after repeated failures')
  })

  test('only a Jev key variable can be named, and a refused setting is said out loud', () => {
    expect(readConfig({ autoModelJevKeyEnv: 'ANTHROPIC_API_KEY' }).autoJev.keyEnv).toBe(DEFAULT_JEV.keyEnv)
    expect(readConfig({ autoModelJevKeyEnv: 'GITHUB_TOKEN' }).autoJev.keyEnv).toBe(DEFAULT_JEV.keyEnv)
    expect(readConfig({ autoModelJevKeyEnv: 'NEXUS_JEV_WORK_KEY' }).autoJev.keyEnv).toBe('NEXUS_JEV_WORK_KEY')
    expect(readConfig({ autoModelJevKeyEnv: 'TYPESAFE_API_KEY' }).autoJev.keyEnv).toBe('TYPESAFE_API_KEY')
    expect(modeStatusText(snapshot({ ...live, mode: 'off', problem: 'jev url must be an https address on an allowed host' }))).toContain('Jev: a setting was refused (jev url must be an https address on an allowed host)')
    expect(modeStatusText(snapshot({ ...live, problem: null }))).not.toContain('refused')
  })

  test('/automodel-nexus jev: gray, off and reset, with the mode words left as they were', () => {
    expect(parseModeArgs('jev gray')).toEqual({ kind: 'jev', value: 'gray' })
    expect(parseModeArgs('  JEV   On ')).toEqual({ kind: 'jev', value: 'gray' })
    expect(parseModeArgs('jev off')).toEqual({ kind: 'jev', value: 'off' })
    expect(parseModeArgs('jev reset')).toEqual({ kind: 'jev', value: 'reset' })
    expect(parseModeArgs('jev')).toEqual({ kind: 'status' })
    expect(parseModeArgs('jev status')).toEqual({ kind: 'status' })
    expect(parseModeArgs('jev maybe').kind).toBe('error')
    expect(parseModeArgs('off')).toEqual({ kind: 'set', mode: 'off' })
    expect(parseModeArgs('reset')).toEqual({ kind: 'reset' })
  })

  test('a stored Jev pick beats the setting, and junk is no pick', () => {
    expect(readJevPick('gray')).toBe('gray')
    expect(readJevPick('off')).toBe('off')
    expect(readJevPick('auto')).toBeNull()
    expect(readJevPick({})).toBeNull()
    const base = { mode: 'auto' as const, models: { opus: 'o', sonnet: 's', haiku: 'h' }, maxEscalations: 2, prices: '' }
    const on = { ...DEFAULT_JEV, mode: 'gray' as const }
    expect(modePayload({ ...base, jev: DEFAULT_JEV }, null, 'gray')).toMatchObject({ jev: { mode: 'gray', url: DEFAULT_JEV.url } })
    expect(modePayload({ ...base, jev: on }, null, 'off')).toMatchObject({ jev: { mode: 'off' } })
    expect(modePayload({ ...base, jev: on }, null, null)).toMatchObject({ jev: { mode: 'gray' } })
    expect(modePayload({ ...base, jev: on }, null)).toMatchObject({ jev: { mode: 'gray' } })
    expect('jev' in modePayload(base, null, 'gray')).toBe(false)
  })

  test('always: parsed, picked, set and shown as every turn', () => {
    expect(parseModeArgs('jev always')).toEqual({ kind: 'jev', value: 'always' })
    expect(readJevPick('always')).toBe('always')
    expect(readConfig({ autoModelJev: 'ALWAYS' }).autoJev.mode).toBe('always')
    expect(readConfig({ autoModelJev: 'sometimes' }).autoJev.mode).toBe('off')
    const base = { mode: 'auto' as const, models: { opus: 'o', sonnet: 's', haiku: 'h' }, maxEscalations: 2, prices: '' }
    expect(modePayload({ ...base, jev: DEFAULT_JEV }, null, 'always')).toMatchObject({ jev: { mode: 'always' } })
    const live = { mode: 'always', model: 'typesafe/jev-1.14.0', keyEnv: 'CMD_API_KEY', keyPresent: true, paused: false, authFailed: false, calls: 9, used: 8, lowConf: 1, timeouts: 0, errors: 0, skipped: 0, tokensIn: 3000, tokensOut: 300 }
    const text = modeStatusText({ mode: 'auto', models: { opus: 'o', sonnet: 's', haiku: 'h' }, totals: { requests: 0, fallbacks: 0, escalations: 0, tokensIn: 0, tokensOut: 0, cost: 0, baseline: 0, byTier: {} }, recent: [], jev: live })
    expect(text).toContain('Jev: typesafe/jev-1.14.0, every turn; asked 9, used 8')
    expect(text).not.toContain('gray zone only')  })
})
