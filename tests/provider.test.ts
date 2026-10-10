import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

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

  test('a stored entry with a wrong-typed field is left out, never thrown on', () => {
    expect(readProfiles([{ name: 5 }, { ...MYHUB, models: { opus: 5 } }, MYHUB])).toEqual([MYHUB])
    expect(validateProfile({ name: 5 as never }, []).errors?.name).toContain('lowercase')
    expect(validateProfile({ ...MYHUB, hubUrl: 5, apiKey: {} } as never, []).errors).toEqual({
      hubUrl: 'an http(s) URL, such as https://hub.example.com/v1',
      apiKey: 'the hub needs a key',
    })
  })

  test('the stored list keeps the first of a repeated name', () => {
    const again = { ...MYHUB, apiKey: 'sk-zyxwvutsrqponm' }
    expect(readProfiles([MYHUB, again])).toEqual([MYHUB])
  })

  test('a stored fallback and default flag survive the read', () => {
    expect(readProfiles([MYHUB])[0]).toMatchObject({ fallback: true, isDefault: true })
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

const BASE_OPTIONS = {
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

const START = { cwd: 'C:/app', surface: 'terminal', isInteractive: true }
const CONTROL = 'c'.repeat(64)

function routerEnv(on: On) {
  const env: Record<string, string | undefined> = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:51234', NEXUS_ROUTER_TOKEN: CONTROL }
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('env.set', (_, e) => {
    env[e.name] = e.value
    return { value: undefined }
  })
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = []
  on('http.fetch', (_, e) => {
    const body = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    calls.push({ url: e.url, method: e.init?.method ?? 'GET', headers: e.init?.headers ?? {}, body })
    const data = e.url.endsWith('/__nexus/status') ? { route: 'claude', model: null, counts: { claude: 0, hub: 0 }, held: [] } : e.url.includes('/__nexus/events') ? { events: [] } : { ok: true }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) } }
  })
  on('session.root', () => ({ value: 'C:/app' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.clock(on)
  // Every write to state, as the JSON the engine would keep: what a reload (or anyone) could read back.
  const written: string[] = []
  on('state.set', (_, e, next) => {
    written.push(JSON.stringify(e.value))
    return next(e)
  })

  return { env, calls, written }
}

describe('router link in a claude-nexus session', () => {
  test('the control token is read once, kept in state, and taken out of the env tools inherit', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    const { env } = routerEnv(on)
    await $.session.start?.(START as never)
    expect(env.NEXUS_ROUTER_TOKEN).toBeUndefined()
    expect((await $.command.run({ command: 'provider-nexus', args: 'status' } as never)).text).toContain('Claude (subscription)')
  })

  test('the link survives a reload: status still works with the token gone from the env', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    const { env, calls } = routerEnv(on)
    await $.session.start?.(START as never)
    await $.session.start?.(START as never)
    expect(env.NEXUS_ROUTER_TOKEN).toBeUndefined()
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    expect(calls.at(-1)?.headers['x-nexus-control']).toBe(CONTROL)
  })

  test('use sends the profile with its key to the router and names the route', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { calls, written } = routerEnv(on)
    await $.session.start?.(START as never)
    const answer = await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    expect(answer.text).toContain('myhub')
    const route = calls.find(one => one.url.endsWith('/__nexus/route'))
    expect(route?.body).toEqual({ route: 'myhub', profile: { hubUrl: MYHUB.hubUrl, apiKey: MYHUB.apiKey, models: MYHUB.models, contextWindow: MYHUB.contextWindow } })
    expect(written.length).toBeGreaterThan(0)
    expect(written.join(' ')).not.toContain(MYHUB.apiKey)
    expect(written.join(' ')).toContain('sk-a…mnop')
  })

  test('the HUD names the hub while a profile is in use, and the model again after claude', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    routerEnv(on)
    await $.session.start?.(START as never)
    const band = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
    await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: band })
    expect(await ui.find({ type: 'Text', text: /⇄ myhub · antigravity/ })).toBeDefined()
    await $.command.run({ command: 'provider-nexus', args: 'use claude' } as never)
    expect(await ui.find({ type: 'Text', text: /⇄ myhub/ })).toBeUndefined()
    await ui.unmount()
  })

  test('an unknown profile is refused without calling the router', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    const { calls } = routerEnv(on)
    await $.session.start?.(START as never)
    expect((await $.command.run({ command: 'provider-nexus', args: 'use nope' } as never)).text).toContain('No profile named nope')
    expect(calls.some(one => one.url.endsWith('/__nexus/route'))).toBe(false)
  })
})

describe('provider in a plain claude session', () => {
  test('without the launcher the command explains how to start one', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    on('env.get', () => ({ value: undefined }))
    on('session.root', () => ({ value: 'C:/app' }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    mock.clock(on)
    await $.session.start?.(START as never)
    expect((await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)).text).toContain('claude-nexus')
  })
})
