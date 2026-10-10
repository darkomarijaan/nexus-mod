// Nexus provider router: Claude Code talks to this local server, which sends
// each request on to api.anthropic.com (the claude.ai login) or to the active
// hub profile (its key, its models). Nexus steers it through /__nexus/*.
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomUUID, timingSafeEqual } from 'node:crypto'

import { claudeHeaders, hostAllowed, hubHeaders, hubModel, hubTarget, isInference, planLimit, routeFor, toHubBody, withSafeToolIds } from './route-core.mjs'

const same = (given, expected) => {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(expected)

  return a.length === b.length && timingSafeEqual(a, b)
}

const readAll = stream =>
  new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })

const json = (res, status, value) => {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
}

// An error Claude Code reads like the API's own.
const apiError = (res, status, message) => json(res, status, { type: 'error', error: { type: 'api_error', message: `Nexus router: ${message}` } })

function send(target, method, headers, body, signal) {
  const url = new URL(target)
  const open = url.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise((resolve, reject) => {
    const req = open(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : url.port,
        method,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host, ...(body.length > 0 ? { 'content-length': String(body.length) } : {}) },
        signal,
      },
      resolve,
    )
    req.on('error', reject)
    req.end(body.length > 0 ? body : undefined)
  })
}

function pipe(upstream, res, abort) {
  res.writeHead(upstream.statusCode ?? 502, upstream.headers)
  upstream.pipe(res)
  res.on('close', () => {
    if (!res.writableFinished) abort()
  })
}

const validProfile = profile =>
  profile !== null &&
  typeof profile === 'object' &&
  typeof profile.hubUrl === 'string' &&
  /^https?:\/\/[^\s/]+/.test(profile.hubUrl) &&
  typeof profile.apiKey === 'string' &&
  profile.apiKey !== '' &&
  hubModel('claude-sonnet', profile.models) !== undefined

