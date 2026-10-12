import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import {
  DRAFT_STEPS,
  draftToProfile,
  fallbackChoices,
  hubBadge,
  hubModelFor,
  maskKey,
  modelChoices,
  needsCompaction,
  nextStep,
  parseProviderArgs,
  pendingRouteFor,
  PENDING_ROUTE_MS,
  primaryModel,
  readProfiles,
  restartCommand,
  routerLinkFrom,
  toggleTarget,
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
  modelFallback: false,
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
      modelFallback: false,
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

  test('model fallback is kept per profile, off unless set', () => {
    expect(readProfiles([{ ...MYHUB, modelFallback: true }])[0]?.modelFallback).toBe(true)
    const { modelFallback: _, ...old } = MYHUB
    expect(readProfiles([old])[0]?.modelFallback).toBe(false)
    expect(draftToProfile({ modelFallback: 'yes' }).modelFallback).toBe(true)
    expect(draftToProfile({ modelFallback: 'no' }).modelFallback).toBe(false)
  })

  test('the hub model for the Claude model in use: its tier, else the first filled', () => {
    const three = { opus: 'big', sonnet: 'mid', haiku: 'small' }
    expect(hubModelFor('claude-opus-5-5', three)).toBe('big')
    expect(hubModelFor('claude-sonnet-5-5', three)).toBe('mid')
    expect(hubModelFor('claude-haiku-5-5', three)).toBe('small')
    expect(hubModelFor('Haiku 5.5', three)).toBe('small')
    expect(hubModelFor('claude-haiku-5-5', { opus: 'big' })).toBe('big')
    expect(hubModelFor('claude-haiku-5-5', {})).toBeUndefined()
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
    expect(parseProviderArgs('test myhub')).toEqual({ verb: 'test', name: 'myhub' })
    expect(parseProviderArgs('test').verb).toBe('error')
    expect(parseProviderArgs('use')).toEqual({ verb: 'error', message: 'Name a profile: /provider-nexus use <name> (or claude).' })
    expect(parseProviderArgs('Myhub')).toEqual({ verb: 'use', name: 'myhub' })
    expect(parseProviderArgs('claude')).toEqual({ verb: 'use', name: 'claude' })
    expect(parseProviderArgs('myhub extra').verb).toBe('error')
  })

  test('the restart command resumes this session under the launcher from its folder', () => {
    expect(restartCommand('C:/app', 'abc-123', true)).toBe('cd "C:/app"; claude-nexus --resume abc-123')
    expect(restartCommand('/home/me/app', 'abc-123', false)).toBe('cd "/home/me/app" && claude-nexus --resume abc-123')
  })

  test('a pending switch counts only in the same folder and while fresh', () => {
    const at = 1_000_000
    const pending = { name: 'myhub', cwd: 'C:\\App\\', at }
    expect(pendingRouteFor(pending, 'c:/app', at + 60_000)).toBe('myhub')
    expect(pendingRouteFor(pending, 'C:/other', at + 60_000)).toBeNull()
    expect(pendingRouteFor(pending, 'C:/app', at + PENDING_ROUTE_MS + 1)).toBeNull()
    expect(pendingRouteFor(pending, 'C:/app', at - 1)).toBeNull()
    expect(pendingRouteFor({ name: 1, cwd: 'C:/app', at }, 'C:/app', at)).toBeNull()
    expect(pendingRouteFor(null, 'C:/app', at)).toBeNull()
  })

  test('the one key goes back to Claude from a hub, else to the last hub, the default, a fallback or the first', () => {
    const plain = { name: 'plain', fallback: false, isDefault: false }
    const spare = { name: 'spare', fallback: true, isDefault: false }
    const main = { name: 'main', fallback: true, isDefault: true }
    expect(toggleTarget('main', null, [main])).toBe('claude')
    expect(toggleTarget('claude', 'spare', [main, spare])).toBe('spare')
    expect(toggleTarget('claude', 'gone', [plain, spare, main])).toBe('main')
    expect(toggleTarget('claude', null, [plain, spare])).toBe('spare')
    expect(toggleTarget('claude', null, [plain])).toBe('plain')
    expect(toggleTarget('claude', null, [])).toBeNull()
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

/** `events`: what the router's event poll answers, one batch per call; once they are served it refuses, so the watcher backs off instead of spinning. */
function routerEnv(on: On, events: unknown[][] = []) {
  const env: Record<string, string | undefined> = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:51234', NEXUS_ROUTER_TOKEN: CONTROL }
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('env.set', (_, e) => {
    env[e.name] = e.value
    return { value: undefined }
  })
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = []
  const net = { isDown: false, routeStatus: 200, failKey: null as string | null, lost: new Set<string>(), statusRoute: 'claude', statusModel: null as string | null }
  on('http.fetch', (_, e) => {
    const body = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    calls.push({ url: e.url, method: e.init?.method ?? 'GET', headers: e.init?.headers ?? {}, body })
    if (net.isDown) throw new Error('connect ECONNREFUSED 127.0.0.1:51234')
    if (e.url.endsWith('/__nexus/route') && net.routeStatus !== 200) {
      return { value: { status: net.routeStatus, ok: false, headers: {}, text: JSON.stringify({ error: 'x' }) } }
    }
    // The watcher's long poll: never an instant ok once the script is spent, or it would spin.
    if (e.url.includes('/__nexus/events')) {
      const batch = events.shift()
      if (batch === undefined) return { value: { status: 503, ok: false, headers: {}, text: '' } }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ events: batch }) } }
    }
    const data = e.url.endsWith('/__nexus/status') ? { route: net.statusRoute, model: net.statusModel, counts: { claude: 0, hub: 0 }, held: [] } : { ok: true }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) } }
  })
  on('session.root', () => ({ value: 'C:/app' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  // A state value that reads back as nothing, for the key a test names: what a damaged state would do.
  // A key in `lost` reads back as nothing until it is written again: a state the host reset (a /clear).
  on('state.get', async (_, e, next) => {
    if (net.lost.has(e.key)) return { value: { ...((await next(e)) as { value: { version: number } }).value, value: undefined } } as never
    return net.failKey === e.key ? ({ value: null, version: 1 } as never) : next(e)
  })
  // Every write to state, as the JSON the engine would keep: what a reload (or anyone) could read back.
  const writes: { key: string; json: string; value: unknown }[] = []
  on('state.set', (_, e, next) => {
    writes.push({ key: e.key, json: JSON.stringify(e.value), value: e.value })
    net.lost.delete(e.key)
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
    expect(route?.body).toEqual({ route: 'myhub', profile: { hubUrl: MYHUB.hubUrl, apiKey: MYHUB.apiKey, models: MYHUB.models, contextWindow: MYHUB.contextWindow, modelFallback: false } })
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

  test('the HUD badge follows the Claude model in use to the hub model of its tier', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [{ ...MYHUB, models: { opus: 'big-model', sonnet: 'mid-model', haiku: 'small-model' } }] })
    const { clock } = routerEnv(on)
    let model = 'claude-opus-5-5'
    on('session.model', () => ({ value: model }))
    on('session.usage', () => ({ value: { context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: [] } }) as never)
    on('fs.exists', () => ({ value: false }))
    on('fs.list', () => ({ value: [] }) as never)
    on('session.id', () => ({ value: 'sess-1' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
    await $.session.start?.(START as never)
    const band = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
    await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: band })
    expect(await ui.find({ type: 'Text', text: /⇄ myhub · big-model/ })).toBeDefined()
    // /model sonnet: the next HUD refresh names sonnet's hub model.
    model = 'claude-sonnet-5-5'
    await clock.advance(4000)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /⇄ myhub · mid-model/ })).toBeDefined()
    await ui.unmount()
  })

  test('a model fallback on the hub is told in a toast naming both models', { options: { ...BASE_OPTIONS, fallbackMode: 'off' } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const events: unknown[][] = [[{ type: 'model-fallback', route: 'myhub', from: 'big-model', to: 'mid-model', status: 503 }]]
    const { clock } = routerEnv(on, events)
    const toasts: string[] = []
    on('ui.toast', (_, e) => {
      toasts.push(String((e as { text?: unknown }).text ?? ''))
      return { value: undefined } as never
    })
    await $.session.start?.(START as never)
    await clock.advance(2000)
    await clock.settle()
    expect(toasts.some(one => one.includes('big-model') && one.includes('503') && one.includes('mid-model'))).toBe(true)
  })

  test('a state the host reset does not lose the link: status and use claude still work, and the route comes back', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { env, net, written, clock } = routerEnv(on)
    await $.session.start?.(START as never)
    await clock.settle()
    await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    net.statusRoute = 'myhub'
    net.statusModel = 'antigravity/gemini-3.8-flash-tiered'
    // /clear: state reads back empty, the env no longer holds the token.
    net.lost.add('routerLink').add('provider').add('routerWatcher')
    expect(env.NEXUS_ROUTER_TOKEN).toBeUndefined()
    const status = await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    expect(status.text).toContain('myhub')
    expect(status.text).not.toContain('does not run behind')
    expect(written.of('routerLink').at(-1)?.value).toEqual({ url: 'http://127.0.0.1:51234', token: CONTROL })
    const route = (written.of('provider').at(-1)?.value as { route: string; linked: boolean }) ?? { route: '', linked: false }
    expect(route.route).toBe('myhub')
    expect(route.linked).toBe(true)
    net.lost.add('routerLink')
    net.statusRoute = 'claude'
    expect((await $.command.run({ command: 'provider-nexus', args: 'use claude' } as never)).text).toContain('Back on Claude')
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

/** A store that answers from `entries` and keeps what the plugin writes, readable by the test: undefined once deleted. */
function storeLog(on: On, entries: Record<string, unknown>) {
  const now: Record<string, unknown> = { ...entries }
  on('store.get', (_, e) => ({ value: now[e.key] }) as never)
  on('store.set', (_, e) => {
    now[e.key] = e.value
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => {
    delete now[e.key]
    return { value: undefined } as never
  })

  return now
}

describe('provider in a plain claude session', () => {
  function plainEnv(on: On) {
    const stored = storeLog(on, { providers: [MYHUB] })
    on('env.get', () => ({ value: undefined }))
    on('session.root', () => ({ value: 'C:/app' }))
    on('session.id', () => ({ value: 'sess-1' }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    const copied: string[] = []
    on('ui.copy', (_, e) => {
      copied.push(e.text)
      return { value: { isCopied: true } }
    })
    const clock = mock.clock(on)

    return { copied, clock, stored }
  }

  test('a switch copies the command that resumes this conversation under claude-nexus, and remembers the profile', { options: BASE_OPTIONS }, async ($, on) => {
    const { copied, stored } = plainEnv(on)
    await $.session.start?.(START as never)
    const text = (await $.command.run({ command: 'provider-nexus', args: 'myhub' } as never)).text ?? ''
    expect(text).toContain('Copied')
    expect(copied).toEqual(['cd "C:/app"; claude-nexus --resume sess-1'])
    expect(stored.providerPending).toMatchObject({ name: 'myhub', cwd: 'C:/app' })
    expect(JSON.stringify(stored.providerPending)).not.toContain(MYHUB.apiKey)
  })

  test('an unknown profile or claude copies nothing', { options: BASE_OPTIONS }, async ($, on) => {
    const { copied, stored } = plainEnv(on)
    await $.session.start?.(START as never)
    expect((await $.command.run({ command: 'provider-nexus', args: 'nope' } as never)).text).toContain('No profile named nope')
    expect((await $.command.run({ command: 'provider-nexus', args: 'claude' } as never)).text).toContain('already on Claude')
    expect(copied).toEqual([])
    expect(stored.providerPending).toBeUndefined()
  })
})

describe('the one-key switch on the band', () => {
  const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

  test('r names the hub on Claude and copies the restart command in a plain session', { options: BASE_OPTIONS }, async ($, on) => {
    storeLog(on, { providers: [MYHUB] })
    on('env.get', () => ({ value: undefined }))
    on('session.root', () => ({ value: 'C:/app' }))
    on('session.id', () => ({ value: 'sess-1' }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    const copied: string[] = []
    on('ui.copy', (_, e) => {
      copied.push(e.text)
      return { value: { isCopied: true } }
    })
    mock.clock(on)
    await $.session.start?.(START as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const key = await ui.find({ key: 'route' })
    expect(key).toBeDefined()
    expect(JSON.stringify(key)).toContain('myhub')
    await ui.press({ key: 'route' })
    expect(copied).toEqual(['cd "C:/app"; claude-nexus --resume sess-1'])
    await ui.unmount()
  })

  test('no profiles: no r key', { options: BASE_OPTIONS }, async ($, on) => {
    storeLog(on, {})
    on('env.get', () => ({ value: undefined }))
    on('session.root', () => ({ value: 'C:/app' }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    mock.clock(on)
    await $.session.start?.(START as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ key: 'route' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('a pending switch at a claude-nexus start', () => {
  test('a fresh switch from this folder is carried out once, then forgotten', { options: BASE_OPTIONS }, async ($, on) => {
    const stored = storeLog(on, { providers: [MYHUB], providerPending: { name: 'myhub', cwd: 'C:/app', at: 0 } })
    const { calls, clock } = routerEnv(on)
    await $.session.start?.(START as never)
    await clock.settle()
    const route = calls.find(one => one.url.endsWith('/__nexus/route'))
    expect((route?.body as { route?: string } | undefined)?.route).toBe('myhub')
    expect(stored.providerPending).toBeUndefined()
    expect(stored.providerLast).toBe('myhub')
  })

  test('a stale switch is dropped without switching', { options: BASE_OPTIONS }, async ($, on) => {
    const stored = storeLog(on, { providers: [MYHUB], providerPending: { name: 'myhub', cwd: 'C:/app', at: -PENDING_ROUTE_MS - 1 } })
    const { calls, clock } = routerEnv(on)
    await $.session.start?.(START as never)
    await clock.settle()
    expect(calls.some(one => one.url.endsWith('/__nexus/route'))).toBe(false)
    expect(stored.providerPending).toBeUndefined()
  })
})

describe('editing the profile in use', () => {
  async function edit($: Parameters<NonNullable<Parameters<typeof test>[2]>>[0], on: On, useFirst: boolean) {
    mock.store(on, { providers: [MYHUB] })
    const { calls, written, clock } = routerEnv(on)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.session.start?.(START as never)
    await clock.settle()
    if (useFirst) await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    await ui.press({ key: 'edit-myhub' })
    await ui.input({ key: 'name', text: 'myhub' })
    await ui.input({ key: 'hubUrl', text: 'https://new.example/v1' })
    await ui.input({ key: 'apiKey', text: 'sk-brand-new-key-123' })
    await ui.input({ key: 'opus', text: 'new-model' })
    await ui.input({ key: 'sonnet', text: '' })
    await ui.input({ key: 'haiku', text: '' })
    await ui.select({ key: 'modelFallback', value: 'no' })
    await ui.input({ key: 'contextWindow', text: '500000' })
    await ui.select({ key: 'fallback', value: 'yes' })
    await ui.unmount()

    return { calls, written }
  }

  test('saving an edit of the active profile sends the new values to the router', { options: BASE_OPTIONS }, async ($, on) => {
    const { calls, written } = await edit($ as never, on, true)
    const posts = calls.filter(one => one.url.endsWith('/__nexus/route')).map(one => one.body as { route: string; profile: Record<string, unknown> })
    expect(posts.map(one => one.route)).toEqual(['myhub', 'myhub'])
    expect(posts.at(-1)?.profile).toEqual({ hubUrl: 'https://new.example/v1', apiKey: 'sk-brand-new-key-123', models: { opus: 'new-model' }, contextWindow: 500_000, modelFallback: false })
    expect(written.all()).not.toContain('sk-brand-new-key-123')
  })

  test('editing a profile that is not in use leaves the router alone', { options: BASE_OPTIONS }, async ($, on) => {
    const { calls } = await edit($ as never, on, false)
    expect(calls.some(one => one.url.endsWith('/__nexus/route'))).toBe(false)
  })
})

describe('profile draft', () => {
  test('steps run in order and end after fallback', () => {
    expect(DRAFT_STEPS[0]).toBe('name')
    expect(nextStep('apiKey')).toBe('opus')
    expect(nextStep('fallback')).toBeNull()
    // An edit's model stays a choice even when the hub's list left it out.
    expect(modelChoices(['a', 'b'], 'z')).toEqual(['', 'z', 'a', 'b'])
    expect(modelChoices(['a', 'b'], 'b')).toEqual(['', 'b', 'a'])
    expect(modelChoices(['a'], undefined)).toEqual(['', 'a'])
  })

  test('draft values become a profile draft; yes marks fallback and default', () => {
    expect(
      draftToProfile({ name: 'myhub', hubUrl: 'https://h/v1', apiKey: 'k', opus: 'm', sonnet: '', haiku: '', contextWindow: '', fallback: 'yes-default' }),
    ).toEqual({ name: 'myhub', hubUrl: 'https://h/v1', apiKey: 'k', models: { opus: 'm', sonnet: '', haiku: '' }, contextWindow: '', fallback: true, isDefault: true, modelFallback: false })
  })
})

const PANE = { title: 'Providers', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const

/** What the pane draws, as JSON: every string the person could read or an inspector see. */
async function drawn(ui: { drawn: () => Promise<unknown> }): Promise<string> {
  return JSON.stringify(await ui.drawn())
}

describe('provider pane', () => {
  test('a saved profile shows its key masked, never whole', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    expect(await ui.find({ type: 'Text', text: /myhub/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: new RegExp(maskKey(MYHUB.apiKey)) })).toBeDefined()
    expect(await drawn(ui)).not.toContain(MYHUB.apiKey)
    await ui.unmount()
  })

  test('a session outside claude-nexus is told what claude-nexus is, and can still add', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    expect(await ui.find({ type: 'Text', text: /claude-nexus/ })).toBeDefined()
    expect(await ui.find({ key: 'add' })).toBeDefined()
    expect(await ui.find({ key: 'claude' })).toBeUndefined()
    await ui.unmount()
  })

  test('the form walks the steps, offers the hub models, and saves a masked profile', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    mock.clock(on)
    const asked: string[] = []
    const sent: unknown[] = []
    on('http.fetch', (_, e) => {
      asked.push(`${e.url} ${JSON.stringify(e.init?.headers ?? {})}`)
      if (e.init?.body !== undefined) sent.push(JSON.parse(e.init.body))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }) } }
    })
    const writes: string[] = []
    on('state.set', (_, e, next) => {
      writes.push(JSON.stringify(e.value))
      return next(e)
    })
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    await ui.press({ key: 'add' })
    expect(await ui.find({ type: 'Input', key: 'name' })).toBeDefined()
    await ui.input({ key: 'name', text: ' omni ' })
    await ui.input({ key: 'hubUrl', text: 'https://omni.example/v1/' })
    await ui.input({ key: 'apiKey', text: 'sk-abcdefghijklmnop' })
    expect(asked).toEqual(['https://omni.example/v1/models {"x-api-key":"sk-abcdefghijklmnop","authorization":"Bearer sk-abcdefghijklmnop"}'])
    // The model steps now pick from what the hub listed.
    expect(await ui.find({ type: 'Select', key: 'opus' })).toBeDefined()
    await ui.select({ key: 'opus', value: 'm-one' })
    await ui.select({ key: 'sonnet', value: '' })
    await ui.select({ key: 'haiku', value: '' })
    await ui.select({ key: 'modelFallback', value: 'yes' })
    await ui.input({ key: 'contextWindow', text: '' })
    await ui.select({ key: 'fallback', value: 'yes-default' })
    // What was saved, read back through the store: the tidied URL, the one model, the key kept whole there.
    const answer = await $.command.run({ command: 'provider-nexus', args: 'test omni' } as never)
    expect(answer.text).toContain('omni (https://omni.example/v1):')
    expect(sent).toEqual([{ model: 'm-one', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] }])
    expect(asked.at(-1)).toContain('https://omni.example/v1/messages')
    expect(asked.at(-1)).toContain('"x-api-key":"sk-abcdefghijklmnop"')
    // Once saved the draft (and the key it held) is gone and the list shows the key masked.
    const last = JSON.parse(writes.filter(one => one.includes('"draft"')).at(-1) ?? '{}') as { draft: unknown; profiles: { key: string }[] }
    expect(last.draft).toBeNull()
    expect(last.profiles[0]).toMatchObject({ key: 'sk-a…mnop', contextWindow: 200_000, fallback: true, isDefault: true, modelFallback: true })
    // Not one write to state, at any point of the form, held the key.
    expect(writes.length).toBeGreaterThan(5)
    expect(writes.join(' ')).not.toContain('sk-abcdefghijklmnop')
    expect(await drawn(ui)).not.toContain('sk-abcdefghijklmnop')
    await ui.unmount()
  })

  test('a mistake sends the form back to the step it belongs to', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    await ui.press({ key: 'add' })
    await ui.input({ key: 'name', text: 'myhub' })
    await ui.input({ key: 'hubUrl', text: 'https://h.example/v1' })
    await ui.input({ key: 'apiKey', text: 'k-1234567890' })
    // No model list came back, so the model steps are plain fields.
    await ui.input({ key: 'opus', text: 'm' })
    await ui.input({ key: 'sonnet', text: '' })
    await ui.input({ key: 'haiku', text: '' })
    await ui.select({ key: 'modelFallback', value: 'no' })
    await ui.input({ key: 'contextWindow', text: '' })
    await ui.select({ key: 'fallback', value: 'no' })
    expect(await ui.find({ type: 'Text', text: /already exists/ })).toBeDefined()
    expect(await ui.find({ type: 'Input', key: 'name' })).toBeDefined()
    await ui.unmount()
  })

  test('cancel drops the draft and the key with it', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    await ui.press({ key: 'add' })
    await ui.input({ key: 'name', text: 'omni' })
    await ui.input({ key: 'hubUrl', text: 'https://omni.example/v1' })
    await ui.input({ key: 'apiKey', text: 'sk-abcdefghijklmnop' })
    await ui.press({ key: 'cancel' })
    expect(await ui.find({ key: 'add' })).toBeDefined()
    expect(await drawn(ui)).not.toContain('sk-abcdefghijklmnop')
    await ui.unmount()
  })

  test('an edit keeps the stored key on an empty key step, and no state write ever holds a key', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    mock.clock(on)
    const keys: string[] = []
    const sent: unknown[] = []
    on('http.fetch', (_, e) => {
      keys.push(`${e.url} ${(e.init?.headers ?? {})['x-api-key']}`)
      if (e.init?.body !== undefined) sent.push(JSON.parse(e.init.body))
      return { value: { status: 500, ok: false, headers: {}, text: '' } }
    })
    const writes: string[] = []
    on('state.set', (_, e, next) => {
      writes.push(JSON.stringify(e.value))
      return next(e)
    })
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    await ui.press({ key: 'edit-myhub' })
    expect((await ui.find({ type: 'Input', key: 'name' }))?.props.value).toBe('myhub')
    await ui.input({ key: 'name', text: 'myhub' })
    await ui.input({ key: 'hubUrl', text: MYHUB.hubUrl })
    // The stored key is offered by its mask only; an empty answer keeps it.
    expect((await ui.find({ type: 'Input', key: 'apiKey' }))?.props.placeholder).toBe(`keep ${maskKey(MYHUB.apiKey)}: press Enter`)
    await ui.input({ key: 'apiKey', text: '' })
    // The model list was asked for with the stored key.
    expect(keys).toEqual([`${MYHUB.hubUrl}/models ${MYHUB.apiKey}`])
    await ui.input({ key: 'opus', text: 'new-model' })
    await ui.input({ key: 'sonnet', text: '' })
    await ui.input({ key: 'haiku', text: '' })
    await ui.select({ key: 'modelFallback', value: 'no' })
    await ui.input({ key: 'contextWindow', text: '500000' })
    await ui.select({ key: 'fallback', value: 'yes' })
    await $.command.run({ command: 'provider-nexus', args: 'test myhub' } as never)
    expect(keys.at(-1)).toBe(`${MYHUB.hubUrl}/messages ${MYHUB.apiKey}`)
    expect(sent).toEqual([{ model: 'new-model', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] }])
    expect(writes.length).toBeGreaterThan(5)
    expect(writes.join(' ')).not.toContain(MYHUB.apiKey)
    expect(await drawn(ui)).not.toContain(MYHUB.apiKey)
    await ui.unmount()
  })

  test('an edit offers the hub models too, with the stored ones kept as choices', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    mock.clock(on)
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }) } }))
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    await ui.press({ key: 'edit-myhub' })
    await ui.input({ key: 'name', text: 'myhub' })
    await ui.input({ key: 'hubUrl', text: MYHUB.hubUrl })
    await ui.input({ key: 'apiKey', text: '' })
    const opus = await ui.find({ type: 'Select', key: 'opus' })
    expect(opus).toBeDefined()
    const values = (opus?.props.options as { value: string }[]).map(one => one.value)
    expect(values).toContain('m-one')
    expect(values).toContain(MYHUB.models.opus)
    expect(opus?.props.value).toBe(MYHUB.models.opus)
    await ui.unmount()
  })

  test('a new key typed on an edit replaces the stored one',{ options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    mock.clock(on)
    const keys: string[] = []
    on('http.fetch', (_, e) => {
      keys.push(String((e.init?.headers ?? {})['x-api-key']))
      return { value: { status: 500, ok: false, headers: {}, text: '' } }
    })
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    await ui.press({ key: 'edit-myhub' })
    await ui.input({ key: 'name', text: 'myhub' })
    await ui.input({ key: 'hubUrl', text: MYHUB.hubUrl })
    await ui.input({ key: 'apiKey', text: 'sk-newnewnewnewnew' })
    for (const step of ['opus', 'sonnet', 'haiku']) await ui.input({ key: step, text: step === 'opus' ? 'm' : '' })
    await ui.select({ key: 'modelFallback', value: 'no' })
    await ui.input({ key: 'contextWindow', text: '' })
    await ui.select({ key: 'fallback', value: 'no' })
    await $.command.run({ command: 'provider-nexus', args: 'test myhub' } as never)
    expect(keys).toEqual(['sk-newnewnewnewnew', 'sk-newnewnewnewnew'])
    await ui.unmount()
  })

  test('opening the pane afresh mid-form drops the draft and the key it held', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    mock.clock(on)
    on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    await ui.press({ key: 'add' })
    await ui.input({ key: 'name', text: 'omni' })
    await ui.input({ key: 'hubUrl', text: 'https://omni.example/v1' })
    await ui.input({ key: 'apiKey', text: 'sk-abcdefghijklmnop' })
    // The test's $ cannot close a pane; opening the pane afresh is the other way a form ends.
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    expect(await ui.find({ key: 'add' })).toBeDefined()
    // A fresh form starts with no key: its empty key step fails validation instead of reusing the old one.
    await ui.press({ key: 'add' })
    await ui.input({ key: 'name', text: 'omni' })
    await ui.input({ key: 'hubUrl', text: 'https://omni.example/v1' })
    await ui.input({ key: 'apiKey', text: '' })
    await ui.input({ key: 'opus', text: 'm' })
    await ui.input({ key: 'sonnet', text: '' })
    await ui.input({ key: 'haiku', text: '' })
    await ui.select({ key: 'modelFallback', value: 'no' })
    await ui.input({ key: 'contextWindow', text: '' })
    await ui.select({ key: 'fallback', value: 'no' })
    expect(await ui.find({ type: 'Text', text: /the hub needs a key/ })).toBeDefined()
    await ui.unmount()
  })

  test('ten profiles still draw: only the first nine get a digit hotkey', { options: BASE_OPTIONS }, async ($, on) => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...MYHUB, name: `p${i + 1}`, isDefault: false }))
    mock.store(on, { providers: many })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    routerEnv(on)
    await $.session.start?.(START as never)
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-provider', props: PANE })
    expect(await ui.find({ key: 'add' })).toBeDefined()
    expect((await ui.find({ key: 'use-p9' }))?.props.hotkey).toBe('9')
    expect(await ui.find({ key: 'use-p10' })).toBeDefined()
    expect((await ui.find({ key: 'use-p10' }))?.props.hotkey).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /p10/ })).toBeDefined()
    await ui.unmount()
  })

  test('test connection reports each mapped model', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [{ ...MYHUB, models: { opus: 'a', haiku: 'b' } }] })
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    mock.clock(on)
    const asked: string[] = []
    on('http.fetch', (_, e) => {
      asked.push(`${e.url} ${JSON.parse(e.init?.body ?? '{}').model}`)
      return { value: { status: 200, ok: true, headers: {}, text: '{"type":"message","content":[{"type":"text","text":"ok"}]}' } }
    })
    const answer = await $.command.run({ command: 'provider-nexus', args: 'test myhub' } as never)
    expect(answer.text).toContain('✓ a')
    expect(answer.text).toContain('✓ b')
    expect(asked).toEqual(['https://hub.example.com/v1/messages a', 'https://hub.example.com/v1/messages b'])
  })

  test('a failing hub is reported per model with its status, the key masked out', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    mock.clock(on)
    on('http.fetch', () => ({ value: { status: 401, ok: false, headers: {}, text: `bad key ${MYHUB.apiKey}` } }))
    const answer = await $.command.run({ command: 'provider-nexus', args: 'test myhub' } as never)
    expect(answer.text).toContain('✗ antigravity/gemini-3.8-flash-tiered  HTTP 401')
    expect(answer.text).not.toContain(MYHUB.apiKey)
    expect((await $.command.run({ command: 'provider-nexus', args: 'test nope' } as never)).text).toBe('No profile named nope.')
  })
})

