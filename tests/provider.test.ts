import { describe, expect, test } from 'claude-code/testing'

import {
  fallbackChoices,
  hubBadge,
  maskKey,
  needsCompaction,
  parseProviderArgs,
  primaryModel,
  readProfiles,
  routerLinkFrom,
  validateProfile,
  type ProviderProfile,
} from '../hooks/provider'

const MYHUB: ProviderProfile = {
  name: 'myhub',
  hubUrl: 'https://hub.example.com/v1',
  apiKey: 'sk-abcdefghijklmnop',
  models: { opus: 'antigravity/gemini-3.8-flash-tiered' },
  contextWindow: 1_000_000,
  fallback: true,
  isDefault: true,
}

describe('provider profiles', () => {
  test('a good draft becomes a profile with the URL tidied and the window defaulted', () => {
    const result = validateProfile({ name: 'omni', hubUrl: ' https://omni.example/v1/ ', apiKey: ' k-123456789 ', models: { haiku: 'deepseek' } }, [MYHUB])
    expect(result.errors).toBeNull()
    expect(result.profile).toEqual({
      name: 'omni',
      hubUrl: 'https://omni.example/v1',
      apiKey: 'k-123456789',
      models: { haiku: 'deepseek' },
      contextWindow: 200_000,
      fallback: false,
      isDefault: false,
    })
  })

  test('every broken field is named', () => {
    const result = validateProfile({ name: 'Claude', hubUrl: 'ftp://x', apiKey: '', models: {}, contextWindow: '100' }, [])
    expect(result.profile).toBeNull()
    expect(Object.keys(result.errors ?? {}).sort()).toEqual(['apiKey', 'contextWindow', 'hubUrl', 'models', 'name'])
    expect(validateProfile({ ...MYHUB, name: 'claude' }, []).errors?.name).toContain('claude')
    expect(validateProfile({ ...MYHUB }, [MYHUB]).errors?.name).toContain('already')
  })

  test('keys show only their ends', () => {
    expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-a…mnop')
    expect(maskKey('short')).toBe('••••')
  })

  test('the stored list keeps only valid profiles', () => {
    expect(readProfiles([MYHUB, { name: 'broken' }, 'x'])).toEqual([MYHUB])
    expect(readProfiles(null)).toEqual([])
  })

  test('the primary model is opus, then sonnet, then haiku', () => {
    expect(primaryModel({ haiku: 'h', sonnet: 's' })).toBe('s')
    expect(primaryModel({})).toBeUndefined()
  })
})

describe('router link and commands', () => {
  test('only a loopback base URL and a long token make a link', () => {
    const token = 'c'.repeat(64)
    expect(routerLinkFrom('http://127.0.0.1:51234', token)).toEqual({ url: 'http://127.0.0.1:51234', token })
    expect(routerLinkFrom('https://hub.example.com/v1', token)).toBeNull()
    expect(routerLinkFrom('http://127.0.0.1:51234', '')).toBeNull()
    expect(routerLinkFrom(undefined, token)).toBeNull()
  })

  test('arguments: nothing opens the pane, status, use with a name', () => {
    expect(parseProviderArgs('')).toEqual({ verb: 'pane' })
    expect(parseProviderArgs('status')).toEqual({ verb: 'status' })
    expect(parseProviderArgs('use Myhub')).toEqual({ verb: 'use', name: 'myhub' })
    expect(parseProviderArgs('use')).toEqual({ verb: 'error', message: 'Name a profile: /provider-nexus use <name> (or claude).' })
    expect(parseProviderArgs('nope').verb).toBe('error')
  })

  test('fallback choices put the default first', () => {
    const other = { ...MYHUB, name: 'omni', isDefault: false }
    const off = { ...MYHUB, name: 'off', fallback: false, isDefault: false }
    expect(fallbackChoices([other, off, MYHUB]).map(one => one.name)).toEqual(['myhub', 'omni'])
  })

  test('compaction is due past the share of the profile window', () => {
    expect(needsCompaction(90_000, 100_000, 0.85)).toBe(true)
    expect(needsCompaction(80_000, 100_000, 0.85)).toBe(false)
    expect(needsCompaction(null, 100_000, 0.85)).toBe(false)
  })

  test('the HUD badge names the profile and its model', () => {
    expect(hubBadge('myhub', 'antigravity/gemini-3.8-flash-tiered')).toBe('⇄ myhub · antigravity/gemini-3.8-flash-tiered')
    expect(hubBadge('myhub', null)).toBe('⇄ myhub')
  })
})
