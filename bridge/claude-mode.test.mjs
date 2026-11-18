import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classify, costOf, createClaudeMode, createUsageTap, escalationReason, parsePrices, readTurn } from './claude-mode.mjs'

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
