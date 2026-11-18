import { test } from 'node:test'
import assert from 'node:assert/strict'

import { askJev, buildRequest, looksSecret, parseAnswer, trimForJev, validJevUrl, validKeyEnv } from './jev.mjs'

const GOOD = {
  model: 'typesafe/jev-1.14.0',
  answers: { tier: { type: 'choice', choice: 'HEAVY', confidence: 0.9, probabilities: { LIGHT: 0.02, MEDIUM: 0.08, HEAVY: 0.9 } } },
  usage: { input_tokens: 376, output_tokens: 41 },
}
const respond = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body, body: { cancel: async () => {} } })
const ask = fetch => askJev({ fetch, url: 'https://hub.example.com/systemone', key: 'k-123', model: 'typesafe/jev-1.14.0', text: 'hello', timeoutMs: 500 })

test('a good answer is read as level, confidence, probability and usage', () => {
  assert.deepEqual(parseAnswer(GOOD), { level: 'HEAVY', confidence: 0.9, probability: 0.9, usage: { input: 376, output: 41 } })
})

test('an answer of another shape is refused, not guessed at', () => {
  assert.equal(parseAnswer(null), null)
  assert.equal(parseAnswer({}), null)
  assert.equal(parseAnswer({ answers: { tier: { choice: 'EXTREME', confidence: 1, probabilities: { EXTREME: 1 } } } }), null)
  assert.equal(parseAnswer({ answers: { tier: { choice: 'LIGHT', confidence: 'high', probabilities: { LIGHT: 1 } } } }), null)
  assert.equal(parseAnswer({ answers: { tier: { choice: 'LIGHT', confidence: 1, probabilities: {} } } }), null)
  assert.deepEqual(parseAnswer({ answers: { tier: GOOD.answers.tier } }).usage, { input: 0, output: 0 })
})

test('a request holds the model, the trimmed message and one Choice of three levels', () => {
  const body = buildRequest('m', 'x'.repeat(5000))
  assert.equal(body.model, 'm')
  assert.ok(body.state.length < 2600)
  assert.deepEqual(Object.keys(body.questions.tier.criteria), ['LIGHT', 'MEDIUM', 'HEAVY'])
  assert.equal(trimForJev('short'), 'short')
  assert.ok(trimForJev('a'.repeat(2000) + 'b'.repeat(900) + 'c'.repeat(500)).endsWith('c'.repeat(500)))
})

test('messages that look like they hold a secret are caught', () => {
  assert.ok(looksSecret('here: sk-abcdefghijklmnop1234'))
  assert.ok(looksSecret('AKIAABCDEFGHIJKLMNOP'))
  assert.ok(looksSecret('token=abcdef1234567890'))
  assert.ok(looksSecret('-----BEGIN RSA PRIVATE KEY-----'))
  assert.ok(looksSecret('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'))
  assert.ok(!looksSecret('apa itu closure?'))
  assert.ok(!looksSecret('Tambah fungsi untuk validasi email di utils.ts'))
})

test('only an https address, or plain http on this machine, is taken', () => {
  assert.ok(validJevUrl('https://api.commandcode.ai/provider/v1/systemone'))
  assert.ok(validJevUrl('http://127.0.0.1:8080/x'))
  assert.ok(!validJevUrl('http://example.com/x'))
  assert.ok(!validJevUrl('https://user:pw@example.com/x'))
  assert.ok(!validJevUrl('ftp://example.com'))
  assert.ok(!validJevUrl('not a url'))
  assert.ok(validKeyEnv('CMD_API_KEY'))
  assert.ok(!validKeyEnv('1BAD'))
  assert.ok(!validKeyEnv('a b'))
})

test('the key travels in the header only, and redirects are not followed', async () => {
  let sent
  const result = await ask(async (url, init) => {
    sent = { url, init }

    return respond(200, GOOD)()
  })
  assert.equal(result.ok, true)
  assert.equal(result.level, 'HEAVY')
  assert.equal(sent.init.headers.authorization, 'Bearer k-123')
  assert.ok(!sent.init.body.includes('k-123'))
  assert.equal(sent.init.redirect, 'error')
})

test('every failure is a plain result with its kind', async () => {
  assert.deepEqual(await ask(respond(401, {})), { ok: false, kind: 'auth' })
  assert.deepEqual(await ask(respond(403, {})), { ok: false, kind: 'auth' })
  assert.deepEqual(await ask(respond(500, {})), { ok: false, kind: 'http' })
  assert.deepEqual(await ask(respond(200, { nope: 1 })), { ok: false, kind: 'shape' })
  assert.deepEqual(await ask(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } })), { ok: false, kind: 'shape' })
  assert.deepEqual(await ask(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) }), { ok: false, kind: 'timeout' })
  assert.deepEqual(await ask(async () => { throw new TypeError('fetch failed') }), { ok: false, kind: 'network' })
})

test('a real timeout ends the wait', async () => {
  const slow = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  const started = Date.now()
  const result = await askJev({ fetch: slow, url: 'https://hub.example.com/x', key: 'k', model: 'm', text: 't', timeoutMs: 200 })
  assert.deepEqual(result, { ok: false, kind: 'timeout' })
  assert.ok(Date.now() - started < 1500)
})
