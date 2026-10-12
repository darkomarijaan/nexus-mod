import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer, request } from 'node:http'

import { startRouter } from './router.mjs'

const TOKEN = 't'.repeat(64)
const CONTROL = 'c'.repeat(64)
let anthropic, hub, router
const seen = { anthropic: [], hub: [] }
let anthropicMode = 'ok'
let hubMode = 'ok'
let hangClosed = false
// Hub models that answer 503, or whose connection drops, in the model-fallback tests.
const hubFails = new Set()
const hubDrops = new Set()

function fake(name, handler) {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        seen[name].push({ method: req.method, url: req.url, headers: req.headers, body })
        handler(req, res, body)
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function sse(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed' })
  res.write('event: message_start\ndata: {}\n\n')
  setTimeout(() => {
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ text })}\n\n`)
    res.end('event: message_stop\ndata: {}\n\n')
  }, 50)
}

// A stream that starts and then dies, as when the upstream crashes mid-answer.
function truncate(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('event: message_start\ndata: {}\n\n')
  setTimeout(() => res.socket.destroy(), 30)
}

function call({ method = 'POST', path = '/v1/messages?beta=true', headers = {}, body, host }) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: router.port, method, path, headers: { host: host ?? `127.0.0.1:${router.port}`, ...headers } },
      res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
      },
    )
    req.on('error', reject)
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}

const inference = (extra = {}) => ({
  headers: {
    'x-nexus-router': TOKEN,
    'content-type': 'application/json',
    authorization: 'Bearer oauth-secret',
    'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14',
    ...extra,
  },
  body: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
})
const control = (path, method = 'GET', body) => call({ method, path, headers: { 'x-nexus-control': CONTROL, 'content-type': 'application/json' }, body })
const PROFILE = { hubUrl: '', apiKey: 'hub-key', models: { opus: 'big' }, contextWindow: 128000 }

before(async () => {
  anthropic = await fake('anthropic', (req, res) => {
    if (anthropicMode === 'limit') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': '1790000000',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      })
      return res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}')
    }
    if (anthropicMode === 'truncate') return truncate(res)
    if (anthropicMode === 'hang') return void req.socket.once('close', () => (hangClosed = true))
    sse(res, 'from-claude')
  })
  hub = await fake('hub', (req, res, body) => {
    const asked = body === '' ? undefined : JSON.parse(body).model
    if (hubDrops.has(asked)) return res.socket.destroy()
    if (hubFails.has(asked)) {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end(`{"type":"error","error":{"type":"overloaded_error","message":"${asked} is down"}}`)
    }
    if (hubMode === 'truncate') return truncate(res)
    if (hubMode === 'echo') {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: `invalid key ${req.headers['x-api-key']} given` } }))
    }
    if (hubMode === 'big') {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(`${req.headers['x-api-key']}${'x'.repeat(100_000)}`)
    }
    if (hubMode === 'missing') {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{"error":"not found"}')
    }
    sse(res, 'from-hub')
  })
  PROFILE.hubUrl = `http://127.0.0.1:${hub.address().port}/v1`
  router = await startRouter({ token: TOKEN, controlToken: CONTROL, anthropic: `http://127.0.0.1:${anthropic.address().port}`, holdMs: 400 })
})

after(async () => {
  await router.close()
  anthropic.close()
  hub.close()
})

test('the claude route passes OAuth and streams the answer through', async () => {
  anthropicMode = 'ok'
  const answer = await call(inference())
  assert.equal(answer.status, 200)
  assert.match(answer.text, /from-claude/)
  assert.match(answer.text, /message_stop/)
  const last = seen.anthropic.at(-1)
  assert.equal(last.headers.authorization, 'Bearer oauth-secret')
  assert.equal(last.headers['x-nexus-router'], undefined)
  assert.equal(answer.headers['anthropic-ratelimit-unified-status'], 'allowed')
})