describe('fallback when Claude quota runs out', () => {
  const LIMIT = { type: 'limit', id: 'h1', window: 'five_hour', resetsAt: 9_000_000 }

  function limitRouter(on: On) {
    return routerEnv(on, [[LIMIT]])
  }

  async function untilDecision(calls: { url: string }[], clock: { settle: () => Promise<void> }): Promise<void> {
    for (let i = 0; i < 50 && !calls.some(one => one.url.endsWith('/__nexus/decision')); i++) await clock.settle()
  }

  test('ask: the person picks the profile, the held request is retried there', { options: { ...BASE_OPTIONS, fallbackMode: 'ask' } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { calls, clock } = limitRouter(on)
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => ({
      result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Continue on myhub' } },
    }))
    await $.session.start?.(START as never)
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    await untilDecision(calls, clock)
    const route = calls.find(one => one.url.endsWith('/__nexus/route'))
    const decision = calls.find(one => one.url.endsWith('/__nexus/decision'))
    expect((route?.body as { route?: string } | undefined)?.route).toBe('myhub')
    expect(decision?.body).toEqual({ id: 'h1', action: 'retry' })
  })

  test('auto: the default fallback profile is used without asking', { options: { ...BASE_OPTIONS, fallbackMode: 'auto' } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { calls, clock } = limitRouter(on)
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      asked = true
      return { result: {} as never }
    })
    await $.session.start?.(START as never)
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    await untilDecision(calls, clock)
    expect((calls.find(one => one.url.endsWith('/__nexus/route'))?.body as { route?: string } | undefined)?.route).toBe('myhub')
    expect(calls.find(one => one.url.endsWith('/__nexus/decision'))?.body).toEqual({ id: 'h1', action: 'retry' })
    expect(asked).toBe(false)
  })

  test('declining the switch releases the held request', { options: { ...BASE_OPTIONS, fallbackMode: 'ask' } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { calls, clock } = limitRouter(on)
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => ({
      result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: "Don't switch" } },
    }))
    await $.session.start?.(START as never)
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    await untilDecision(calls, clock)
    expect(calls.find(one => one.url.endsWith('/__nexus/decision'))?.body).toEqual({ id: 'h1', action: 'release' })
    expect(calls.some(one => one.url.endsWith('/__nexus/route'))).toBe(false)
  })

  test('off: the held request is released at once', { options: { ...BASE_OPTIONS, fallbackMode: 'off' } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { calls, clock } = limitRouter(on)
    await $.session.start?.(START as never)
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    await untilDecision(calls, clock)
    expect(calls.find(one => one.url.endsWith('/__nexus/decision'))?.body).toEqual({ id: 'h1', action: 'release' })
    expect(calls.some(one => one.url.endsWith('/__nexus/route'))).toBe(false)
  })

  test('no fallback profile: released, nothing asked', { options: { ...BASE_OPTIONS, fallbackMode: 'ask' } }, async ($, on) => {
    mock.store(on, { providers: [{ ...MYHUB, fallback: false, isDefault: false }] })
    const { calls, clock } = limitRouter(on)
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      asked = true
      return { result: {} as never }
    })
    await $.session.start?.(START as never)
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    await untilDecision(calls, clock)
    expect(calls.find(one => one.url.endsWith('/__nexus/decision'))?.body).toEqual({ id: 'h1', action: 'release' })
    expect(asked).toBe(false)
  })

  test('ask: a hub whose window is smaller than the context says so on its choice', { options: { ...BASE_OPTIONS, fallbackMode: 'ask' } }, async ($, on) => {
    mock.store(on, { providers: [{ ...MYHUB, contextWindow: 100_000 }, { ...MYHUB, name: 'omni', contextWindow: 1_000_000, isDefault: false }] })
    const { calls, clock } = limitRouter(on)
    const labels: string[] = []
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      labels.push(...(e.questions[0]?.options ?? []).map(one => one.label))
      return { result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Continue on omni' } } }
    })
    on('session.measure', (_, e) => ({ changed: e.changed }))
    await $.session.start?.(START as never)
    await $.session.measure({ context: { tokens: 150_000, window: 1_000_000, percent: 15 }, rateLimits: [], changed: ['context'] } as never)
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    await untilDecision(calls, clock)
    expect(labels).toEqual(['Continue on myhub — context 150000 tokens exceeds its window; this turn will likely fail', 'Continue on omni', "Don't switch"])
    expect((calls.find(one => one.url.endsWith('/__nexus/route'))?.body as { route?: string } | undefined)?.route).toBe('omni')
  })
})

