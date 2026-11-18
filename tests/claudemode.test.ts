import { describe, expect, test } from 'claude-code/testing'

import { readConfig } from '../hooks/config'
import { modeBadge, modePayload, modeRecentText, modeStatusText, parseModeArgs, readModePick, type ClaudeModeSnapshot } from '../hooks/claudemode'

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