test('requests without the token, with a foreign Host, or a wrong control token are refused', async () => {
  assert.equal((await call({ body: {} })).status, 401)
  assert.equal((await call({ ...inference(), host: 'evil.example' })).status, 403)
  assert.equal((await call({ method: 'GET', path: '/__nexus/status', headers: { 'x-nexus-control': 'wrong' } })).status, 401)
  assert.equal((await call({ method: 'GET', path: '/__nexus/status', headers: { 'x-nexus-router': TOKEN } })).status, 401)
})

test('the hub route swaps credentials and the model, and never leaks OAuth', async () => {
  assert.equal((await control('/__nexus/route', 'POST', { route: 'myhub', profile: PROFILE })).status, 200)
  const answer = await call(inference())
  assert.match(answer.text, /from-hub/)
  const last = seen.hub.at(-1)
  assert.equal(last.url, '/v1/messages?beta=true')
  assert.equal(last.headers.authorization, 'Bearer hub-key')
  assert.equal(last.headers['x-api-key'], 'hub-key')
  assert.equal(last.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14')
  assert.equal(JSON.stringify(last.headers).includes('oauth-secret'), false)
  assert.equal(JSON.parse(last.body).model, 'big')
  const status = JSON.parse((await control('/__nexus/status')).text)
  assert.equal(status.route, 'myhub')
  assert.equal(status.model, 'big')
  assert.equal(JSON.stringify(status).includes('hub-key'), false)
  await control('/__nexus/route', 'POST', { route: 'claude' })
})

test('a bad route request is refused', async () => {
  assert.equal((await control('/__nexus/route', 'POST', { route: 'x', profile: { hubUrl: 'ftp://x' } })).status, 400)
})

test('a plan-limit 429 is held, announced, and retried on the hub when asked', async () => {
  anthropicMode = 'limit'
  await control('/__nexus/route', 'POST', { route: 'claude' })
  await control('/__nexus/events?wait=0')
  const pending = call(inference())
  const events = JSON.parse((await control('/__nexus/events?wait=2')).text).events
  const limit = events.find(one => one.type === 'limit')
  assert.equal(limit.window, 'five_hour')
  assert.equal(limit.resetsAt, 1790000000000)
  await control('/__nexus/route', 'POST', { route: 'myhub', profile: PROFILE })
  assert.equal((await control('/__nexus/decision', 'POST', { id: limit.id, action: 'retry' })).status, 200)
  const answer = await pending
  assert.equal(answer.status, 200)
  assert.match(answer.text, /from-hub/)
  assert.equal((await control('/__nexus/decision', 'POST', { id: limit.id, action: 'retry' })).status, 404)
  await control('/__nexus/route', 'POST', { route: 'claude' })
})

test('a held 429 is released as it was, on refusal or after the hold time', async () => {
  anthropicMode = 'limit'
  await control('/__nexus/events?wait=0')
  const refused = call(inference())
  const limit = JSON.parse((await control('/__nexus/events?wait=2')).text).events.find(one => one.type === 'limit')
  await control('/__nexus/decision', 'POST', { id: limit.id, action: 'release' })
  const first = await refused
  assert.equal(first.status, 429)
  assert.match(first.text, /rate_limit_error/)
  const timedOut = await call(inference())
  assert.equal(timedOut.status, 429)
  await control('/__nexus/events?wait=0')
  anthropicMode = 'ok'
})

test('an unreachable hub answers 502 as an Anthropic error', async () => {
  const empty = await startRouter({ token: TOKEN, controlToken: CONTROL, anthropic: `http://127.0.0.1:${anthropic.address().port}` })
  const ask = (port, path, method, body, headers) =>
    new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      })
      req.end(JSON.stringify(body))
    })
  await ask(empty.port, '/__nexus/route', 'POST', { route: 'dead', profile: { ...PROFILE, hubUrl: 'http://127.0.0.1:9/v1' } }, { 'x-nexus-control': CONTROL })
  const down = await ask(empty.port, '/v1/messages', 'POST', { model: 'claude-opus-5-5', messages: [] }, { 'x-nexus-router': TOKEN })
  assert.equal(down.status, 502)
  assert.equal(JSON.parse(down.text).type, 'error')
  await empty.close()
})