export async function startRouter({ token, controlToken, anthropic = 'https://api.anthropic.com', holdMs = 120_000, log = () => {}, debug = false }) {
  const state = { route: 'claude', profile: null, usedHub: false, counts: { claude: 0, hub: 0 } }
  const held = new Map()
  const events = []
  const waiters = new Set()

  const emit = event => {
    events.push(event)
    for (const wake of waiters) wake()
  }

  async function toHub(req, res, body) {
    const profile = state.profile
    if (profile === null) return apiError(res, 503, 'no hub profile is active; switch with /provider-nexus')
    state.counts.hub += 1
    state.usedHub = true
    const parsed = body.length > 0 ? JSON.parse(body.toString('utf8')) : {}
    const out = Buffer.from(JSON.stringify(toHubBody(parsed, profile.models)))
    const abort = new AbortController()
    let upstream
    try {
      upstream = await send(hubTarget(profile.hubUrl, req.url), req.method, hubHeaders(req.headers, profile.apiKey), out, abort.signal)
    } catch (error) {
      emit({ type: 'upstream-error', route: state.route, status: 502 })
      return apiError(res, 502, `the hub "${state.route}" could not be reached (${error.code ?? error.message})`)
    }
    if ((upstream.statusCode ?? 502) >= 400) emit({ type: 'upstream-error', route: state.route, status: upstream.statusCode })
    log(`${req.method} ${req.url} -> hub:${state.route} ${upstream.statusCode}`)
    pipe(upstream, res, () => abort.abort())
  }

  async function toClaude(req, res, body) {
    state.counts.claude += 1
    let payload = body
    if (state.usedHub && body.length > 0 && String(req.headers['content-type'] ?? '').includes('json')) {
      const parsed = JSON.parse(body.toString('utf8'))
      const safe = withSafeToolIds(parsed)
      if (safe !== parsed) payload = Buffer.from(JSON.stringify(safe))
    }
    const abort = new AbortController()
    let upstream
    try {
      upstream = await send(`${anthropic}${req.url}`, req.method, claudeHeaders(req.headers), payload, abort.signal)
    } catch (error) {
      return apiError(res, 502, `api.anthropic.com could not be reached (${error.code ?? error.message})`)
    }
    if (debug) {
      const unified = Object.entries(upstream.headers).filter(([name]) => name.startsWith('anthropic-ratelimit-unified-'))
      if (unified.length > 0) log(`unified ${upstream.statusCode} ${unified.map(([name, value]) => `${name}=${value}`).join(' ')}`)
    }
    log(`${req.method} ${req.url} -> claude ${upstream.statusCode}`)
    const limit = isInference(req.method, req.url) ? planLimit(upstream.statusCode, upstream.headers) : null
    if (limit === null) return pipe(upstream, res, () => abort.abort())

    // A plan limit: hold the request while Nexus asks where it should go.
    const rejected = await readAll(upstream)
    const id = randomUUID()
    const decision = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ action: 'release' }), holdMs)
      held.set(id, one => {
        clearTimeout(timer)
        resolve(one)
      })
      emit({ type: 'limit', id, window: limit.window, resetsAt: limit.resetsAt })
    })
    held.delete(id)
    if (res.destroyed) return
    if (decision.action === 'retry' && state.profile !== null && state.route !== 'claude') return toHub(req, res, body)
    res.writeHead(upstream.statusCode ?? 429, upstream.headers).end(rejected)
  }

  async function control(req, res, path) {
    const body = req.method === 'POST' ? await readAll(req) : Buffer.alloc(0)
    const input = body.length > 0 ? JSON.parse(body.toString('utf8')) : {}
    const [bare, query = ''] = path.split('?')
    if (req.method === 'GET' && bare === '/__nexus/status') {
      const model = state.route === 'claude' || state.profile === null ? null : hubModel('claude-opus', state.profile.models) ?? null
      return json(res, 200, { route: state.route, model, counts: state.counts, held: [...held.keys()] })
    }
    if (req.method === 'POST' && bare === '/__nexus/route') {
      if (input.route === 'claude') {
        state.route = 'claude'
        return json(res, 200, { ok: true, route: 'claude' })
      }
      if (typeof input.route !== 'string' || input.route === '' || !validProfile(input.profile)) return json(res, 400, { error: 'route needs a name and a profile with hubUrl, apiKey and a model' })
      state.route = input.route
      state.profile = { hubUrl: input.profile.hubUrl, apiKey: input.profile.apiKey, models: input.profile.models }
      return json(res, 200, { ok: true, route: state.route })
    }
    if (req.method === 'GET' && bare === '/__nexus/events') {
      const wait = Math.min(30, Math.max(0, Number(new URLSearchParams(query).get('wait') ?? 0))) * 1000
      if (events.length === 0 && wait > 0) {
        await new Promise(resolve => {
          const wake = () => {
            waiters.delete(wake)
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(wake, wait)
          waiters.add(wake)
        })
      }
      return json(res, 200, { events: events.splice(0) })
    }
    if (req.method === 'POST' && bare === '/__nexus/decision') {
      const decide = held.get(input.id)
      if (decide === undefined) return json(res, 404, { error: 'unknown id' })
      decide({ action: input.action === 'retry' ? 'retry' : 'release' })
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'not found' })
  }

  const server = createServer(async (req, res) => {
    try {
      const port = server.address().port
      if (!hostAllowed(req.headers.host, port)) return json(res, 403, { error: 'forbidden' })
      const kind = routeFor(req.method, req.url, state.route)
      if (kind === 'control') {
        if (!same(req.headers['x-nexus-control'], controlToken)) return json(res, 401, { error: 'unauthorized' })
        return await control(req, res, req.url)
      }
      if (!same(req.headers['x-nexus-router'], token)) return json(res, 401, { error: 'unauthorized' })
      const body = await readAll(req)
      return kind === 'hub' ? await toHub(req, res, body) : await toClaude(req, res, body)
    } catch (error) {
      log(`error ${error.message}`)
      if (!res.headersSent) apiError(res, 502, error.message)
      else res.destroy()
    }
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    port: server.address().port,
    close: () =>
      new Promise(resolve => {
        for (const decide of held.values()) decide({ action: 'release' })
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
