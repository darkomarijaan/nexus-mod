export function slash(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

export async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.toLowerCase()))

  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function tail(text: string, lines: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join('\n')
}

export function stamp(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function ago(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`

  return `${Math.round(seconds / 86400)}d`
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`

  return String(n)
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length > max ? `${one.slice(0, Math.max(1, max - 1))}…` : one
}

/** The one detail of a tool call worth a glance: its command, file, pattern or address. */
export function describeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const fields = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'description', 'prompt']) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return key.endsWith('path') ? value.replace(/\\/g, '/').split('/').slice(-2).join('/') : value
    }
  }

  return ''
}

/** Maps the status a session file reports to the HUD's three lights. */
export function peerStatus(raw: string): 'working' | 'waiting' | 'done' {
  const status = raw.toLowerCase()
  if (/wait|input|permission|ask|blocked|prompt|approval/.test(status)) return 'waiting'
  if (/busy|work|run|stream|think|tool|active/.test(status)) return 'working'

  return 'done'
}

/** Pulls `{"assumptions": [...]}` out of a model reply; at most four, no commas. */
export function parseAssumptions(raw: string | undefined): string[] {
  if (raw === undefined) return []
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { assumptions?: unknown }
    const list = Array.isArray(parsed.assumptions) ? parsed.assumptions : []
    const labels = list
      .filter((one): one is string => typeof one === 'string' && one.trim() !== '')
      .map(one => clip(one.replace(/,/g, ';'), 110))

    return [...new Set(labels)].slice(0, 4)
  } catch {
    return []
  }
}

/** Reads a multi-select answer: which labels were ticked, and any typed correction. */
export function readTicks(answer: string, labels: readonly string[]): { rejected: string[]; correction: string } {
  const parts = answer.split(',').map(part => part.trim()).filter(Boolean)
  const picked = new Set(parts.filter(part => labels.includes(part)))

  return {
    rejected: labels.filter(label => !picked.has(label)),
    correction: parts.filter(part => !labels.includes(part)).join(', '),
  }
}

// ── Usage windows ────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Reads the engine's rate-limit windows into the HUD's shape. */
export function readLimits(
  raw: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): { kind: string; percentUsed: number; resetsAt: number | null }[] {
  return raw.map(one => {
    const at = one.resetsAt === undefined ? NaN : Date.parse(one.resetsAt)

    return { kind: one.kind, percentUsed: one.percentUsed, resetsAt: Number.isNaN(at) ? null : at }
  })
}

/** Time left to a reset as the HUD reads it: `1h 42m`, `12m`, `2d 3h`. */
export function untilReset(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`

  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
}

/** One HUD label per window: `5h: 26% [reset 1h 42m]`, `Wk: 38% [Mon]`; percent is what is used. */
export function limitLabel(
  limit: { kind: string; percentUsed: number; resetsAt: number | null },
  now: number,
): { name: '5h' | 'Wk'; text: string; used: number; reset: string } | undefined {
  const used = Math.max(0, Math.round(limit.percentUsed))
  if (limit.kind === 'five_hour') {
    const when = limit.resetsAt === null ? '' : untilReset(limit.resetsAt, now)

    return { name: '5h', text: `5h: ${used}%${when ? ` [reset ${when}]` : ''}`, used, reset: when ? `reset ${when}` : '' }
  }
  if (limit.kind === 'seven_day') {
    const day = limit.resetsAt === null ? '' : (DAYS[new Date(limit.resetsAt).getDay()] ?? '')

    return { name: 'Wk', text: `Wk: ${used}%${day ? ` [${day}]` : ''}`, used, reset: day ? `reset ${day}` : '' }
  }

  return undefined
}

// ── Task progress ────────────────────────────────────────────────────────

type Task = { id: string; label: string; status: 'pending' | 'in_progress' | 'completed' }

const isStatus = (value: unknown): value is Task['status'] =>
  value === 'pending' || value === 'in_progress' || value === 'completed'

/** The whole list a TodoWrite call sets. */
export function tasksFromTodos(todos: unknown): Task[] {
  if (!Array.isArray(todos)) return []

  return todos.flatMap((one, index) => {
    const todo = (one ?? {}) as Record<string, unknown>
    const label = String(todo.status === 'in_progress' ? (todo.activeForm ?? todo.content ?? '') : (todo.content ?? ''))

    return isStatus(todo.status) && label.trim() !== '' ? [{ id: `todo-${index}`, label: label.trim(), status: todo.status }] : []
  })
}

/** Applies one TaskUpdate call; `deleted` drops the task. */
export function applyTaskUpdate(list: readonly Task[], input: Record<string, unknown>): Task[] {
  const id = String(input.taskId ?? '')
  if (input.status === 'deleted') return list.filter(task => task.id !== id)

  return list.map(task => {
    if (task.id !== id) return task
    const status = isStatus(input.status) ? input.status : task.status
    const label = status === 'in_progress' && typeof input.activeForm === 'string'
      ? input.activeForm
      : typeof input.subject === 'string'
        ? input.subject
        : task.label

    return { ...task, status, label: label.trim() || task.label }
  })
}

/** The meter: the task in progress and how much of the list is done. */
export function taskMeter(list: readonly Task[]): { label: string; percent: number; done: number; total: number } | undefined {
  if (list.length === 0) return undefined
  const done = list.filter(task => task.status === 'completed').length
  const active = list.find(task => task.status === 'in_progress') ?? list.find(task => task.status === 'pending')
  const label = active?.label ?? 'All tasks done'

  return { label, percent: Math.round((done / list.length) * 100), done, total: list.length }
}

/** A ten-cell bar for a percent: `▰▰▰▰▰▰▱▱▱▱`. */
export function bar(percent: number, cells = 10): string {
  const full = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))

  return '▰'.repeat(full) + '▱'.repeat(cells - full)
}

/**
 * Output tokens per second from the first streamed chunk to the end; none for
 * a response too short or too quick to time.
 */
export function tokensPerSecond(outputTokens: number, firstChunkAt: number, endAt: number): number | undefined {
  const seconds = (endAt - firstChunkAt) / 1000
  if (outputTokens < 8 || seconds < 0.25) return undefined

  return Math.round(outputTokens / seconds)
}

/** The share of a request's input the prompt cache served, 0-100; none for an empty input. */
export function cacheHitPercent(usage: {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): number | undefined {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  if (total <= 0) return undefined

  return Math.round((usage.cache_read_input_tokens / total) * 100)
}

/** Names a stop reason that cut the reply short; none for a reply that ended normally. */
export function cutoffLabel(stopReason: string | null): string | undefined {
  switch (stopReason) {
    case 'max_tokens':
      return 'reply cut off: hit max tokens'
    case 'model_context_window_exceeded':
      return 'reply cut off: context window full'
    case 'refusal':
      return 'reply stopped: refused'
    default:
      return undefined
  }
}
