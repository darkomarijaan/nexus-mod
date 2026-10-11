import type { SessionContextBreakdown } from 'claude-code'

import { clip } from './util'

/*
 * Lean: what keeps a session's context and quota working for the person.
 * Pure logic only; register.tsx wires it to the engine.
 *   - the anchor that follows a compaction
 *   - the context audit and per-project MCP servers
 *   - the trimming of noisy command output
 *   - the quota guard
 *   - the line under each answer
 */

export function tokens(count: number): string {
  if (count >= 100_000) return `${Math.round(count / 1000)}k`
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`

  return String(Math.round(count))
}

// ── After compaction: what Claude must not lose ──────────────────────────

export type AnchorFacts = {
  request: string
  tasks: readonly { label: string; status: string }[]
  files: readonly string[]
  checks: string | null
  claudeMd: string
}

/** The note that follows a compaction: the person's last request word for word, the open work, the project rules. */
export function anchorText(facts: AnchorFacts): string {
  const lines = ['[Nexus, after compaction] The conversation was just summarized. Pick up from here:']
  if (facts.request.trim() !== '') {
    lines.push('', "The user's latest request, word for word:", '"""', clip(facts.request.trim(), 4000), '"""')
  }
  const open = facts.tasks.filter(task => task.status !== 'completed')
  if (open.length > 0) {
    lines.push('', 'Open tasks:', ...open.slice(0, 20).map(task => `- [${task.status === 'in_progress' ? 'in progress' : 'pending'}] ${task.label}`))
  }
  if (facts.files.length > 0) {
    lines.push('', `Files touched this session: ${facts.files.slice(-30).join(', ')}`)
  }
  if (facts.checks !== null && facts.checks.trim() !== '') lines.push('', `Last check results: ${clip(facts.checks, 400)}`)
  if (facts.claudeMd.trim() !== '') {
    lines.push('', "The project's CLAUDE.md still applies. Its opening, for reference:", '"""', clip(facts.claudeMd.trim(), 2500), '"""')
  }
  lines.push('', 'Read a file again before you edit it; what the summary says of it may be stale.')

  return lines.join('\n')
}

/** The newest message the person typed, from a transcript (tool results and reminders aside). */
export function lastRequestIn(messages: readonly { role: string; text: string; toolResults?: readonly unknown[] }[]): string {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]
    if (message === undefined || message.role !== 'user') continue
    const text = message.text.trim()
    if (text === '' || (message.toolResults?.length ?? 0) > 0) continue
    if (text.startsWith('<') || text.startsWith('[Nexus')) continue

    return text
  }

  return ''
}

// ── MCP servers per project ──────────────────────────────────────────────

/** `mcp__playwright__browser_click` → `playwright`; undefined for a built-in tool. */
export function mcpServerOf(tool: string): string | undefined {
  const match = /^mcp__(.+?)__/.exec(tool)

  return match?.[1]
}

export function offDescription(server: string): string {
  return `Turned off in this project by Nexus (/mcp-nexus on ${server} turns it back on). Do not call it.`
}

// ── Context audit ────────────────────────────────────────────────────────

type Breakdown = Pick<
  SessionContextBreakdown,
  'categories' | 'totalTokens' | 'rawMaxTokens' | 'percentage' | 'model' | 'memoryFiles' | 'mcpTools' | 'agents' | 'skills' | 'slashCommands' | 'autoCompactThreshold'
>

type Group = { name: string; tokens: number; count: number }

function groupBy<T>(items: readonly T[], key: (item: T) => string, size: (item: T) => number): Group[] {
  const groups = new Map<string, Group>()
  for (const item of items) {
    const name = key(item)
    const group = groups.get(name) ?? { name, tokens: 0, count: 0 }
    group.tokens += size(item)
    group.count += 1
    groups.set(name, group)
  }

  return [...groups.values()].sort((a, b) => b.tokens - a.tokens)
}

const pad = (text: string, width: number) => (text.length >= width ? text : text + ' '.repeat(width - text.length))
const left = (text: string, width: number) => (text.length >= width ? text : ' '.repeat(width - text.length) + text)

/** Where the context goes before a word is typed, and what could go. */
export function contextReport(b: Breakdown, off: readonly string[], projectRoot: string): string {
  const out: string[] = []
  const names = [...b.categories.map(row => row.name), ...b.mcpTools.map(tool => tool.serverName)]
  const width = Math.max(24, ...names.map(name => name.length + 2))
  const compactAt = b.autoCompactThreshold === undefined ? '' : `, auto-compact at ${tokens(b.autoCompactThreshold)}`
  out.push(`Context on ${b.model}: ${tokens(b.totalTokens)} of ${tokens(b.rawMaxTokens)} (${b.percentage}%)${compactAt}`)
  out.push('', 'By category:')
  for (const row of b.categories) {
    if (row.tokens <= 0) continue
    const note = row.kind === 'deferred' ? '  (loaded on demand, outside the window)' : ''
    out.push(`  ${pad(row.name, width)}${left(tokens(row.tokens), 7)}${note}`)
  }

  const servers = groupBy(b.mcpTools, tool => tool.serverName, tool => (tool.isLoaded ? tool.tokens : 0))
  if (servers.length > 0) {
    out.push('', 'MCP servers (tokens of the tools in front of Claude; the rest wait behind ToolSearch):')
    for (const server of servers) {
      const loaded = b.mcpTools.filter(tool => tool.serverName === server.name && tool.isLoaded).length
      const state = off.includes(server.name) ? '  [off here]' : ''
      out.push(`  ${pad(server.name, width)}${left(tokens(server.tokens), 7)}  ${loaded}/${server.count} tools loaded${state}`)
    }
  }
  if (b.memoryFiles.length > 0) {
    out.push('', 'Memory files:')
    for (const file of [...b.memoryFiles].sort((x, y) => y.tokens - x.tokens)) {
      out.push(`  ${left(tokens(file.tokens), 7)}  ${file.path}`)
    }
  }
  const skillGroups = groupBy(b.skills?.skillFrontmatter ?? [], skill => skill.pluginName ?? skill.source, skill => skill.tokens)
  if (b.skills !== undefined) {
    out.push('', `Skills listing: ${tokens(b.skills.tokens)} for ${b.skills.includedSkills} of ${b.skills.totalSkills} skills`)
    for (const group of skillGroups.slice(0, 6)) out.push(`  ${pad(group.name, width)}${left(tokens(group.tokens), 7)}  ${group.count} skills`)
  }
  // `agent-dev-team:backend-dev` comes from the plugin agent-dev-team.
  const agentGroups = groupBy(b.agents, agent => (agent.agentType.includes(':') ? (agent.agentType.split(':')[0] ?? agent.source) : agent.source), agent => agent.tokens)
  const agentTokens = b.agents.reduce((sum, agent) => sum + agent.tokens, 0)
  if (b.agents.length > 0) {
    out.push('', `Agent types: ${tokens(agentTokens)} for ${b.agents.length}`)
    for (const group of agentGroups.slice(0, 4)) out.push(`  ${pad(group.name, width)}${left(tokens(group.tokens), 7)}  ${group.count} agents`)
  }
  if (b.slashCommands !== undefined) {
    out.push('', `Slash commands listing: ${tokens(b.slashCommands.tokens)} for ${b.slashCommands.includedCommands} of ${b.slashCommands.totalCommands}`)
  }

  const tips: string[] = []
  for (const server of servers) {
    if (server.tokens >= 1500 && !off.includes(server.name)) {
      tips.push(`MCP server "${server.name}" keeps ${tokens(server.tokens)} of tools in front of Claude. Not needed here? /mcp-nexus off ${server.name}`)
    }
  }
  // Only a plugin's skills can be turned off per project; the person's own and the built-in ones cannot.
  const fromPlugins = new Set((b.skills?.skillFrontmatter ?? []).map(skill => skill.pluginName).filter((name): name is string => name !== undefined))
  for (const group of skillGroups) {
    if (fromPlugins.has(group.name) && group.tokens >= 800) {
      tips.push(`Plugin "${group.name}" lists ${group.count} skills (${tokens(group.tokens)}). Not used in this project? Turn it off here with /plugin.`)
    } else if (group.name === 'userSettings' && group.tokens >= 3000) {
      tips.push(`Your own skills (~/.claude/skills) list ${group.count} skills for ${tokens(group.tokens)} in every project: move the rarely used ones into a plugin you turn on where they belong.`)
    }
  }
  for (const file of b.memoryFiles) {
    if (file.tokens >= 2500) {
      const where = file.path.replace(/\\/g, '/').toLowerCase().startsWith(projectRoot.toLowerCase()) ? 'this project' : 'every project'
      tips.push(`${file.path} costs ${tokens(file.tokens)} in ${where}: keep the rules there and move the detail into files Claude reads when it needs them.`)
    }
  }
  if (agentTokens >= 2000) {
    const top = agentGroups[0]
    tips.push(`${b.agents.length} agent types cost ${tokens(agentTokens)}${top === undefined ? '' : `, most from "${top.name}" (${tokens(top.tokens)})`}.`)
  }
  out.push('', 'Suggestions:')
  if (tips.length === 0) out.push('  · Nothing heavy: the startup context is lean.')
  else out.push(...tips.slice(0, 8).map(tip => `  · ${tip}`))

  return out.join('\n')
}

// ── Noisy command output ─────────────────────────────────────────────────

// Commands whose output is mostly progress and passing lines.
const NOISY =
  /^(npm|pnpm|yarn|bun|npx|bunx|pnpx|pip3?|uv|poetry|cargo|go|dotnet|mvn|mvnw|gradle|gradlew|pytest|jest|vitest|mocha|playwright|tsc|webpack|vite|next|nuxt|make|docker|composer|bundle|rspec|phpunit|deno|turbo|nx|ruff|eslint|claude)$/

/** True for a command whose long output is worth trimming (installs, builds, test runs, logs); never for one that prints a file. */
export function isNoisyCommand(command: string): boolean {
  const first = command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? ''
  const words = first.split(/\s+/)
  const name = (words[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  if (name === 'git') return /^(log|clone|fetch|pull|push|gc)$/.test(words[1] ?? '')
  if (name === 'python' || name === 'python3' || name === 'py') return words[1] === '-m' && NOISY.test(words[2] ?? '')

  return NOISY.test(name)
}

const IMPORTANT = /error|fail|exception|traceback|panic|warn|fatal|assert|denied|cannot|unable|not found|✗|✘|×|\bFAIL\b|^\s*at\s|^\s*File "|expected|received|exit code/i
const ROUTINE =
  /^\s*(✓|✔|√|\(pass\)|PASS\b|ok\b|\.+$|\[\d+\/\d+\]|\d+%|#\d+ |downloading|downloaded|fetching|resolving|progress|compiling|checking|collecting|requirement already satisfied|using cached|installing|building|bundling|transforming|npm (notice|http|timing)|added \d+ packages|up to date|reify|idealtree|remote: (counting|compressing|enumerating|total)|receiving objects|resolving deltas|unpacking objects|step \d+\/\d+|---> |=> )/i

export type Trimmed = { text: string; dropped: number }

/**
 * Trims long, routine output: progress frames and colour codes go, repeats
 * fold, runs of passing or progress lines fold to one, and what is still long
 * keeps its head, its tail and every line that looks like a problem.
 * Undefined when the output is short or trimming saves little.
 */
export function trimOutput(raw: string, limits = { lines: 150, chars: 12_000, head: 40, tail: 60, important: 40 }): Trimmed | undefined {
  const source = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const all = source.split(/\r?\n/).map(line => clip(line.split('\r').at(-1) ?? '', 400))
  if (all.length <= limits.lines && source.length <= limits.chars) return undefined

  const folded: string[] = []
  let routine: string[] = []
  const flush = () => {
    if (routine.length <= 3) folded.push(...routine)
    else folded.push(routine[0] ?? '', `  … ${routine.length - 1} more lines like it`)
    routine = []
  }
  for (const line of all) {
    if (line.trim() === '' && folded.at(-1)?.trim() === '') continue
    if (!IMPORTANT.test(line) && ROUTINE.test(line)) {
      routine.push(line)
      continue
    }
    flush()
    const last = folded.at(-1)
    const repeat = last === undefined ? null : /^(.*) \(×(\d+)\)$/.exec(last)
    if (last === line) folded[folded.length - 1] = `${line} (×2)`
    else if (repeat !== null && repeat[1] === line) folded[folded.length - 1] = `${line} (×${Number(repeat[2]) + 1})`
    else folded.push(line)
  }
  flush()

  let kept = folded
  if (folded.length > limits.lines) {
    const middle = folded.slice(limits.head, folded.length - limits.tail)
    const problems = middle.filter(line => IMPORTANT.test(line)).slice(0, limits.important)
    kept = [
      ...folded.slice(0, limits.head),
      `  … ${middle.length - problems.length} lines trimmed${problems.length > 0 ? `; the ${problems.length} that look like problems follow` : ''} …`,
      ...problems,
      ...(problems.length > 0 ? ['  …'] : []),
      ...folded.slice(folded.length - limits.tail),
    ]
  }
  const text = kept.join('\n')
  if (text.length > source.length * 0.8) return undefined

  return { text, dropped: Math.max(0, all.length - kept.length) }
}

// ── Quota guard ──────────────────────────────────────────────────────────

export type Window = { kind: string; percentUsed: number; resetsAt: number | null }

export const WINDOW_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' }

/** The windows at or past `guard` percent that have not been raised yet; each window once per reset. */
export function crossedWindows(limits: readonly Window[], guard: number, raised: ReadonlySet<string>): Window[] {
  if (guard <= 0) return []

  return limits.filter(
    limit => WINDOW_NAMES[limit.kind] !== undefined && limit.percentUsed >= guard && !raised.has(windowKey(limit)),
  )
}

export function windowKey(limit: Window): string {
  return `${limit.kind}:${limit.resetsAt ?? 'none'}`
}

// ── The line under an answer ─────────────────────────────────────────────

export type FooterFacts = {
  durationMs: number
  tools: number
  files: number
  contextPct: number | null
  checks: 'passed' | 'failed' | null
  /** Output tokens the turn's requests produced, when the turn reports them. */
  outputTokens?: number
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** `⏱ 3m 12s · 14 tools · 4 files · out 1.2k · ctx 42% · checks ✓` */
export function footerText(facts: FooterFacts): string {
  const parts = [`⏱ ${duration(facts.durationMs)}`]
  if (facts.tools > 0) parts.push(`${facts.tools} tool${facts.tools === 1 ? '' : 's'}`)
  if (facts.files > 0) parts.push(`${facts.files} file${facts.files === 1 ? '' : 's'}`)
  if (facts.outputTokens !== undefined && facts.outputTokens > 0) parts.push(`out ${tokens(facts.outputTokens)}`)
  if (facts.contextPct !== null) parts.push(`ctx ${facts.contextPct}%`)
  if (facts.checks !== null) parts.push(facts.checks === 'passed' ? 'checks ✓' : 'checks ✗')

  return parts.join(' · ')
}
