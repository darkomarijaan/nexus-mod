import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classify, costOf, createClaudeMode, createUsageTap, escalationReason, parsePrices, readTurn, shapeOf } from './claude-mode.mjs'

const TOOLS = [{ name: 'Bash' }]
const ask = (text, extra = {}) => ({ model: 'claude-sonnet-5-5', tools: TOOLS, messages: [{ role: 'user', content: text }], ...extra })
const tierFor = (text, mode = createClaudeMode()) => mode.plan(ask(text))?.tier

test('light questions go to haiku, everyday coding to sonnet, architecture to opus', () => {
  assert.equal(tierFor('apa itu closure?'), 'haiku')
  assert.equal(tierFor('fix typo in README'), 'haiku')
  assert.equal(tierFor('Implement a login endpoint with tests'), 'sonnet')
  assert.equal(tierFor('Tambah fungsi untuk validasi email di utils.ts'), 'sonnet')
  assert.equal(tierFor('Rancang arsitektur microservice untuk sistem pembayaran dan bahas trade-off-nya'), 'opus')
  assert.equal(tierFor('Debug the race condition in the worker pool'), 'opus')
})

test('system reminders do not count toward the score', () => {
  const body = ask([
    { type: 'text', text: '<system-reminder>architecture trade-off root cause deadlock</system-reminder>' },
    { type: 'text', text: 'apa itu closure?' },
  ])
  assert.equal(createClaudeMode().plan(body).tier, 'haiku')
})

test('helper calls without tools, and mode off, are left alone', () => {
  const mode = createClaudeMode()
  assert.equal(mode.plan({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }), null)
  assert.equal(mode.plan({ ...ask('hi'), tools: [] }), null)
  mode.configure({ mode: 'off' })
  assert.equal(mode.plan(ask('hi')), null)
})

test('manual mode overrides the router until auto returns', () => {
  const mode = createClaudeMode()
  mode.configure({ mode: 'opus' })
  assert.equal(mode.plan(ask('apa itu closure?')).model, 'claude-opus-5-5')
  assert.equal(mode.plan(ask('apa itu closure?')).reasons[0], 'manual')
  mode.configure({ mode: 'auto' })
  assert.equal(mode.plan(ask('apa itu closure?')).tier, 'haiku')
})

test('model ids are configurable and validated', () => {
  const mode = createClaudeMode()
  assert.equal(mode.configure({ models: { haiku: 'claude-haiku-4-5' } }), null)
  assert.equal(mode.plan(ask('apa itu closure?')).model, 'claude-haiku-4-5')
  assert.match(mode.configure({ models: { opus: 'bad id; drop' } }), /opus/)
  assert.match(mode.configure({ mode: 'turbo' }), /mode/)
  assert.match(mode.configure({ prices: 'nonsense' }), /prices/)
})

test('a turn keeps its model across tool results; a new message reclassifies', () => {
  const mode = createClaudeMode()
  const first = [{ role: 'user', content: 'apa itu closure?' }]
  assert.equal(mode.plan(ask('', { messages: first })).tier, 'haiku')
  const cont = [
    ...first,
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ]
  assert.equal(mode.plan(ask('', { messages: cont })).tier, 'haiku')
  const next = [...cont, { role: 'user', content: 'Rancang arsitektur sistem terdistribusi dan bahas trade-off' }]
  assert.equal(mode.plan(ask('', { messages: next })).tier, 'opus')
})

const failing = n => [
  { role: 'user', content: 'Implement a login endpoint with tests' },
  ...Array.from({ length: n }, (_, i) => [
    { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: true, content: 'boom' }] },
  ]).flat(),
]

test('escalation needs measured failures, is capped, and ignores length', () => {
  const mode = createClaudeMode()
  assert.equal(mode.plan(ask('', { messages: failing(0) })).tier, 'sonnet')
  assert.equal(mode.plan(ask('', { messages: failing(2) })).tier, 'sonnet')
  const up = mode.plan(ask('', { messages: failing(4) }))
  assert.equal(up.tier, 'opus')
  assert.deepEqual(up.escalation, { from: 'sonnet', to: 'opus', why: 'repeated-failures' })
  assert.equal(mode.plan(ask('', { messages: failing(6) })).escalation, null)
  const capped = createClaudeMode()
  capped.configure({ maxEscalations: 0 })
  capped.plan(ask('', { messages: failing(0) }))
  assert.equal(capped.plan(ask('', { messages: failing(5) })).tier, 'sonnet')
  assert.equal(escalationReason('sonnet', { failures: 0, toolCalls: 99, touched: 0 }), null)
  assert.equal(escalationReason('haiku', { failures: 2, toolCalls: 0, touched: 0 }), 'tool-failures')
})