describe('back to Claude and the quota guard', () => {
  const LIMIT = { type: 'limit', id: 'h1', window: 'five_hour', resetsAt: 120_000 }

  test('after the reset, a turn end offers Claude again, once', { options: { ...BASE_OPTIONS, fallbackMode: 'auto' } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { calls, clock } = routerEnv(on, [[LIMIT]])
    const offers: string[] = []
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      offers.push(e.questions[0]?.question ?? '')
      return { result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Back to Claude' } } }
    })
    on('turn.complete', (_, e) => ({ text: e.answer }))
    const end = { answer: 'Done.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never
    await $.session.start?.(START as never)
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    for (let i = 0; i < 50 && !calls.some(one => one.url.endsWith('/__nexus/decision')); i++) await clock.settle()
    // Before the reset time nothing is offered.
    await $.turn.complete(end)
    await clock.settle()
    expect(offers).toEqual([])
    await clock.advance(120_000)
    await $.turn.complete(end)
    await clock.settle()
    expect(offers).toEqual(["Claude's quota has reset. Go back to Claude?"])
    expect(calls.filter(one => one.url.endsWith('/__nexus/route')).map(one => (one.body as { route: string }).route)).toEqual(['myhub', 'claude'])
    await $.turn.complete(end)
    await clock.settle()
    expect(offers).toHaveLength(1)
  })

  test('mid-turn, the quota question offers the fallback profile and switches on it', { options: { ...BASE_OPTIONS, quotaGuard: 90 } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { calls, clock } = routerEnv(on)
    const choices: string[][] = []
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      choices.push((e.questions[0]?.options ?? []).map(one => one.label))
      return { result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Switch to myhub now' } } }
    })
    on('session.measure', (_, e) => ({ changed: e.changed }))
    on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
    await $.session.start?.(START as never)
    await clock.settle()
    await $.turn.start({ turnId: 't1' } as never)
    await $.session.measure({
      context: { tokens: 1000, window: 1_000_000, percent: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(3_600_000).toISOString() }],
      changed: ['rateLimits'],
    } as never)
    await clock.settle()
    expect(choices).toEqual([['Keep going', 'Switch to myhub now', 'Stop this turn']])
    expect(calls.filter(one => one.url.endsWith('/__nexus/route')).map(one => (one.body as { route: string }).route)).toEqual(['myhub'])
  })

  test('the quota guard switch also earns the offer to go back, from the crossed window reset', { options: { ...BASE_OPTIONS, quotaGuard: 90 } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { calls, clock } = routerEnv(on)
    const offers: string[] = []
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      const question = e.questions[0]?.question ?? ''
      offers.push(question)
      const answer = question.includes('QUOTA') ? 'Switch to myhub now' : 'Back to Claude'
      return { result: { questions: e.questions, answers: { [question]: answer } } }
    })
    on('session.measure', (_, e) => ({ changed: e.changed }))
    on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
    on('turn.complete', (_, e) => ({ text: e.answer }))
    const end = { answer: 'Done.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never
    await $.session.start?.(START as never)
    await clock.settle()
    await $.turn.start({ turnId: 't1' } as never)
    await $.session.measure({
      context: { tokens: 1000, window: 1_000_000, percent: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(3_600_000).toISOString() }],
      changed: ['rateLimits'],
    } as never)
    await clock.settle()
    offers.length = 0
    await $.turn.complete(end)
    await clock.settle()
    expect(offers).toEqual([])
    await clock.advance(3_600_000)
    await $.turn.complete(end)
    await clock.settle()
    expect(offers).toEqual(["Claude's quota has reset. Go back to Claude?"])
    expect(calls.filter(one => one.url.endsWith('/__nexus/route')).map(one => (one.body as { route: string }).route)).toEqual(['myhub', 'claude'])
  })
})

