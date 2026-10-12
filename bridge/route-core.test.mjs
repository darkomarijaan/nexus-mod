import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  claudeHeaders,
  hostAllowed,
  hubHeaders,
  hubModel,
  hubModelChain,
  hubTarget,
  isInference,
  isModelFailure,
  planLimit,
  routeFor,
  tierOf,
  toHubBody,
  withSafeToolIds,
} from './route-core.mjs'

const MODELS = { opus: 'big', haiku: 'small' }

test('a Claude model id maps to its tier, unknown ids to sonnet', () => {
  assert.equal(tierOf('claude-opus-5-5'), 'opus')
  assert.equal(tierOf('claude-haiku-5-5'), 'haiku')
  assert.equal(tierOf('claude-sonnet-5-5'), 'sonnet')
  assert.equal(tierOf('claude-fable-5-1'), 'sonnet')
})

test('an empty tier takes the first filled model, opus then sonnet then haiku', () => {
  assert.equal(hubModel('claude-opus-5-5', MODELS), 'big')
  assert.equal(hubModel('claude-haiku-5-5', MODELS), 'small')
  assert.equal(hubModel('claude-sonnet-5-5', MODELS), 'big')
  assert.equal(hubModel('claude-sonnet-5-5', { haiku: 'only' }), 'only')
  assert.equal(hubModel('claude-sonnet-5-5', {}), undefined)
})

test('a failed model falls to the next tier down, then up, each hub model once', () => {
  const three = { opus: 'a', sonnet: 'b', haiku: 'c' }
  assert.deepEqual(hubModelChain('claude-opus-5-5', three), ['a', 'b', 'c'])
  assert.deepEqual(hubModelChain('claude-sonnet-5-5', three), ['b', 'c', 'a'])
  assert.deepEqual(hubModelChain('claude-haiku-5-5', three), ['c', 'b', 'a'])
  assert.deepEqual(hubModelChain('claude-opus-5-5', { opus: 'a', sonnet: 'a', haiku: 'c' }), ['a', 'c'])
  assert.deepEqual(hubModelChain('claude-sonnet-5-5', { opus: 'a' }), ['a'])
  assert.deepEqual(hubModelChain('claude-sonnet-5-5', {}), [])
})

test('only a failure another model might not have is worth another model', () => {
  for (const status of [404, 408, 429, 500, 502, 503, 529]) assert.equal(isModelFailure(status), true, String(status))
  for (const status of [200, 400, 401, 403, 413]) assert.equal(isModelFailure(status), false, String(status))
})

test('hub headers: allowlist only, OAuth beta and credentials never pass', () => {
  const out = hubHeaders(
    {
      authorization: 'Bearer sk-ant-oat01-secret',
      cookie: 'a=b',
      'x-nexus-router': 'tok',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20, interleaved-thinking-2025-05-14',
      'x-claude-code-session-id': 'abc',
    },
    'hub-key',
  )
  assert.deepEqual(out, {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'interleaved-thinking-2025-05-14',
    'x-api-key': 'hub-key',
    authorization: 'Bearer hub-key',
  })
})

test('claude headers keep everything but hop-by-hop and the router tokens', () => {
  const out = claudeHeaders({
    host: '127.0.0.1:5000',
    connection: 'keep-alive',
    'content-length': '10',
    'x-nexus-router': 'tok',
    'x-nexus-control': 'ctl',
    authorization: 'Bearer oauth',
    'anthropic-beta': 'oauth-2025-04-20',
  })
  assert.deepEqual(out, { authorization: 'Bearer oauth', 'anthropic-beta': 'oauth-2025-04-20' })
})

test('the hub body maps the model and drops earlier thinking blocks only', () => {
  const body = {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'z' }] },
    ],
  }
  const out = toHubBody(body, MODELS)
  assert.equal(out.model, 'big')
  assert.deepEqual(out.system, body.system)
  assert.deepEqual(out.messages[1].content, [{ type: 'text', text: 'ok' }])
  assert.deepEqual(out.messages[2].content, [{ type: 'text', text: '…' }])
  assert.equal(body.messages[1].content.length, 2, 'input is not mutated')
})

test('tool ids outside the Claude pattern are fixed the same way on both sides', () => {
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call:1/a', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call:1/a', content: 'ok' }] },
    ],
  }
  const out = withSafeToolIds(body)
  assert.equal(out.messages[0].content[0].id, 'call_1_a')
  assert.equal(out.messages[1].content[0].tool_use_id, 'call_1_a')
  const clean = { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} }] }] }
  assert.equal(withSafeToolIds(clean), clean, 'an already valid body is returned as is')
})

test('a 429 is a plan limit only when a unified status says rejected', () => {
  assert.deepEqual(
    planLimit(429, {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': '1790000000',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    }),
    { window: 'five_hour', resetsAt: 1790000000000 },
  )
  assert.deepEqual(planLimit(429, { 'anthropic-ratelimit-unified-7d-status': 'rejected' }), { window: null, resetsAt: null })
  assert.equal(planLimit(429, { 'retry-after': '3' }), null)
  assert.equal(planLimit(429, { 'anthropic-ratelimit-unified-status': 'allowed_warning' }), null)
  assert.equal(planLimit(200, { 'anthropic-ratelimit-unified-status': 'rejected' }), null)
})

test('the overage status never counts as a plan limit', () => {
  assert.equal(
    planLimit(429, {
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
    }),
    null,
  )
  assert.equal(planLimit(429, { 'anthropic-ratelimit-unified-overage-status': 'rejected' }), null)
  assert.deepEqual(
    planLimit(429, { 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-overage-status': 'rejected' }),
    { window: null, resetsAt: null },
  )
  assert.deepEqual(planLimit(429, { 'Anthropic-Ratelimit-Unified-Status': 'Rejected' }), { window: null, resetsAt: null })
})

test('only the router address is accepted as Host', () => {
  assert.equal(hostAllowed('127.0.0.1:5000', 5000), true)
  assert.equal(hostAllowed('localhost:5000', 5000), true)
  assert.equal(hostAllowed('evil.example:5000', 5000), false)
  assert.equal(hostAllowed(undefined, 5000), false)
})

test('routing: control paths, messages to the hub, everything else to Claude', () => {
  assert.equal(routeFor('GET', '/__nexus/status', 'myhub'), 'control')
  assert.equal(routeFor('POST', '/v1/messages?beta=true', 'myhub'), 'hub')
  assert.equal(routeFor('POST', '/v1/messages/count_tokens?beta=true', 'myhub'), 'hub')
  assert.equal(routeFor('HEAD', '/api/hello', 'myhub'), 'claude')
  assert.equal(routeFor('POST', '/v1/messages?beta=true', 'claude'), 'claude')
  assert.equal(isInference('POST', '/v1/messages?beta=true'), true)
  assert.equal(isInference('POST', '/v1/messages/count_tokens'), false)
})

test('the hub target drops the /v1 the hub URL already has', () => {
  assert.equal(hubTarget('https://hub.example/v1', '/v1/messages?beta=true'), 'https://hub.example/v1/messages?beta=true')
  assert.equal(hubTarget('https://hub.example/v1', '/v1/messages/count_tokens'), 'https://hub.example/v1/messages/count_tokens')
})
