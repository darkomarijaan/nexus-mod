// Nexus Claude Mode: an intelligent model router for the Claude route. Pure
// logic, no Node APIs, so the router and its tests share exactly this code.
//
// For each main-thread request (one that carries tools) it decides a tier,
// opus / sonnet / haiku, from the user's latest message and the measurable state
// of the turn, then names the model id to send. The decision is sticky for the
// whole turn (so the prompt cache survives) and only moves up on measured
// failures. It never reads or keeps prompt text beyond scoring it in memory:
// the records it keeps hold reason codes, never text.

export const MODES = ['auto', 'off', 'opus', 'sonnet', 'haiku']
export const TIERS = ['opus', 'sonnet', 'haiku']
const UP = { haiku: 'sonnet', sonnet: 'opus' }

export const DEFAULT_MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }
// USD per million tokens (input, output). Estimates only: configurable, check your own price list.
export const DEFAULT_PRICES = { opus: { in: 15, out: 75 }, sonnet: { in: 3, out: 15 }, haiku: { in: 1, out: 5 } }

const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/
// A model whose window is small must not take a prompt this big (bytes of the request body, about 4 per token).
const HAIKU_MAX_BYTES = 480_000
const RECENT_MAX = 30
const FAIL_STATUS = new Set([400, 403, 404, 408, 429, 500, 502, 503, 504, 529])

const tierOf = model => {
  const id = String(model ?? '').toLowerCase()

  return id.includes('opus') ? 'opus' : id.includes('haiku') ? 'haiku' : id.includes('sonnet') ? 'sonnet' : null
}

/** Reads "opus=15/75,sonnet=3/15" into a price table; null when it is not that shape. */
export function parsePrices(text) {
  const out = {}
  for (const part of String(text ?? '').split(',')) {
    if (part.trim() === '') continue
    const found = /^\s*(opus|sonnet|haiku)\s*=\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/i.exec(part)
    if (found === null) return null
    out[found[1].toLowerCase()] = { in: Number(found[2]), out: Number(found[3]) }
  }

  return out
}