describe('the router watcher and held requests', () => {
  const LIMIT = { type: 'limit', id: 'h1', window: 'five_hour', resetsAt: 9_000_000 }
  const decisions = (calls: { url: string; body: unknown }[]) => calls.filter(one => one.url.endsWith('/__nexus/decision')).map(one => one.body)
  const routes = (calls: { url: string; body: unknown }[]) => calls.filter(one => one.url.endsWith('/__nexus/route')).map(one => (one.body as { route: string }).route)
  const polls = (calls: { url: string }[]) => calls.filter(one => one.url.includes('/__nexus/events')).length
  async function settled(calls: { url: string }[], clock: { settle: () => Promise<void> }): Promise<void> {
    for (let i = 0; i < 50 && !calls.some(one => one.url.endsWith('/__nexus/decision')); i++) await clock.settle()
  }

  test('a limit while the context is past 80% of the hub window: no compaction ask, route then retry', { options: { ...BASE_OPTIONS, fallbackMode: 'auto' } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const events: unknown[][] = []
    const { calls, clock } = routerEnv(on, events)
    let asked = ''
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      asked = e.questions[0]?.question ?? ''
      return { result: { questions: e.questions, answers: { [asked]: 'Cancel' } } }
    })
    on('session.measure', (_, e) => ({ changed: e.changed }))
    await $.session.start?.(START as never)
    await clock.settle()
    await $.session.measure({ context: { tokens: 900_000, window: 1_000_000, percent: 90 }, rateLimits: [], changed: ['context'] } as never)
    events.push([LIMIT])
    await clock.advance(2000)
    await settled(calls, clock)
    expect(asked).toBe('')
    expect(routes(calls)).toEqual(['myhub'])
    expect(decisions(calls)).toEqual([{ id: 'h1', action: 'retry' }])
    // The route POST came before the decision.
    expect(calls.findIndex(one => one.url.endsWith('/__nexus/route'))).toBeLessThan(calls.findIndex(one => one.url.endsWith('/__nexus/decision')))
  })

  test('a route event keeps the badge true, whoever changed the route', { options: { ...BASE_OPTIONS, fallbackMode: 'off' } }, async ($, on) => {
    mock.store(on)
    const events: unknown[][] = []
    const { clock, written } = routerEnv(on, events)
    await $.session.start?.(START as never)
    await clock.settle()
    events.push([{ type: 'route', route: 'myhub', model: 'antigravity/gemini-3.8-flash-tiered' }])
    await clock.advance(2000)
    await clock.settle()
    expect(written.of('provider').at(-1)?.value).toMatchObject({ route: 'myhub', model: 'antigravity/gemini-3.8-flash-tiered' })
    events.push([{ type: 'route', route: 'claude' }])
    await clock.advance(4000)
    await clock.settle()
    expect(written.of('provider').at(-1)?.value).toMatchObject({ route: 'claude', model: null })
  })

  test('a start after a reload takes over: only the newest loop polls and decides', { options: { ...BASE_OPTIONS, fallbackMode: 'off' } }, async ($, on) => {
    mock.store(on)
    const events: unknown[][] = []
    const { calls, clock } = routerEnv(on, events)
    await $.session.start?.(START as never)
    await $.session.start?.(START as never)
    await clock.settle()
    const before = polls(calls)
    // Both loops wake at 2 s; the older one finds it is no longer the newest and ends without polling.
    await clock.advance(2000)
    expect(polls(calls) - before).toBe(1)
    events.push([LIMIT])
    await clock.advance(4000)
    await settled(calls, clock)
    expect(decisions(calls)).toEqual([{ id: 'h1', action: 'release' }])
  })

  test('an error while handling a limit still releases the held request', { options: { ...BASE_OPTIONS, fallbackMode: 'auto' } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const events: unknown[][] = []
    const { calls, clock, net } = routerEnv(on, events)
    await $.session.start?.(START as never)
    await clock.settle()
    net.failKey = 'provider'
    events.push([LIMIT])
    await clock.advance(2000)
    await settled(calls, clock)
    expect(decisions(calls)).toEqual([{ id: 'h1', action: 'release' }])
  })

  test('already on a hub: the held request is retried at once, nothing asked or switched', { options: { ...BASE_OPTIONS, fallbackMode: 'ask' } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const events: unknown[][] = []
    const { calls, clock } = routerEnv(on, events)
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      asked = true
      return { result: {} as never }
    })
    await $.session.start?.(START as never)
    await clock.settle()
    await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    events.push([LIMIT])
    await clock.advance(2000)
    await settled(calls, clock)
    expect(decisions(calls)).toEqual([{ id: 'h1', action: 'retry' }])
    expect(routes(calls)).toEqual(['myhub'])
    expect(asked).toBe(false)
  })

  test('the quota question offers the switch only while on Claude', { options: { ...BASE_OPTIONS, quotaGuard: 90 } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const { clock } = routerEnv(on)
    const choices: string[][] = []
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      choices.push((e.questions[0]?.options ?? []).map(one => one.label))
      return { result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Keep going' } } }
    })
    on('session.measure', (_, e) => ({ changed: e.changed }))
    on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
    await $.session.start?.(START as never)
    await clock.settle()
    await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    await $.turn.start({ turnId: 't1' } as never)
    await $.session.measure({
      context: { tokens: 1000, window: 1_000_000, percent: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(3_600_000).toISOString() }],
      changed: ['rateLimits'],
    } as never)
    await clock.settle()
    expect(choices).toEqual([['Keep going', 'Stop this turn']])
  })

  test('going back to Claude by hand cancels the later offer', { options: { ...BASE_OPTIONS, fallbackMode: 'auto' } }, async ($, on) => {
    mock.store(on, { providers: [MYHUB] })
    const events: unknown[][] = []
    const { calls, clock } = routerEnv(on, events)
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      asked = true
      return { result: {} as never }
    })
    on('turn.complete', (_, e) => ({ text: e.answer }))
    await $.session.start?.(START as never)
    await clock.settle()
    events.push([{ ...LIMIT, resetsAt: 60_000 }])
    await clock.advance(2000)
    await settled(calls, clock)
    await $.command.run({ command: 'provider-nexus', args: 'use claude' } as never)
    await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    await clock.advance(60_000)
    await $.turn.complete({ answer: 'Done.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()
    expect(asked).toBe(false)
  })

  test('the watcher keeps polling a router that does not answer, pausing longer each time, and still hears it later', { options: { ...BASE_OPTIONS, fallbackMode: 'off' } }, async ($, on) => {
    mock.store(on)
    const events: unknown[][] = []
    const { calls, clock } = routerEnv(on, events)
    await $.session.start?.(START as never)
    await clock.settle()
    expect(polls(calls)).toBe(1)
    // 2 s, 4 s, 8 s, 16 s, 30 s, 30 s: a seventh poll, well past five failures.
    for (const pause of [2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      const seen = polls(calls)
      await clock.advance(pause - 1)
      expect(polls(calls)).toBe(seen)
      await clock.advance(1)
      expect(polls(calls)).toBe(seen + 1)
    }
    events.push([LIMIT])
    await clock.advance(30_000)
    await settled(calls, clock)
    expect(decisions(calls)).toEqual([{ id: 'h1', action: 'release' }])
  })
})