test('haiku never takes a huge prompt, and the fallback chain is short, unique and ends on known models', () => {
  const mode = createClaudeMode()
  assert.equal(mode.plan(ask('apa itu closure?'), { bytes: 600_000 }).tier, 'sonnet')
  const chain = mode.plan(ask('apa itu closure?')).chain
  assert.equal(chain[0], 'claude-haiku-5-5')
  assert.equal(chain[1], 'claude-sonnet-5-5')
  assert.ok(chain.length <= 3 && new Set(chain).size === chain.length)
})

test('classify returns codes, never text', () => {
  const found = classify(readTurn([{ role: 'user', content: 'secret-token-123 apa itu closure?' }]))
  assert.equal(found.level, 'LIGHT')
  assert.ok(!JSON.stringify(found).includes('secret-token'))
})

test('usage is read from SSE and from plain JSON, and priced', () => {
  const tap = createUsageTap()
  const sse = 'event: message_start\ndata: {"message":{"usage":{"input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"usage":{"output_tokens":50}}\n\n'
  tap.push(Buffer.from(sse.slice(0, 60)))
  tap.push(Buffer.from(sse.slice(60)))
  assert.deepEqual(tap.result(), { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0 })
  const json = createUsageTap()
  json.push(Buffer.from('{"usage":{"input_tokens":10,"output_tokens":5}}'))
  assert.equal(json.result().output, 5)
  assert.equal(createUsageTap().result(), null)
  assert.equal(costOf({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, { in: 3, out: 15 }), 3)
  assert.deepEqual(parsePrices('opus=15/75, haiku=1/5'), { opus: { in: 15, out: 75 }, haiku: { in: 1, out: 5 } })
  assert.equal(parsePrices('opus=x'), null)
})

test('record keeps a bounded history with escalation and fallback status', () => {
  const mode = createClaudeMode({ now: () => 1 })
  const decision = mode.plan(ask('apa itu closure?'))
  for (let i = 0; i < 40; i += 1) mode.record(decision, { model: decision.model, status: 200, ms: 5, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, fallbacks: i === 0 ? [{ model: 'x', status: 404 }] : [] })
  const snap = mode.snapshot()
  assert.equal(snap.recent.length, 30)
  assert.equal(snap.totals.requests, 40)
  assert.equal(snap.totals.fallbacks, 1)
  assert.ok(snap.totals.cost > 0 && snap.totals.baseline > snap.totals.cost)
})

test('Claude Code command wrappers and their output do not count toward the score', () => {
  const wrapped = [
    '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>',
    '<command-name>/automodel-nexus</command-name><command-message>automodel-nexus</command-message><command-args></command-args>',
    '<local-command-stdout>nexus: HEAVY → claude-opus-5-5 [long,coding,light-words,risk,big-context] 200 1864ms error code delete production</local-command-stdout>',
    'jam berapa sekarang?',
  ].join('\n')
  assert.equal(readTurn([{ role: 'user', content: wrapped }]).text, 'jam berapa sekarang?')
  assert.equal(tierFor(wrapped), 'haiku')
})

test('a short question stays light in a long conversation; a large prompt still keeps haiku out', () => {
  const long = Array.from({ length: 90 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` }))
  const body = ask('', { messages: [...long, { role: 'user', content: 'apa itu closure?' }] })
  assert.equal(createClaudeMode().plan(body).tier, 'haiku')
  const reasons = createClaudeMode().plan(body).reasons
  assert.ok(!reasons.includes('big-context'))
  // the window guard is separate and unchanged
  assert.notEqual(createClaudeMode().plan(body, { bytes: 500_000 }).tier, 'haiku')
})

test('big context still nudges a message that is not short', () => {
  const text = 'Tolong periksa kenapa daftar pesanan kadang tampil dua kali setelah halaman dimuat ulang, lalu jelaskan penyebabnya dengan contoh yang jelas dan langkah yang perlu diambil untuk memperbaikinya di sisi tampilan maupun di sisi server kita.'
  const plain = classify({ text, toolCalls: 0, failures: 0, touched: 0, messages: 5 })
  const big = classify({ text, toolCalls: 0, failures: 0, touched: 0, messages: 90 })
  assert.equal(big.score, plain.score + 1)
  assert.ok(big.reasons.includes('big-context'))
})

test('a request shape holds counts and kinds only, never text', () => {
  const body = {
    model: 'claude-haiku-5-5',
    max_tokens: 64,
    stream: true,
    tools: [{ name: 'Bash' }, { name: 'Read' }],
    system: 'secret system prompt text',
    messages: [
      { role: 'user', content: 'private question text' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'private output' }] },
    ],
  }
  const shape = shapeOf(body)
  assert.deepEqual(shape, { messages: 3, tools: 2, maxTokens: 64, last: 'user/tool_result', stream: true, system: true })
  assert.ok(!JSON.stringify(shape).includes('private'))
  assert.deepEqual(shapeOf({ messages: 'nope' }), { messages: 0, tools: 0, maxTokens: null, last: null, stream: false, system: false })
})

test('a decision and its record carry the shape and the incoming model', () => {
  const mode = createClaudeMode()
  const body = ask('apa itu closure?', { model: 'claude-haiku-5-5', max_tokens: 32 })
  const decision = mode.plan(body)
  assert.equal(decision.shape.maxTokens, 32)
  assert.equal(decision.shape.last, 'user/text')
  const entry = mode.record(decision, { model: decision.model, status: 200, ms: 5, usage: null, fallbacks: [] })
  assert.equal(entry.incoming, 'claude-haiku-5-5')
  assert.deepEqual(entry.shape, decision.shape)
})

// ── Jev, the optional classifier ─────────────────────────────────────────
// A message the rules score 1 (MEDIUM, inside the gray zone 0 to 4).
const GRAY = 'Tambah fungsi untuk validasi email di utils.ts'
const answer = (level, probability = 0.9, confidence = 0.9) => ({
  ok: true,
  status: 200,
  body: { cancel: async () => {} },
  json: async () => ({ answers: { tier: { type: 'choice', choice: level, confidence, probabilities: { [level]: probability } } }, usage: { input_tokens: 100, output_tokens: 10 } }),
})
const jevFail = status => ({ ok: false, status, body: { cancel: async () => {} }, json: async () => ({}) })
const fakeFetch = (...replies) => {
  const fn = async (url, init) => {
    fn.calls.push({ url, init })
    const next = replies.length > 1 ? replies.shift() : replies[0]
    if (next instanceof Error) throw next

    return next
  }
  fn.calls = []

  return fn
}
const grayMode = (extra = {}, options = {}) => {
  const mode = createClaudeMode(options)
  assert.equal(mode.configure({ jev: { mode: 'gray', ...extra } }), null)

  return mode
}
const decide = async (mode, text, options = {}) => {
  const key = 'key' in options ? options.key : 'k-secret'
  const body = ask(text)
  const hint = await mode.consult(body, { key, fetch: options.fetch })

  return mode.plan(body, { hint })
}

test('without Jev (off, no key, empty key) nothing is asked and the rules decide as before', async () => {
  const fetch = fakeFetch(answer('HEAVY'))
  const off = createClaudeMode()
  assert.equal((await decide(off, GRAY, { fetch })).tier, 'sonnet')
  assert.equal((await decide(grayMode(), GRAY, { fetch, key: undefined })).tier, 'sonnet')
  assert.equal((await decide(grayMode(), GRAY, { fetch, key: '' })).tier, 'sonnet')
  assert.equal(fetch.calls.length, 0)
  assert.deepEqual((await decide(off, GRAY, { fetch })).reasons.filter(one => one.startsWith('jev')), [])
})

test('in the gray zone a confident answer sets the tier', async () => {
  const fetch = fakeFetch(answer('HEAVY'))
  const mode = grayMode()
  const plan = await decide(mode, GRAY, { fetch })
  assert.equal(plan.tier, 'opus')
  assert.ok(plan.reasons.includes('jev:HEAVY@0.90'))
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0].init.headers.authorization, 'Bearer k-secret')
  const { jev } = mode.snapshot({ keyPresent: true })
  assert.equal(jev.calls, 1)
  assert.equal(jev.used, 1)
  assert.equal(jev.tokensIn, 100)
})

test('clear cases are not asked', async () => {
  const fetch = fakeFetch(answer('HEAVY'))
  const mode = grayMode()
  assert.equal((await decide(mode, 'apa itu closure?', { fetch })).tier, 'haiku')
  assert.equal((await decide(mode, 'Rancang arsitektur microservice untuk sistem pembayaran dan bahas trade-off-nya', { fetch })).tier, 'opus')
  assert.equal(fetch.calls.length, 0)
})

test('a turn is asked once, however many requests it makes', async () => {
  const fetch = fakeFetch(answer('HEAVY'))
  const mode = grayMode()
  const body = ask(GRAY)
  const hint = await mode.consult(body, { key: 'k', fetch })
  mode.plan(body, { hint })
  assert.equal(await mode.consult(body, { key: 'k', fetch }), null)
  assert.equal(fetch.calls.length, 1)
})

test('a low-confidence answer leaves the decision to the rules', async () => {
  const mode = grayMode()
  const plan = await decide(mode, GRAY, { fetch: fakeFetch(answer('HEAVY', 0.5, 0.9)) })
  assert.equal(plan.tier, 'sonnet')
  assert.ok(plan.reasons.includes('jev-low-conf'))
  const plan2 = await decide(mode, GRAY + ' lagi', { fetch: fakeFetch(answer('HEAVY', 0.9, 0.3)) })
  assert.equal(plan2.tier, 'sonnet')
  assert.equal(mode.snapshot().jev.lowConf, 2)
})

test('a failed ask leaves the decision to the rules and says why in the reason codes', async () => {
  const mode = grayMode()
  const http = await decide(mode, GRAY, { fetch: fakeFetch(jevFail(500)) })
  assert.equal(http.tier, 'sonnet')
  assert.ok(http.reasons.includes('jev-http'))
  const late = await decide(mode, GRAY + ' b', { fetch: fakeFetch(Object.assign(new Error('t'), { name: 'TimeoutError' })) })
  assert.ok(late.reasons.includes('jev-timeout'))
  const odd = await decide(mode, GRAY + ' c', { fetch: fakeFetch({ ok: true, status: 200, json: async () => ({ nope: 1 }) }) })
  assert.ok(odd.reasons.includes('jev-shape'))
  const { jev } = mode.snapshot()
  assert.equal(jev.timeouts, 1)
  assert.equal(jev.errors, 2)
})

test('three failures in a row pause Jev for five minutes', async () => {
  let at = 1_000_000
  const mode = grayMode({}, { now: () => at })
  const fetch = fakeFetch(jevFail(500))
  for (const suffix of ['a', 'b', 'c']) await decide(mode, `${GRAY} ${suffix}`, { fetch })
  assert.equal(fetch.calls.length, 3)
  await decide(mode, `${GRAY} d`, { fetch })
  assert.equal(fetch.calls.length, 3)
  assert.equal(mode.snapshot().jev.paused, true)
  at += 5 * 60_000 + 1
  await decide(mode, `${GRAY} e`, { fetch })
  assert.equal(fetch.calls.length, 4)
})

test('a rejected key turns Jev off until the settings are given again', async () => {
  const mode = grayMode()
  const fetch = fakeFetch(jevFail(401))
  await decide(mode, GRAY, { fetch })
  assert.equal(mode.snapshot().jev.authFailed, true)
  await decide(mode, `${GRAY} b`, { fetch })
  assert.equal(fetch.calls.length, 1)
  mode.configure({ jev: { mode: 'gray' } })
  await decide(mode, `${GRAY} c`, { fetch })
  assert.equal(fetch.calls.length, 2)
})

test('a message that looks like a secret is never sent', async () => {
  const fetch = fakeFetch(answer('HEAVY'))
  const mode = grayMode()
  const plan = await decide(mode, `${GRAY} sk-abcdefghijklmnop1234`, { fetch })
  assert.equal(fetch.calls.length, 0)
  assert.equal(plan.tier, 'sonnet')
  assert.ok(plan.reasons.includes('jev-skip-secret'))
  assert.equal(mode.snapshot().jev.skipped, 1)
})

test('a risky message never drops below medium on Jev\'s word', async () => {
  const plan = await decide(grayMode(), 'Tambah fungsi untuk menghapus data di database', { fetch: fakeFetch(answer('LIGHT', 0.95, 0.95)) })
  assert.equal(plan.level, 'MEDIUM')
  assert.ok(plan.reasons.includes('risk-floor'))
})

test('manual and off modes never ask', async () => {
  const fetch = fakeFetch(answer('HEAVY'))
  const mode = grayMode()
  mode.configure({ mode: 'opus' })
  assert.equal(await mode.consult(ask(GRAY), { key: 'k', fetch }), null)
  mode.configure({ mode: 'off' })
  assert.equal(await mode.consult(ask(GRAY), { key: 'k', fetch }), null)
  assert.equal(fetch.calls.length, 0)
})

test('Jev settings are checked, and a bad one changes nothing', () => {
  const mode = createClaudeMode()
  for (const bad of [{ mode: 'maybe' }, { url: 'http://example.com/x' }, { timeoutMs: 10 }, { timeoutMs: 99_999 }, { keyEnv: 'a b' }, { model: 'bad id; drop' }, { minConfidence: 2 }]) {
    assert.match(mode.configure({ jev: bad }) ?? '', /jev/)
  }
  assert.equal(mode.snapshot().jev.mode, 'off')
  assert.equal(mode.configure({ jev: { mode: 'gray', timeoutMs: 1200, minConfidence: 0.4 } }), null)
  assert.equal(mode.snapshot().jev.mode, 'gray')
  assert.equal(mode.jevKeyEnv(), 'CMD_API_KEY')
})


test('a router given no Jev settings still works, and the snapshot never holds a key', async () => {
  const mode = createClaudeMode()
  assert.equal(mode.configure({ mode: 'auto', models: {} }), null)
  const snap = mode.snapshot({ keyPresent: true })
  assert.equal(snap.jev.mode, 'off')
  assert.equal(snap.jev.keyPresent, true)
  const busy = grayMode()
  await decide(busy, GRAY, { fetch: fakeFetch(answer('HEAVY')), key: 'k-secret' })
  assert.ok(!JSON.stringify(busy.snapshot({ keyPresent: true })).includes('k-secret'))
})


// ── Jev on every turn ────────────────────────────────────────────────────
const alwaysMode = (extra = {}, options = {}) => {
  const mode = createClaudeMode(options)
  assert.equal(mode.configure({ jev: { mode: 'always', ...extra } }), null)

  return mode
}

test('always: every turn is asked, clear cases too, and a confident answer decides', async () => {
  const fetch = fakeFetch(answer('MEDIUM'))
  const mode = alwaysMode()
  const light = await decide(mode, 'apa itu closure?', { fetch })
  assert.equal(fetch.calls.length, 1)
  assert.equal(light.tier, 'sonnet')
  assert.ok(light.reasons.includes('jev:MEDIUM@0.90'))
  const up = await decide(mode, 'Rancang arsitektur microservice untuk sistem pembayaran dan bahas trade-off-nya', { fetch: fakeFetch(answer('HEAVY')) })
  assert.equal(up.tier, 'opus')
  assert.equal(mode.snapshot().jev.mode, 'always')
  assert.equal(mode.snapshot().jev.calls, 2)
})

test('always: Jev never lowers the rules by more than one level', async () => {
  const mode = alwaysMode()
  const plan = await decide(mode, 'Rancang arsitektur microservice untuk sistem pembayaran dan bahas trade-off-nya', { fetch: fakeFetch(answer('LIGHT', 0.95, 0.95)) })
  assert.equal(plan.level, 'MEDIUM')
  assert.equal(plan.tier, 'sonnet')
  assert.ok(plan.reasons.includes('step-floor'))
  const down = await decide(mode, 'apa itu closure lagi?', { fetch: fakeFetch(answer('LIGHT', 0.95, 0.95)) })
  assert.equal(down.tier, 'haiku')
  assert.ok(!down.reasons.includes('step-floor'))
})

test('always: one question per turn, and the same safeguards as the gray zone', async () => {
  const fetch = fakeFetch(answer('MEDIUM'))
  const mode = alwaysMode()
  const body = ask('apa itu closure?')
  const hint = await mode.consult(body, { key: 'k', fetch })
  mode.plan(body, { hint })
  assert.equal(await mode.consult(body, { key: 'k', fetch }), null)
  assert.equal(fetch.calls.length, 1)
  assert.equal(await alwaysMode().consult(ask('apa itu closure?'), { key: undefined, fetch }), null)
  assert.equal(await alwaysMode().consult(ask('apa itu closure? sk-abcdefghijklmnop1234'), { key: 'k', fetch }).then(one => one.kind), 'secret')
  const manual = alwaysMode()
  manual.configure({ mode: 'haiku' })
  assert.equal(await manual.consult(ask('apa itu closure?'), { key: 'k', fetch }), null)
  assert.equal(fetch.calls.length, 1)
})

test('always can be set and is refused for a word that is not a mode', () => {
  const mode = createClaudeMode()
  assert.equal(mode.configure({ jev: { mode: 'always' } }), null)
  assert.equal(mode.snapshot().jev.mode, 'always')
  assert.match(mode.configure({ jev: { mode: 'sometimes' } }) ?? '', /off, gray or always/)
  assert.equal(mode.snapshot().jev.mode, 'always')
})

// ── A long conversation stays on the model it is cached on ───────────────
const deep = (text, earlier) => ask(text, { messages: [...Array.from({ length: earlier }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: i % 2 === 0 ? `earlier ${i}` : 'ok' })), { role: 'user', content: text }] })

test('a short conversation switches model freely', () => {
  const mode = createClaudeMode()
  assert.equal(mode.plan(deep('Implement a login endpoint with tests', 4)).tier, 'sonnet')
  assert.equal(mode.plan(deep('apa itu closure?', 6)).tier, 'haiku')
})

test('a long conversation does not drop one tier for a short question until it keeps asking', () => {
  const mode = createClaudeMode()
  assert.equal(mode.plan(deep('Implement a login endpoint with tests', 40)).tier, 'sonnet')
  const first = mode.plan(deep('apa itu closure?', 42))
  assert.equal(first.tier, 'sonnet')
  assert.ok(first.reasons.includes('sticky'))
  assert.equal(mode.plan(deep('apa itu closure lagi?', 44)).tier, 'sonnet')
  const third = mode.plan(deep('apa itu promise?', 46))
  assert.equal(third.tier, 'haiku')
  assert.ok(!third.reasons.includes('sticky'))
  // Once there, it is the new tier: no streak is carried over.
  assert.equal(mode.plan(deep('apa itu monad?', 48)).tier, 'haiku')
})

test('a long conversation still moves up at once, and a coding turn resets the streak', () => {
  const mode = createClaudeMode()
  assert.equal(mode.plan(deep('apa itu closure?', 40)).tier, 'haiku')
  assert.equal(mode.plan(deep('Implement a login endpoint with tests', 42)).tier, 'sonnet')
  assert.equal(mode.plan(deep('apa itu closure?', 44)).tier, 'sonnet')
  assert.equal(mode.plan(deep('Implement a signup endpoint with tests', 46)).tier, 'sonnet')
  assert.equal(mode.plan(deep('apa itu closure?', 48)).tier, 'sonnet')
  assert.equal(mode.plan(deep('apa itu promise?', 50)).tier, 'sonnet')
})

test('a long conversation drops two tiers at once', () => {
  const mode = createClaudeMode()
  assert.equal(mode.plan(deep('Rancang arsitektur microservice untuk sistem pembayaran dan bahas trade-off-nya', 40)).tier, 'opus')
  assert.equal(mode.plan(deep('apa itu closure?', 42)).tier, 'haiku')
})

test('a long conversation is told apart by size as well as by message count', () => {
  const mode = createClaudeMode()
  assert.equal(mode.plan(ask('Implement a login endpoint with tests'), { bytes: 200_000 }).tier, 'sonnet')
  assert.equal(mode.plan(ask('apa itu closure?', { messages: [{ role: 'user', content: 'apa itu closure?' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'apa itu promise?' }] }), { bytes: 200_000 }).tier, 'sonnet')
})
