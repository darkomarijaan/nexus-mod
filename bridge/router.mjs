// Nexus provider router: Claude Code talks to this local server, which sends
// each request on to api.anthropic.com (the claude.ai login) or to the active
// hub profile (its key, its models). Nexus steers it through /__nexus/*.
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream'

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

// Thrown for a body that is not a JSON object; its message is fixed so no body text can leak.
class BadBody extends Error {}

const parseBody = buffer => {
  if (buffer.length === 0) return {}
  let value
  try {
    value = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new BadBody('request body is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BadBody('request body is not valid JSON')

  return value
}

const json = (res, status, value) => {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
}

// An error Claude Code reads like the API's own.
const apiError = (res, status, message, type = 'api_error') => json(res, status, { type: 'error', error: { type, message: `Nexus router: ${message}` } })

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

// pipeline ends the client's response, or destroys it, when the upstream dies mid-body.
function pipe(upstream, res, done) {
  res.writeHead(upstream.statusCode ?? 502, upstream.headers)
  pipeline(upstream, res, done)
}

const failure = error => (error ? (error.code ?? error.name) : undefined)

const validProfile = profile =>
  profile !== null &&
  typeof profile === 'object' &&
  typeof profile.hubUrl === 'string' &&
  /^https?:\/\/[^\s/]+/.test(profile.hubUrl) &&
  typeof profile.apiKey === 'string' &&
  profile.apiKey !== '' &&
  hubModel('claude-sonnet', profile.models) !== undefined

// A hub error body is read up to this size so the hub key can be masked in it.
const ERROR_BODY_MAX = 64 * 1024

// Reads at most `max` bytes of a stream (plus `extra`, so a key cut by the limit can still be found), then stops the rest.
const readCapped = (stream, max, extra) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    stream.on('data', chunk => {
      chunks.push(chunk)
      size += chunk.length
      if (size >= max + extra) {
        resolve(Buffer.concat(chunks))
        stream.destroy()
      }
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', error => (size >= max + extra ? resolve(Buffer.concat(chunks)) : reject(error)))
    stream.on('close', () => resolve(Buffer.concat(chunks)))
  })

const maskIn = (buffer, key) => Buffer.from(buffer.toString('utf8').split(key).join('***'))

export async function startRouter({
  token,
  controlToken,
  anthropic = 'https://api.anthropic.com',
  holdMs = 120_000,
  // A plan-limit 429 is held only if Nexus polled /__nexus/events within this long; otherwise nobody would decide it.
  listenMs = 35_000,
  log = () => {},
  debug = false,
}) {
  for (const secret of [token, controlToken]) {
    if (typeof secret !== 'string' || secret === '') throw new TypeError('startRouter needs a non-empty token and controlToken')
  }

  const state = { route: 'claude', profile: null, usedHub: false, counts: { claude: 0, hub: 0 } }
  const held = new Map()
  const events = []
  const waiters = new Set()
  let polledAt = Number.NEGATIVE_INFINITY
  const listening = () => waiters.size > 0 || Date.now() - polledAt <= listenMs

  const emit = event => {
    events.push(event)
    for (const wake of waiters) wake()
  }

  // One line per request: method, path (no query), route, status, duration, and the error code if any.
  // Never header or body text.
  const note = ({ req, started }, route, status, code) =>
    log(`${req.method} ${req.url.split('?')[0]} -> ${route} ${status} ${Math.round(performance.now() - started)}ms${code === undefined ? '' : ` ${code}`}`)

  async function toHub(ctx, body) {
    const { req, res, signal } = ctx
    const profile = state.profile
    if (profile === null) return apiError(res, 503, 'no hub profile is active; switch with /provider-nexus')
    const route = `hub:${state.route}`
    state.counts.hub += 1
    state.usedHub = true
    const out = Buffer.from(JSON.stringify(toHubBody(parseBody(body), profile.models)))
    let upstream
    try {
      upstream = await send(hubTarget(profile.hubUrl, req.url), req.method, hubHeaders(req.headers, profile.apiKey), out, signal)
    } catch (error) {
      note(ctx, route, 502, failure(error))
      if (signal.aborted) return
      emit({ type: 'upstream-error', route: state.route, status: 502 })
      return apiError(res, 502, `the hub "${state.route}" could not be reached (${error.code ?? 'unknown error'})`)
    }
    const status = upstream.statusCode ?? 502
    // count_tokens 404s are a hub's normal answer without that endpoint; only a failed model request is news.
    if (status >= 400 && isInference(req.method, req.url)) emit({ type: 'upstream-error', route: state.route, status })
    if (status >= 400 && !String(upstream.headers['content-type'] ?? '').includes('text/event-stream')) {
      // A hub may echo the key it was given in an error; it must not reach the transcript.
      let raw
      try {
        raw = await readCapped(upstream, ERROR_BODY_MAX, profile.apiKey.length)
      } catch (error) {
        note(ctx, route, status, failure(error))
        if (signal.aborted) return
        return apiError(res, 502, `the hub "${state.route}" closed the connection mid-answer`)
      }
      const masked = maskIn(raw, profile.apiKey).subarray(0, ERROR_BODY_MAX)
      const headers = { ...upstream.headers, 'content-length': String(masked.length) }
      delete headers['transfer-encoding']
      note(ctx, route, status)
      if (res.headersSent) return res.destroy()
      return void res.writeHead(status, headers).end(masked)
    }
    pipe(upstream, res, error => note(ctx, route, upstream.statusCode, failure(error)))
  }

  async function toClaude(ctx, body) {
    const { req, res, signal } = ctx
    state.counts.claude += 1
    let payload = body
    if (state.usedHub && body.length > 0 && String(req.headers['content-type'] ?? '').includes('json')) {
      const parsed = parseBody(body)
      const safe = withSafeToolIds(parsed)
      if (safe !== parsed) payload = Buffer.from(JSON.stringify(safe))
    }
    let upstream
    try {
      upstream = await send(`${anthropic}${req.url}`, req.method, claudeHeaders(req.headers), payload, signal)
    } catch (error) {
      note(ctx, 'claude', 502, failure(error))
      if (signal.aborted) return
      return apiError(res, 502, `api.anthropic.com could not be reached (${error.code ?? 'unknown error'})`)
    }
    if (debug) {
      const unified = Object.entries(upstream.headers).filter(([name]) => name.startsWith('anthropic-ratelimit-unified-'))
      if (unified.length > 0) log(`unified ${upstream.statusCode} ${unified.map(([name, value]) => `${name}=${value}`).join(' ')}`)
    }
    const limit = isInference(req.method, req.url) ? planLimit(upstream.statusCode, upstream.headers) : null
    // Nobody is listening for the question: let Claude Code see its 429 straight away.
    if (limit === null || !listening()) return pipe(upstream, res, error => note(ctx, 'claude', upstream.statusCode, failure(error)))

    // A plan limit: hold the request while Nexus asks where it should go.
    const rejected = await readAll(upstream).catch(() => null)
    note(ctx, 'claude', upstream.statusCode)
    if (signal.aborted) return
    if (rejected === null) return apiError(res, 502, 'api.anthropic.com closed the connection mid-answer')
    const id = randomUUID()
    const decision = await new Promise(resolve => {
      const settle = one => {
        clearTimeout(timer)
        signal.removeEventListener('abort', gone)
        held.delete(id)
        // The question is moot once the request is settled; drop it if Nexus has not fetched it yet.
        const queued = events.findIndex(event => event.type === 'limit' && event.id === id)
        if (queued !== -1) events.splice(queued, 1)
        resolve(one)
      }
      const gone = () => settle({ action: 'release' })
      const timer = setTimeout(gone, holdMs)
      signal.addEventListener('abort', gone, { once: true })
      held.set(id, settle)
      emit({ type: 'limit', id, window: limit.window, resetsAt: limit.resetsAt })
    })
    if (signal.aborted) return
    if (decision.action === 'retry' && state.profile !== null && state.route !== 'claude') return toHub(ctx, body)
    res.writeHead(upstream.statusCode ?? 429, upstream.headers).end(rejected)
  }

  async function control(req, res, path) {
    const body = req.method === 'POST' ? await readAll(req) : Buffer.alloc(0)
    const input = parseBody(body)
    const [bare, query = ''] = path.split('?')
    if (req.method === 'GET' && bare === '/__nexus/status') {
      const model = state.route === 'claude' || state.profile === null ? null : hubModel('claude-opus', state.profile.models) ?? null
      return json(res, 200, { route: state.route, model, counts: state.counts, held: [...held.keys()] })
    }
    if (req.method === 'POST' && bare === '/__nexus/route') {
      if (input.route === 'claude') {
        state.route = 'claude'
        emit({ type: 'route', route: 'claude' })
        return json(res, 200, { ok: true, route: 'claude' })
      }
      if (typeof input.route !== 'string' || input.route === '' || !validProfile(input.profile)) return json(res, 400, { error: 'route needs a name and a profile with hubUrl, apiKey and a model' })
      state.route = input.route
      state.profile = { hubUrl: input.profile.hubUrl, apiKey: input.profile.apiKey, models: input.profile.models }
      // Whoever changed the route, Nexus is told, so its badge says where requests really go.
      emit({ type: 'route', route: state.route, model: hubModel('claude-opus', state.profile.models) ?? null })
      return json(res, 200, { ok: true, route: state.route })
    }
    if (req.method === 'GET' && bare === '/__nexus/events') {
      polledAt = Date.now()
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
      polledAt = Date.now()
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

  // A refusal says what is wrong in the API's own shape; the debug log keeps method, path and the reason, never a token.
  const refuse = (req, res, status, reason) => {
    if (debug) log(`${req.method} ${req.url.split('?')[0]} -> refused ${status} ${reason}`)
    if (reason === 'host') return apiError(res, status, 'this request did not use the router address in its Host header; it was refused', 'permission_error')
    apiError(
      res,
      status,
      'this request did not carry the Nexus router token. Check the env in your settings.json for ANTHROPIC_CUSTOM_HEADERS or ANTHROPIC_BASE_URL, which override what claude-nexus sets.',
      'authentication_error',
    )
  }

  const server = createServer(async (req, res) => {
    const started = performance.now()
    // If the client goes away, whatever this request has open upstream goes with it.
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })
    let kind
    try {
      const port = server.address().port
      if (!hostAllowed(req.headers.host, port)) return refuse(req, res, 403, 'host')
      kind = routeFor(req.method, req.url, state.route)
      if (kind === 'control') {
        if (!same(req.headers['x-nexus-control'], controlToken)) return refuse(req, res, 401, 'token')
        return await control(req, res, req.url)
      }
      if (!same(req.headers['x-nexus-router'], token)) return refuse(req, res, 401, 'token')
      const body = await readAll(req)
      const ctx = { req, res, started, signal: abort.signal }
      return kind === 'hub' ? await toHub(ctx, body) : await toClaude(ctx, body)
    } catch (error) {
      // Only the kind of error is logged or answered: its message could quote request text.
      const bad = error instanceof BadBody
      log(`${req.method} ${req.url.split('?')[0]} -> ${bad ? 'rejected' : 'error'} ${failure(error)}`)
      if (res.headersSent) res.destroy()
      else if (!bad) apiError(res, 502, 'internal error')
      else if (kind === 'control') json(res, 400, { error: error.message })
      else apiError(res, 400, error.message, 'invalid_request_error')
    }
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    port: server.address().port,
    close: () =>
      new Promise(resolve => {
        for (const decide of held.values()) decide({ action: 'release' })
        for (const wake of [...waiters]) wake()
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
