// Nexus provider router: the routing rules, pure. No Node APIs here, so the
// router and its tests share exactly this logic.

export const TIERS = ['opus', 'sonnet', 'haiku']

/** The tier a Claude model id belongs to; anything unrecognised counts as sonnet. */
export function tierOf(model) {
  const id = String(model ?? '').toLowerCase()
  if (id.includes('opus')) return 'opus'
  if (id.includes('haiku')) return 'haiku'

  return 'sonnet'
}

const filled = value => typeof value === 'string' && value.trim() !== ''

/** The hub model for a Claude model id: its tier's, else the first one the profile fills (opus, sonnet, haiku). */
export function hubModel(model, models) {
  const own = models?.[tierOf(model)]
  if (filled(own)) return own.trim()
  const first = TIERS.map(tier => models?.[tier]).find(filled)

  return first === undefined ? undefined : first.trim()
}

// After a tier's own model fails: the tiers below it first, then the ones above.
const FALLBACK_ORDER = { opus: ['sonnet', 'haiku'], sonnet: ['haiku', 'opus'], haiku: ['sonnet', 'opus'] }

/** The hub models to try for a Claude model id, in order: its own (as hubModel picks it), then the other tiers', each model once. */
export function hubModelChain(model, models) {
  const first = hubModel(model, models)
  if (first === undefined) return []
  const rest = FALLBACK_ORDER[tierOf(model)].map(tier => models?.[tier]).filter(filled).map(one => one.trim())

  return [...new Set([first, ...rest])]
}

/** A hub failure another model might not share: not found, timeout, throttled, or the hub's own trouble. */
export function isModelFailure(status) {
  return status === 404 || status === 408 || status === 429 || status >= 500
}

const TO_HUB = ['content-type', 'accept', 'anthropic-version']

/** Headers for a hub request: an allowlist, the OAuth beta dropped, the hub key added. Never the caller's credentials. */
export function hubHeaders(incoming, key) {
  const out = {}
  for (const name of TO_HUB) {
    const value = incoming[name]
    if (value !== undefined) out[name] = String(value)
  }
  const betas = String(incoming['anthropic-beta'] ?? '')
    .split(',')
    .map(one => one.trim())
    .filter(one => one !== '' && !one.startsWith('oauth-'))
  if (betas.length > 0) out['anthropic-beta'] = betas.join(',')
  out['x-api-key'] = key
  out.authorization = `Bearer ${key}`

  return out
}

const NOT_FORWARDED = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'x-nexus-router', 'x-nexus-control'])

/** Headers for api.anthropic.com: everything the client sent but hop-by-hop headers and the router's tokens. */
export function claudeHeaders(incoming) {
  const out = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (!NOT_FORWARDED.has(name) && value !== undefined) out[name] = value
  }

  return out
}

function withoutThinking(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message
  const content = message.content.filter(block => block?.type !== 'thinking' && block?.type !== 'redacted_thinking')

  return { ...message, content: content.length > 0 ? content : [{ type: 'text', text: '…' }] }
}

/** The request body for a hub: its model mapped, the thinking blocks of earlier assistant turns dropped, nothing else touched. */
export function toHubBody(body, models) {
  const messages = Array.isArray(body.messages) ? body.messages.map(withoutThinking) : body.messages

  return { ...body, model: hubModel(body.model, models) ?? body.model, messages }
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/
const safeId = id => (typeof id === 'string' && !SAFE_ID.test(id) ? id.replace(/[^a-zA-Z0-9_-]/g, '_') : id)

/** A body whose tool ids fit the Claude API's pattern; the very same object when they already do. */
export function withSafeToolIds(body) {
  if (!Array.isArray(body?.messages)) return body
  let changed = false
  const messages = body.messages.map(message => {
    if (!Array.isArray(message?.content)) return message

    return {
      ...message,
      content: message.content.map(block => {
        if (block?.type === 'tool_use' && safeId(block.id) !== block.id) {
          changed = true
          return { ...block, id: safeId(block.id) }
        }
        if (block?.type === 'tool_result' && safeId(block.tool_use_id) !== block.tool_use_id) {
          changed = true
          return { ...block, tool_use_id: safeId(block.tool_use_id) }
        }
        return block
      }),
    }
  })

  return changed ? { ...body, messages } : body
}

/** A plan-limit rejection (5-hour, weekly) told apart from a short throttle; null for anything else. */
export function planLimit(status, headers) {
  if (status !== 429) return null
  const unified = Object.entries(headers).filter(([name]) => name.toLowerCase().startsWith('anthropic-ratelimit-unified-'))
  const isRejected = unified.some(([name, value]) => /^anthropic-ratelimit-unified-(?:[a-z0-9]+-)?status$/i.test(name) && !/overage/i.test(name) && String(value).toLowerCase() === 'rejected')
  if (!isRejected) return null
  const reset = Number(headers['anthropic-ratelimit-unified-reset'])
  const claim = headers['anthropic-ratelimit-unified-representative-claim']

  return {
    window: typeof claim === 'string' && claim !== '' ? claim : null,
    resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
  }
}

/** Only the router's own address: any other Host is DNS rebinding. */
export function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

const bare = path => String(path).split('?')[0]

/** A model request worth holding when it hits a plan limit. */
export function isInference(method, path) {
  return method === 'POST' && bare(path) === '/v1/messages'
}

/** Which way a request goes: the router's control API, Claude, or the active hub. */
export function routeFor(method, path, route) {
  const one = bare(path)
  if (one.startsWith('/__nexus/')) return 'control'
  if (route === 'claude') return 'claude'
  if (method === 'POST' && (one === '/v1/messages' || one === '/v1/messages/count_tokens')) return 'hub'

  return 'claude'
}

/** `<hub>/messages…` for `/v1/messages…`: the hub URL already ends in /v1. */
export function hubTarget(hubUrl, path) {
  const [one, query] = String(path).split('?')

  return `${hubUrl}${one.replace(/^\/v1/, '')}${query === undefined ? '' : `?${query}`}`
}