test('a client that hangs up mid-stream leaves the router serving', async () => {
  anthropicMode = 'ok'
  await new Promise(resolve => {
    const req = request(
      { host: '127.0.0.1', port: router.port, method: 'POST', path: '/v1/messages', headers: { host: `127.0.0.1:${router.port}`, 'x-nexus-router': TOKEN } },
      res => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      },
    )
    req.end('{"model":"claude-opus-5-5","messages":[]}')
  })
  const next = await call(inference())
  assert.equal(next.status, 200)
})

const waitFor = async (check, ms = 2000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

// Opens a model request the test can hang up on; resolves when the connection ends, rejects if it never does.
function open(port = router.port) {
  const { headers, body } = inference()
  const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { host: `127.0.0.1:${port}`, ...headers } })
  const ended = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the client was left hanging')), 2000)
    req.on('error', () => {})
    req.on('close', () => {
      clearTimeout(timer)
      resolve({ complete: false })
    })
    req.on('response', res => {
      res.on('error', () => {})
      res.on('close', () => {
        clearTimeout(timer)
        resolve({ complete: res.complete })
      })
      res.resume()
    })
  })
  req.end(JSON.stringify(body))
  return { req, ended }
}

test('a stream the upstream cuts short ends for the client on the claude route', async () => {
  anthropicMode = 'truncate'
  assert.equal((await open().ended).complete, false)
  anthropicMode = 'ok'
  assert.equal((await call(inference())).status, 200)
})

test('a stream the upstream cuts short ends for the client on the hub route', async () => {
  await control('/__nexus/route', 'POST', { route: 'myhub', profile: PROFILE })
  hubMode = 'truncate'
  assert.equal((await open().ended).complete, false)
  hubMode = 'ok'
  assert.match((await call(inference())).text, /from-hub/)
  await control('/__nexus/route', 'POST', { route: 'claude' })
})

test('a client that leaves before the upstream answers cancels the upstream request', async () => {
  anthropicMode = 'hang'
  hangClosed = false
  const { req } = open()
  await new Promise(resolve => setTimeout(resolve, 100))
  req.destroy()
  assert.equal(await waitFor(() => hangClosed), true)
  anthropicMode = 'ok'
})

test('a client that leaves while its 429 is held frees the hold', async () => {
  await control('/__nexus/events?wait=0')
  anthropicMode = 'limit'
  const { req } = open()
  const limit = JSON.parse((await control('/__nexus/events?wait=2')).text).events.find(one => one.type === 'limit')
  assert.deepEqual(JSON.parse((await control('/__nexus/status')).text).held, [limit.id])
  req.destroy()
  assert.equal(await waitFor(async () => JSON.parse((await control('/__nexus/status')).text).held.length === 0), true)
  assert.equal((await control('/__nexus/decision', 'POST', { id: limit.id, action: 'retry' })).status, 404)
  anthropicMode = 'ok'
})

test('malformed JSON is a 400 that never quotes the body, in the answer or the log', async () => {
  const lines = []
  const quiet = await startRouter({ token: TOKEN, controlToken: CONTROL, anthropic: `http://127.0.0.1:${anthropic.address().port}`, log: line => lines.push(line) })
  const ask = (path, headers, body) =>
    new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port: quiet.port, method: 'POST', path, headers: { host: `127.0.0.1:${quiet.port}`, ...headers } }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      })
      req.end(body)
    })
  const bad = '{"apiKey":"SECRET-BODY-TEXT",'
  const onControl = await ask('/__nexus/route', { 'x-nexus-control': CONTROL }, bad)
  assert.equal(onControl.status, 400)
  assert.equal(typeof JSON.parse(onControl.text).error, 'string')
  await ask('/__nexus/route', { 'x-nexus-control': CONTROL }, JSON.stringify({ route: 'myhub', profile: PROFILE }))
  const onHub = await ask('/v1/messages', { 'x-nexus-router': TOKEN }, bad)
  assert.equal(onHub.status, 400)
  assert.equal(JSON.parse(onHub.text).type, 'error')
  for (const text of [onControl.text, onHub.text, ...lines]) assert.equal(text.includes('SECRET'), false)
  await quiet.close()
})

