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
  const net = { isDown: false, routeStatus: 200 }
  on('http.fetch', (_, e) => {
    const body = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    calls.push({ url: e.url, method: e.init?.method ?? 'GET', headers: e.init?.headers ?? {}, body })
    if (net.isDown) throw new Error('connect ECONNREFUSED 127.0.0.1:51234')
    if (e.url.endsWith('/__nexus/route') && net.routeStatus !== 200) {
      return { value: { status: net.routeStatus, ok: false, headers: {}, text: JSON.stringify({ error: 'x' }) } }
    }
    const data = e.url.endsWith('/__nexus/status') ? { route: 'claude', model: null, counts: { claude: 0, hub: 0 }, held: [] } : e.url.includes('/__nexus/events') ? { events: [] } : { ok: true }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) } }
  })
  on('session.root', () => ({ value: 'C:/app' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  // Every write to state, as the JSON the engine would keep: what a reload (or anyone) could read back.
  const writes: { key: string; json: string; value: unknown }[] = []
  on('state.set', (_, e, next) => {
    writes.push({ key: e.key, json: JSON.stringify(e.value), value: e.value })
    return next(e)
  })
  const written = {
    of: (key: string) => writes.filter(one => one.key === key),
    all: () => writes.map(one => one.json).join(' '),
  }

  return { env, calls, written, net, clock }
}

describe('router link in a claude-nexus session', () => {
  test('the control token is read once, kept in state, and taken out of the env tools inherit', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    const { env, written } = routerEnv(on)
    await $.session.start?.(START as never)
    expect(env.NEXUS_ROUTER_TOKEN).toBeUndefined()
    expect((await $.command.run({ command: 'provider-nexus', args: 'status' } as never)).text).toContain('Claude (subscription)')
    // The token is kept in routerLink alone, never in the provider view.
    expect(written.of('routerLink').map(one => one.value)).toContainEqual({ url: 'http://127.0.0.1:51234', token: CONTROL })
    expect(written.of('provider').length).toBeGreaterThan(0)
    expect(written.of('provider').map(one => one.json).join(' ')).not.toContain(CONTROL)
  })

  test('the link survives a reload: status still works with the token gone from the env', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    const { env, calls, clock } = routerEnv(on)
    await $.session.start?.(START as never)
    await clock.settle()
    await $.session.start?.(START as never)
    await clock.settle()
    expect(env.NEXUS_ROUTER_TOKEN).toBeUndefined()
    // Whatever the starts fired has settled: what follows is the command's own call.
    const seen = calls.length
    const answer = await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    expect(answer.text).toContain('Claude (subscription)')
    expect(calls.length).toBeGreaterThan(seen)
    expect(calls.at(seen)?.url).toMatch(/\/__nexus\/status$/)
    expect(calls.at(seen)?.headers['x-nexus-control']).toBe(CONTROL)
    expect(env.NEXUS_ROUTER_TOKEN).toBeUndefined()
  })

  test('use sends the profile with its key to the router and names the route', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { calls, written } = routerEnv(on)
    await $.session.start?.(START as never)
    const answer = await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    expect(answer.text).toContain('myhub')
    const route = calls.find(one => one.url.endsWith('/__nexus/route'))
    expect(route?.body).toEqual({ route: 'myhub', profile: { hubUrl: MYHUB.hubUrl, apiKey: MYHUB.apiKey, models: MYHUB.models, contextWindow: MYHUB.contextWindow } })
    expect(written.all().length).toBeGreaterThan(0)
    expect(written.all()).not.toContain(MYHUB.apiKey)
    expect(written.of('provider').map(one => one.json).join(' ')).toContain('sk-a…mnop')
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

describe('a router that is down or refuses', () => {
  test('an unreachable router gets a plain answer, not a rejection', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { net, clock } = routerEnv(on)
    await $.session.start?.(START as never)
    await clock.settle()
    net.isDown = true
    expect((await $.command.run({ command: 'provider-nexus', args: 'status' } as never)).text).toContain('The router did not answer')
    expect((await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)).text).toContain('The router refused')
  })

  test('a 400 from the router names the refusal and leaves the route on claude', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { net, written, clock } = routerEnv(on)
    await $.session.start?.(START as never)
    await clock.settle()
    net.routeStatus = 400
    expect((await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)).text).toContain('The router refused: x')
    const routes = written.of('provider').map(one => (one.value as { route: string }).route)
    expect(routes.length).toBeGreaterThan(0)
    expect(routes.every(route => route === 'claude')).toBe(true)
  })
})

describe('switching with a full context', () => {
  const measure = { context: { tokens: 900_000, window: 1_000_000, percent: 90 }, rateLimits: [], changed: ['context'] } as never

  test('past 80% of the profile window, Cancel leaves the session where it is', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { calls, clock } = routerEnv(on)
    let asked = ''
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      asked = e.questions[0]?.question ?? ''
      return { result: { questions: e.questions, answers: { [asked]: 'Cancel' } } }
    })
    on('session.measure', (_, e) => ({ changed: e.changed }))
    await $.session.start?.(START as never)
    await clock.settle()
    await $.session.measure(measure)
    const answer = await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    expect(answer.text).toBe('Not switched.')
    expect(asked).toContain('past 80%')
    expect(calls.some(one => one.url.endsWith('/__nexus/route'))).toBe(false)
  })

  test('on a hub, compaction starts at 85% and then waits a minute', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { clock } = routerEnv(on)
    let compactions = 0
    on('session.compact', () => {
      compactions += 1
      return { messages: [{ role: 'user', text: 'Summary', toolUses: [] }] } as never
    })
    on('session.measure', (_, e) => ({ changed: e.changed }))
    await $.session.start?.(START as never)
    await clock.settle()
    await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    await $.session.measure(measure)
    await clock.settle()
    expect(compactions).toBe(1)
    await clock.advance(10_000)
    await $.session.measure(measure)
    await clock.settle()
    expect(compactions).toBe(1)
    await clock.advance(61_000)
    await $.session.measure(measure)
    await clock.settle()
    expect(compactions).toBe(2)
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