// ── Reading a request ────────────────────────────────────────────────────

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const FENCE = /```/

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

const hash = text => {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619)

  return (h >>> 0).toString(36)
}

const FILE_REF = /[\w.\\/-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|rb|php|swift|vue|svelte|css|scss|html|json|ya?ml|toml|sql|md|sh)\b/gi

/**
 * What the current turn is: the user's latest typed message (reminders cut out), and what has run since.
 * A turn starts at the last user message that holds text; a tool_result alone continues it.
 */
export function readTurn(messages) {
  if (!Array.isArray(messages)) return null
  let start = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = textOf(message.content).replace(REMINDER, '').trim()
    if (text !== '') {
      start = i
      break
    }
  }
  if (start === -1) return null
  const text = textOf(messages[start].content).replace(REMINDER, '').trim()
  let toolCalls = 0
  let failures = 0
  const touched = new Set()
  for (const message of messages.slice(start)) {
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool_use') {
        toolCalls += 1
        const path = block.input?.file_path ?? block.input?.path
        if (typeof path === 'string' && /^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(block.name)) touched.add(path)
      } else if (block?.type === 'tool_result' && block.is_error === true) failures += 1
    }
  }

  return { key: `${start}:${hash(text.slice(0, 300))}`, text, toolCalls, failures, touched: touched.size, messages: messages.length }
}

// ── Classifying ──────────────────────────────────────────────────────────

const HEAVY = [
  /architect|arsitektur|system design|desain sistem|rancang|merancang/i,
  /trade-?offs?/i,
  /root cause|akar masalah/i,
  /race condition|deadlock|concurren|distributed|terdistribusi|memory leak/i,
  /(?:refactor|rewrite|migrat|restructure|rombak).{0,60}(?:entire|whole|all |across|codebase|large|seluruh|semua|besar|banyak)/i,
  /(?:entire|whole|seluruh|semua).{0,40}(?:refactor|rewrite|migrat|codebase)/i,
  /(?:time|space) complexity|kompleksitas (?:waktu|algoritma)|algorithm|algoritma/i,
  /security audit|audit keamanan|vulnerabilit|kerentanan|threat model/i,
  /(?:intermittent|flaky|heisenbug|hard to reproduce|sulit (?:direproduksi|dilacak|ditemukan))/i,
  /(?:deep|in-depth|mendalam|step[- ]by[- ]step).{0,30}(?:analy|reason|penalaran|analisis)/i,
]
const LIGHT = /\b(?:typo|rename|format(?:ting)?|summari[sz]e|summary|ringkas\w*|translate|terjemah\w*|boilerplate|hello world|commit message|what is|what's|apa itu|apa bedanya|jelaskan singkat|briefly|singkat|spell|lowercase|uppercase)\b/i
const CODING = /\b(?:implement\w*|fix|bug|error|function|class|component|endpoint|tests?|refactor\w*|review|debug\w*|api|quer(?:y|ies)|build|add|create|update|buat\w*|tambah\w*|perbaiki|ubah|kode|code|script|migrat\w*)\b/i
const RISK = /\b(?:production|prod|database|db|payments?|pembayaran|auth\w*|security|keamanan|delete|drop|credentials?|secrets?)\b/i

/**
 * LIGHT, MEDIUM or HEAVY, with the codes that decided it. Cheap on purpose: a handful of regexes over one
 * message and counters the request already carries; no model call.
 */
export function classify(turn, { bytes = 0 } = {}) {
  const reasons = []
  let score = 1
  const add = (points, code) => {
    score += points
    reasons.push(code)
  }
  const { text } = turn
  if (text.length < 200) add(-1, 'short')
  if (text.length > 600) add(1, 'long')
  if (text.length > 2000) add(1, 'very-long')
  const coding = CODING.test(text)
  const light = LIGHT.test(text)
  if (coding) add(1, 'coding')
  if (light) add(-1, 'light-words')
  if (!coding && !light && text.length < 200 && !FENCE.test(text)) add(-1, 'plain-question')
  if (FENCE.test(text)) add(1, 'code-block')
  const heavy = HEAVY.filter(pattern => pattern.test(text)).length
  if (heavy > 0) add(Math.min(6, heavy * 3), `heavy-x${heavy}`)
  const files = new Set(text.match(FILE_REF) ?? []).size
  if (files >= 4) add(2, 'files-4+')
  else if (files >= 2) add(1, 'files-2+')
  if (RISK.test(text)) add(1, 'risk')
  if (turn.toolCalls >= 8) add(1, 'multistep')
  if (turn.failures >= 2) add(1, 'failures')
  if (turn.messages > 80 || bytes > 400_000) add(1, 'big-context')

  const level = score >= 4 ? 'HEAVY' : score <= 0 ? 'LIGHT' : 'MEDIUM'

  return { level, score, reasons }
}

const TIER_OF_LEVEL = { LIGHT: 'haiku', MEDIUM: 'sonnet', HEAVY: 'opus' }

/** The measured reason to move a turn one tier up, or null. Never length or token count. */
export function escalationReason(tier, turn) {
  if (tier === 'haiku') {
    if (turn.failures >= 2) return 'tool-failures'
    if (turn.toolCalls >= 12) return 'multistep'
  }
  if (tier === 'sonnet') {
    if (turn.failures >= 4) return 'repeated-failures'
    if (turn.touched >= 8 && turn.failures >= 2) return 'wide-change-failing'
  }

  return null
}

/** Whether a failed answer is worth asking another model: the status says the model, not the request's author, may be at fault. */
export const isRetryable = status => FAIL_STATUS.has(status)

// ── Usage and cost ───────────────────────────────────────────────────────

/** Reads token usage out of a streamed (SSE) or plain JSON answer as its chunks pass; keeps no text but one line. */
export function createUsageTap() {
  const decoder = new TextDecoder()
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let carry = ''
  let raw = ''
  let seen = false
  const take = found => {
    if (found === null || typeof found !== 'object') return
    seen = true
    const pick = (field, from) => {
      if (typeof found[from] === 'number') usage[field] = found[from]
    }
    pick('input', 'input_tokens')
    pick('output', 'output_tokens')
    pick('cacheRead', 'cache_read_input_tokens')
    pick('cacheWrite', 'cache_creation_input_tokens')
  }
  const line = text => {
    if (!text.startsWith('data:') || !text.includes('"usage"')) return
    try {
      const data = JSON.parse(text.slice(5))
      take(data?.message?.usage)
      take(data?.usage)
    } catch {
      // a line that is not JSON carries no usage
    }
  }

  return {
    push(chunk) {
      const text = carry + decoder.decode(chunk, { stream: true })
      const lines = text.split('\n')
      carry = lines.pop() ?? ''
      for (const one of lines) line(one.trim())
      if (raw.length < 262_144) raw += text.slice(0, 262_144 - raw.length)
    },
    result() {
      line(carry.trim())
      if (!seen) {
        try {
          take(JSON.parse(raw)?.usage)
        } catch {
          // not a JSON answer either
        }
      }

      return seen ? usage : null
    },
  }
}

/** The dollar estimate of one answer: cache reads at a tenth of the input price, cache writes at 1.25 times. */
export function costOf(usage, price) {
  if (usage === null || price === undefined) return null

  return (usage.input * price.in + usage.cacheRead * price.in * 0.1 + usage.cacheWrite * price.in * 1.25 + usage.output * price.out) / 1_000_000
}

// ── The engine ───────────────────────────────────────────────────────────

/** Claude Mode's state and decisions for one router. `now` is injectable for tests. */
export function createClaudeMode({ now = () => Date.now() } = {}) {
  const state = {
    mode: 'auto',
    models: { ...DEFAULT_MODELS },
    prices: { ...DEFAULT_PRICES },
    maxEscalations: 2,
    turn: null,
    recent: [],
    totals: { requests: 0, fallbacks: 0, escalations: 0, tokensIn: 0, tokensOut: 0, cost: 0, baseline: 0, byTier: { opus: 0, sonnet: 0, haiku: 0 } },
  }

  /** Applies a settings patch; returns the first problem as a sentence, or null when all of it was taken. */
  function configure(patch) {
    if (patch === null || typeof patch !== 'object') return 'a settings object is needed'
    const next = {}
    if (patch.mode !== undefined) {
      if (!MODES.includes(patch.mode)) return `mode must be one of ${MODES.join(', ')}`
      next.mode = patch.mode
    }
    if (patch.models !== undefined) {
      const models = { ...state.models }
      for (const tier of TIERS) {
        const id = patch.models?.[tier]
        if (id === undefined || id === '') continue
        if (typeof id !== 'string' || !MODEL_ID.test(id.trim())) return `the ${tier} model id is not a plain model id`
        models[tier] = id.trim()
      }
      next.models = models
    }
    if (patch.prices !== undefined) {
      const parsed = typeof patch.prices === 'string' ? parsePrices(patch.prices) : null
      if (parsed === null) return 'prices must look like opus=15/75,sonnet=3/15,haiku=1/5'
      next.prices = { ...DEFAULT_PRICES, ...parsed }
    }
    if (patch.maxEscalations !== undefined) {
      if (!Number.isInteger(patch.maxEscalations) || patch.maxEscalations < 0 || patch.maxEscalations > 2) return 'maxEscalations must be 0, 1 or 2'
      next.maxEscalations = patch.maxEscalations
    }
    Object.assign(state, next)

    return null
  }

  /**
   * The plan for one request, or null to leave it alone (mode off, no tools: a helper call, or nothing to read).
   * { tier, model, chain, level, score, reasons, escalation }
   */
  function plan(body, { bytes = 0 } = {}) {
    if (state.mode === 'off' || body === null || typeof body !== 'object') return null
    if (!Array.isArray(body.tools) || body.tools.length === 0 || typeof body.model !== 'string') return null
    const turn = readTurn(body.messages)
    if (turn === null) return null
    const incoming = body.model
    let tier
    let level = null
    let score = null
    let reasons
    let escalation = null
    if (state.mode !== 'auto') {
      tier = state.mode
      reasons = ['manual']
    } else {
      const kept = state.turn !== null && state.turn.key === turn.key ? state.turn : null
      if (kept === null) {
        const found = classify(turn, { bytes })
        state.turn = { key: turn.key, tier: TIER_OF_LEVEL[found.level], level: found.level, score: found.score, reasons: found.reasons, escalations: 0 }
      } else if (kept.escalations < state.maxEscalations && UP[kept.tier] !== undefined) {
        const why = escalationReason(kept.tier, turn)
        if (why !== null) {
          escalation = { from: kept.tier, to: UP[kept.tier], why }
          kept.tier = UP[kept.tier]
          kept.escalations += 1
          state.totals.escalations += 1
        }
      }
      ;({ tier, level, score, reasons } = state.turn)
    }
    // Haiku's window is small: a big prompt never goes there.
    if (tier === 'haiku' && bytes > HAIKU_MAX_BYTES) {
      tier = 'sonnet'
      reasons = [...reasons, 'haiku-window']
    }
    const model = state.models[tier]
    // Ask the model the session itself chose next (known good), then the other tiers; three tries at most.
    const rest = [incoming, ...[...TIERS.slice(TIERS.indexOf(tier) + 1), ...TIERS.slice(0, TIERS.indexOf(tier)).reverse()].map(one => state.models[one])]
    const chain = [...new Set([model, ...rest])].slice(0, 3)

    return { mode: state.mode, tier, model, incoming, chain, level, score, reasons: [...reasons], escalation }
  }

  /** Files one answer into the history and totals; `usage` may be null, `fallbacks` lists the models that failed first. */
  function record(decision, { model, status, ms, usage, fallbacks }) {
    const tier = tierOf(model) ?? decision.tier
    const cost = costOf(usage, state.prices[tier])
    const baseline = costOf(usage, state.prices[tierOf(decision.incoming) ?? 'sonnet'])
    const entry = {
      at: now(),
      mode: decision.mode,
      level: decision.level,
      score: decision.score,
      reasons: decision.reasons,
      model,
      incoming: decision.incoming,
      status,
      ms,
      tokensIn: usage === null ? null : usage.input + usage.cacheRead + usage.cacheWrite,
      tokensOut: usage === null ? null : usage.output,
      cost,
      escalation: decision.escalation,
      fallbacks,
    }
    state.recent.push(entry)
    if (state.recent.length > RECENT_MAX) state.recent.shift()
    const totals = state.totals
    totals.requests += 1
    totals.byTier[tier] += 1
    totals.fallbacks += fallbacks.length
    if (usage !== null) {
      totals.tokensIn += entry.tokensIn
      totals.tokensOut += usage.output
      totals.cost += cost ?? 0
      totals.baseline += baseline ?? 0
    }

    return entry
  }

  const snapshot = () => ({
    mode: state.mode,
    models: { ...state.models },
    prices: state.prices,
    maxEscalations: state.maxEscalations,
    totals: { ...state.totals, byTier: { ...state.totals.byTier } },
    recent: state.recent.slice(),
  })

  return { configure, plan, record, snapshot }
}