test('every request is logged with method, path, status, route and duration, and failures with their code', async () => {
  const lines = []
  const logged = await startRouter({ token: TOKEN, controlToken: CONTROL, anthropic: `http://127.0.0.1:${anthropic.address().port}`, log: line => lines.push(line) })
  const ask = (path, headers, body) =>
    new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port: logged.port, method: 'POST', path, headers: { host: `127.0.0.1:${logged.port}`, ...headers } }, res => {
        res.resume()
        res.on('close', resolve)
      })
      req.end(JSON.stringify(body))
    })
  const model = { model: 'claude-opus-5-5', messages: [] }
  await ask('/v1/messages?beta=true', { 'x-nexus-router': TOKEN, authorization: 'Bearer oauth-secret' }, model)
  await ask('/__nexus/route', { 'x-nexus-control': CONTROL }, { route: 'dead', profile: { ...PROFILE, hubUrl: 'http://127.0.0.1:9/v1' } })
  await ask('/v1/messages', { 'x-nexus-router': TOKEN, authorization: 'Bearer oauth-secret' }, model)
  assert.match(lines[0], /^POST \/v1\/messages -> claude 200 \d+ms$/)
  assert.match(lines[1], /^POST \/v1\/messages -> hub:dead 502 \d+ms \w+$/)
  assert.equal(lines.length, 2)
  assert.equal(lines.join('\n').includes('oauth-secret'), false)
  await logged.close()
})

test('a router refuses to start without real tokens', async () => {
  await assert.rejects(startRouter({ token: '', controlToken: CONTROL }))
  await assert.rejects(startRouter({ token: TOKEN, controlToken: '' }))
  await assert.rejects(startRouter({ token: undefined, controlToken: CONTROL }))
  await assert.rejects(startRouter({ token: TOKEN, controlToken: 42 }))
})

test('closing the router ends pending long polls so the process can exit', async () => {
  const script = `
    import { request } from 'node:http'
    import { startRouter } from ${JSON.stringify(new URL('./router.mjs', import.meta.url).href)}
    const router = await startRouter({ token: 'a', controlToken: 'b' })
    const poll = request({ host: '127.0.0.1', port: router.port, path: '/__nexus/events?wait=30', headers: { host: '127.0.0.1:' + router.port, 'x-nexus-control': 'b' } }, res => res.resume())
    poll.on('error', () => {})
    poll.end()
    setTimeout(() => router.close(), 150)
  `
  const started = Date.now()
  await new Promise((resolve, reject) =>
    execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 }, error => (error === null ? resolve() : reject(error))),
  )
  assert.ok(Date.now() - started < 5000)
})

const drain = async () => JSON.parse((await control('/__nexus/events?wait=0')).text).events

test('a 401 or 403 is an Anthropic-shaped error that names the router token, and the debug log notes it without any token', async () => {
  const lines = []
  const loud = await startRouter({ token: TOKEN, controlToken: CONTROL, anthropic: `http://127.0.0.1:${anthropic.address().port}`, log: line => lines.push(line), debug: true })
  const ask = (path, host, headers = {}) =>
    new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port: loud.port, method: 'POST', path, headers: { host: host ?? `127.0.0.1:${loud.port}`, ...headers } }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      })
      req.end('{}')
    })
  const noToken = await ask('/v1/messages?beta=true', undefined, { 'x-nexus-router': 'wrong-token-value' })
  assert.equal(noToken.status, 401)
  const shaped = JSON.parse(noToken.text)
  assert.equal(shaped.type, 'error')
  assert.match(shaped.error.message, /Nexus router token/)
  assert.match(shaped.error.message, /ANTHROPIC_CUSTOM_HEADERS/)
  assert.match(shaped.error.message, /ANTHROPIC_BASE_URL/)
  const foreign = await ask('/v1/messages', 'evil.example', { 'x-nexus-router': TOKEN })
  assert.equal(foreign.status, 403)
  assert.equal(JSON.parse(foreign.text).type, 'error')
  assert.equal((await ask('/__nexus/route', undefined, { 'x-nexus-control': 'nope' })).status, 401)
  assert.equal(lines.includes('POST /v1/messages -> refused 401 token'), true)
  assert.equal(lines.includes('POST /v1/messages -> refused 403 host'), true)
  assert.equal(lines.includes('POST /__nexus/route -> refused 401 token'), true)
  const all = lines.join('\n')
  for (const secret of [TOKEN, CONTROL, 'wrong-token-value', 'nope']) assert.equal(all.includes(secret), false)
  await loud.close()
})

