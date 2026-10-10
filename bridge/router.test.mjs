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
  hub = await fake('hub', (req, res) => (hubMode === 'truncate' ? truncate(res) : sse(res, 'from-hub')))
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
