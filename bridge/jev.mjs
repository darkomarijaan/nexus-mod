// Auto Model's optional classifier: Jev (TypeSafe), reached through any service that takes the same
// request. Nothing here is required: without a key, or with the setting off, the router never gets here.
//
// What it sends is the person's typed message and nothing else (no tool results, system prompt, files or
// history), cut down, and never a message that looks like it holds a secret. Every failure is a plain result
// ({ ok: false, kind }) for the caller to fall back on; nothing here throws at the router.

export const JEV_LEVELS = ['LIGHT', 'MEDIUM', 'HEAVY']
export const DEFAULT_JEV = {
  mode: 'off',
  url: 'https://api.commandcode.ai/provider/v1/systemone',
  keyEnv: 'CMD_API_KEY',
  model: 'typesafe/jev-1.14.0',
  timeoutMs: 1500,
  minConfidence: 0.5,
}
/** The chosen level must also hold at least this probability: Choice confidence alone runs low for MEDIUM. */
export const JEV_MIN_PROBABILITY = 0.6

const HEAD = 2000
const TAIL = 500

/** The first 2000 and last 500 characters of a long message. */
export const trimForJev = text => (text.length <= HEAD + TAIL ? text : `${text.slice(0, HEAD)}\n...\n${text.slice(-TAIL)}`)

// Keys and tokens people paste into a prompt. A message that matches is never sent.
const SECRET = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\b(?:api[_-]?key|secret|token|passw(?:or)?d)\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}/i,
]

export const looksSecret = text => SECRET.some(pattern => pattern.test(text))

/** An https address, or plain http on this machine (for tests); never one with a user or password in it. */
export function validJevUrl(value) {
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') return false
    if (url.protocol === 'https:') return true

    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export const validKeyEnv = name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)

const QUESTION = {
  type: 'choice',
  instructions: 'How much reasoning does answering this coding-assistant message need?',
  criteria: {
    LIGHT: 'A short factual question, a small mechanical change, a summary or a translation.',
    MEDIUM: 'Everyday coding work with a clear scope.',
    HEAVY: 'Architecture, root-cause analysis, changes across many files, trade-off decisions, or high-risk work.',
  },
}

export const buildRequest = (model, text) => ({ model, state: trimForJev(text), questions: { tier: QUESTION } })

const count = value => (Number.isFinite(value) && value >= 0 ? value : 0)

/** The answer as { level, confidence, probability, usage }, or null when it is not the shape asked for. */
export function parseAnswer(json) {
  const answer = json?.answers?.tier
  if (answer === null || typeof answer !== 'object') return null
  const level = answer.choice
  if (!JEV_LEVELS.includes(level)) return null
  const probability = answer.probabilities?.[level]
  if (!Number.isFinite(answer.confidence) || !Number.isFinite(probability)) return null

  return { level, confidence: answer.confidence, probability, usage: { input: count(json.usage?.input_tokens), output: count(json.usage?.output_tokens) } }
}

const isTimeout = error => error?.name === 'TimeoutError' || error?.name === 'AbortError'

const drop = async response => {
  try {
    await response.body?.cancel()
  } catch {
    // nothing left to read
  }
}

/**
 * Asks Jev for the level of one message. { ok: true, level, confidence, probability, usage }, or
 * { ok: false, kind } with kind one of timeout, network, auth (401/403), http, shape.
 * The timeout covers the whole exchange, the body included.
 */
export async function askJev({ fetch, url, key, model, text, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Jev did not answer in time', 'TimeoutError')), timeoutMs)
  try {
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildRequest(model, text)),
        redirect: 'error',
        signal: controller.signal,
      })
    } catch (error) {
      return { ok: false, kind: isTimeout(error) ? 'timeout' : 'network' }
    }
    if (response.status === 401 || response.status === 403) {
      await drop(response)

      return { ok: false, kind: 'auth' }
    }
    if (!response.ok) {
      await drop(response)

      return { ok: false, kind: 'http' }
    }
    let json
    try {
      json = await response.json()
    } catch (error) {
      return { ok: false, kind: isTimeout(error) ? 'timeout' : 'shape' }
    }
    const parsed = parseAnswer(json)

    return parsed === null ? { ok: false, kind: 'shape' } : { ok: true, ...parsed }
  } finally {
    clearTimeout(timer)
  }
}