test('a count_tokens 404 from the hub is not announced as a hub error; a failed model request is', async () => {
  await control('/__nexus/route', 'POST', { route: 'myhub', profile: PROFILE })
  await drain()
  hubMode = 'missing'
  const counted = await call({ ...inference(), path: '/v1/messages/count_tokens' })
  assert.equal(counted.status, 404)
  assert.deepEqual(await drain(), [])
  await call(inference())
  assert.deepEqual(await drain(), [{ type: 'upstream-error', route: 'myhub', status: 404 }])
  hubMode = 'ok'
  await control('/__nexus/route', 'POST', { route: 'claude' })
  await drain()
})

test('a route change emits a route event, with the model and never the key', async () => {
  await drain()
  await control('/__nexus/route', 'POST', { route: 'myhub', profile: PROFILE })
  await control('/__nexus/route', 'POST', { route: 'claude' })
  const events = await drain()
  assert.deepEqual(events, [
    { type: 'route', route: 'myhub', model: 'big' },
    { type: 'route', route: 'claude' },
  ])
  assert.equal(JSON.stringify(events).includes('hub-key'), false)
})

test('a hub error body that echoes the key is masked before it reaches Claude Code', async () => {
  await control('/__nexus/route', 'POST', { route: 'myhub', profile: PROFILE })
  hubMode = 'echo'
  const echoed = await call(inference())
  assert.equal(echoed.status, 401)
  assert.equal(echoed.text.includes('hub-key'), false)
  assert.match(echoed.text, /invalid key \*\*\* given/)
  assert.equal(Number(echoed.headers['content-length']), Buffer.byteLength(echoed.text))
  hubMode = 'big'
  const big = await call(inference())
  assert.equal(big.status, 400)
  assert.equal(big.text.includes('hub-key'), false)
  assert.equal(Buffer.byteLength(big.text), 64 * 1024)
  hubMode = 'ok'
  await control('/__nexus/route', 'POST', { route: 'claude' })
  await drain()
})

test('a limit question is withdrawn when its hold settles before Nexus fetched it', async () => {
  await drain()
  anthropicMode = 'limit'
  const { req } = open()
  assert.equal(await waitFor(async () => JSON.parse((await control('/__nexus/status')).text).held.length === 1), true)
  req.destroy()
  assert.equal(await waitFor(async () => JSON.parse((await control('/__nexus/status')).text).held.length === 0), true)
  assert.deepEqual((await drain()).filter(one => one.type === 'limit'), [])
  anthropicMode = 'ok'
})

test('a plan-limit 429 passes straight through when Nexus has not polled lately, and is held when it has', async () => {
  anthropicMode = 'limit'
  const quick = await startRouter({ token: TOKEN, controlToken: CONTROL, anthropic: `http://127.0.0.1:${anthropic.address().port}`, holdMs: 3000, listenMs: 300 })
  const ask = (path, headers, method = 'POST', body = { model: 'claude-opus-5-5', messages: [] }) =>
    new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port: quick.port, method, path, headers: { host: `127.0.0.1:${quick.port}`, ...headers } }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      })
      req.end(method === 'GET' ? undefined : JSON.stringify(body))
    })
  const started = Date.now()
  const unheard = await ask('/v1/messages', { 'x-nexus-router': TOKEN })
  assert.equal(unheard.status, 429)
  assert.ok(Date.now() - started < 1500)
  await ask('/__nexus/events?wait=0', { 'x-nexus-control': CONTROL }, 'GET')
  const pending = ask('/v1/messages', { 'x-nexus-router': TOKEN })
  const events = JSON.parse((await ask('/__nexus/events?wait=2', { 'x-nexus-control': CONTROL }, 'GET')).text).events
  const limit = events.find(one => one.type === 'limit')
  assert.notEqual(limit, undefined)
  await ask('/__nexus/decision', { 'x-nexus-control': CONTROL }, 'POST', { id: limit.id, action: 'release' })
  assert.equal((await pending).status, 429)
  await quick.close()
  anthropicMode = 'ok'
})

const THREE = { opus: 'big', sonnet: 'mid', haiku: 'small' }
const hubModels = since => seen.hub.slice(since).map(one => JSON.parse(one.body).model)

async function withThree(modelFallback, run) {
  await control('/__nexus/route', 'POST', { route: 'myhub', profile: { ...PROFILE, models: THREE, modelFallback } })
  await drain()
  try {
    await run()
  } finally {
    hubFails.clear()
    hubDrops.clear()
    await control('/__nexus/route', 'POST', { route: 'claude' })
    await drain()
  }
}

test('each tier goes to its own hub model', async () => {
  await withThree(false, async () => {
    const since = seen.hub.length
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      await call({ ...inference(), body: { model, messages: [{ role: 'user', content: 'hi' }] } })
    }
    assert.deepEqual(hubModels(since), ['big', 'mid', 'small'])
  })
})

test('with model fallback on, a failing model is answered by the next one down, and Nexus is told', async () => {
  await withThree(true, async () => {
    hubFails.add('big')
    const since = seen.hub.length
    const answer = await call(inference())
    assert.equal(answer.status, 200)
    assert.match(answer.text, /from-hub/)
    assert.deepEqual(hubModels(since), ['big', 'mid'])
    assert.deepEqual(await drain(), [{ type: 'model-fallback', route: 'myhub', from: 'big', to: 'mid', status: 503 }])
  })
})

test('a dropped connection falls back too', async () => {
  await withThree(true, async () => {
    hubDrops.add('mid')
    const since = seen.hub.length
    const answer = await call({ ...inference(), body: { model: 'claude-sonnet-5-5', messages: [] } })
    assert.equal(answer.status, 200)
    assert.deepEqual(hubModels(since), ['mid', 'small'])
    assert.deepEqual(await drain(), [{ type: 'model-fallback', route: 'myhub', from: 'mid', to: 'small', status: 502 }])
  })
})

test('when every model fails, the last error reaches Claude Code and the hub error is announced once', async () => {
  await withThree(true, async () => {
    for (const one of ['big', 'mid', 'small']) hubFails.add(one)
    const since = seen.hub.length
    const answer = await call(inference())
    assert.equal(answer.status, 503)
    assert.match(answer.text, /small is down/)
    assert.deepEqual(hubModels(since), ['big', 'mid', 'small'])
    assert.deepEqual(await drain(), [
      { type: 'model-fallback', route: 'myhub', from: 'big', to: 'mid', status: 503 },
      { type: 'model-fallback', route: 'myhub', from: 'mid', to: 'small', status: 503 },
      { type: 'upstream-error', route: 'myhub', status: 503 },
    ])
  })
})

test('with model fallback off, a failing model is the answer', async () => {
  await withThree(false, async () => {
    hubFails.add('big')
    const since = seen.hub.length
    const answer = await call(inference())
    assert.equal(answer.status, 503)
    assert.deepEqual(hubModels(since), ['big'])
    assert.deepEqual(await drain(), [{ type: 'upstream-error', route: 'myhub', status: 503 }])
  })
})

test('a request the hub refuses as such (400) is not tried on another model', async () => {
  await withThree(true, async () => {
    hubMode = 'big'
    const since = seen.hub.length
    const answer = await call(inference())
    hubMode = 'ok'
    assert.equal(answer.status, 400)
    assert.deepEqual(hubModels(since), ['big'])
  })
})
