/**
 * /mcp-nexus: the MCP servers of this session as rows, the names a person
 * types matched to them, and the text and keys the list and the pane show.
 */

import type { NexusMcpRow } from '../types'
import { mcpServerOf, tokens } from './lean'
import { clip } from './util'

export type McpRow = NexusMcpRow

/** A server whose only tools are these has not been signed in to yet. */
const SIGN_IN_TOOLS = new Set(['authenticate', 'complete_authentication'])

const NAME_WIDTH = 28

/**
 * One row per server among `toolNames`, the heaviest first, then by name;
 * `self` (Nexus's own server) left out, and a server in `off` that is no
 * longer connected kept, so it can be turned back on.
 */
export function mcpRows(
  toolNames: readonly string[],
  sizes: readonly { serverName: string; tokens: number; isLoaded: boolean }[],
  off: readonly string[],
  self: string,
): McpRow[] {
  const servers = new Map<string, { tools: string[]; tokens: number }>()
  for (const tool of toolNames) {
    const server = mcpServerOf(tool)
    if (server === undefined || server === self) continue
    const one = servers.get(server) ?? { tools: [], tokens: 0 }
    one.tools.push(tool.slice(`mcp__${server}__`.length))
    servers.set(server, one)
  }
  for (const size of sizes) {
    const one = servers.get(size.serverName)
    if (one !== undefined && size.isLoaded) one.tokens += size.tokens
  }
  for (const server of off) if (!servers.has(server)) servers.set(server, { tools: [], tokens: 0 })

  return [...servers.entries()]
    .map(([name, one]) => ({
      name,
      tools: one.tools.length,
      tokens: one.tokens,
      needsSignIn: one.tools.length > 0 && one.tools.every(tool => SIGN_IN_TOOLS.has(tool)),
      isOff: off.includes(name),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

/** One line over the list: how many, how many on, how many need sign-in, and their weight. */
export function mcpSummary(rows: readonly McpRow[]): string {
  const on = rows.filter(row => !row.isOff)
  const signIn = rows.filter(row => row.needsSignIn).length
  const upFront = on.reduce((sum, row) => sum + row.tokens, 0)

  return `${rows.length} servers · ${on.length} on · ${signIn} need sign-in · ${tokens(upFront)} tokens of tools up front`
}

// The pane's bulk actions hold x and o, so no row takes them.
const ROW_KEYS = '123456789abcdefghijklmnpqrstuvwyz'

/** The pane key of the row at `index`: 1-9, then a-z without o and x; none past that. */
export function rowKey(index: number): string | undefined {
  return ROW_KEYS[index]
}

export type McpArgs = { verb: 'pane' } | { verb: 'list' } | { verb: 'off' | 'on'; names: string[] } | { verb: 'unknown' }

export function parseMcpArgs(args: string): McpArgs {
  const [verb = '', ...names] = args.trim().split(/\s+/).filter(Boolean)
  switch (verb.toLowerCase()) {
    case '':
      return { verb: 'pane' }
    case 'list':
      return { verb: 'list' }
    case 'off':
    case 'on':
      return { verb: verb.toLowerCase() as 'off' | 'on', names }
    default:
      return { verb: 'unknown' }
  }
}

/**
 * The servers the names point to, in the order given and each once: a whole
 * name in any case, else a part only one server has; `unused` is every server
 * needing sign-in, `all` every server, each not already switched that way.
 * A name that points nowhere, or to several, is a problem instead.
 */
export function resolveMcp(verb: 'off' | 'on', names: readonly string[], rows: readonly McpRow[], self: string): { targets: string[]; problems: string[] } {
  const targets: string[] = []
  const problems: string[] = []
  const pending = rows.filter(row => row.isOff !== (verb === 'off'))
  const add = (name: string) => {
    if (!targets.includes(name)) targets.push(name)
  }
  for (const given of names) {
    const wanted = given.toLowerCase()
    if (wanted === 'unused') {
      for (const row of pending) if (row.needsSignIn) add(row.name)
      continue
    }
    if (wanted === 'all') {
      for (const row of pending) add(row.name)
      continue
    }
    if (wanted === self.toLowerCase()) {
      problems.push('Nexus keeps its own tools on')
      continue
    }
    const exact = rows.find(row => row.name.toLowerCase() === wanted)
    const matches = exact === undefined ? rows.filter(row => row.name.toLowerCase().includes(wanted)) : [exact]
    const [only] = matches
    if (only === undefined) problems.push(`No MCP server matches "${given}"`)
    else if (matches.length > 1) problems.push(`"${given}" matches ${matches.length} servers: ${matches.map(row => row.name).join(', ')}`)
    else add(only.name)
  }

  return { targets, problems }
}

/** What a switch did, for the command's answer and the pane's toast. */
export function mcpChangeText(verb: 'off' | 'on', targets: readonly string[]): string {
  if (targets.length === 0) return verb === 'off' ? 'Nothing to change: those servers are already off.' : 'Nothing to change: those servers are already on.'
  if (verb === 'on') return targets.length === 1 ? `"${targets[0]}" is on again in this project.` : `On again in this project: ${targets.join(', ')}.`
  if (targets.length === 1) {
    return `"${targets[0]}" is off in this project: its tools wait behind ToolSearch with a one-line note, and a call to one is refused. /mcp-nexus on ${targets[0]} brings it back.`
  }

  return `Off in this project: ${targets.join(', ')}. Their tools wait behind ToolSearch with a one-line note, and a call to one is refused. /mcp-nexus on <name> brings one back.`
}

/** A row as the list and the pane draw it, the name clipped to `width`. */
export function mcpRowText(row: McpRow, width: number): string {
  const status = row.isOff ? '○ off' : '● on '

  return `${status}  ${clip(row.name, width).padEnd(width)}${String(row.tools).padStart(5)} tools ${tokens(row.tokens).padStart(6)}${row.needsSignIn ? '  sign-in' : ''}`
}

/** Text for `/mcp-nexus list`. */
export function mcpListText(rows: readonly McpRow[]): string {
  if (rows.length === 0) return 'No MCP server is connected to this session.'
  const width = Math.min(NAME_WIDTH, Math.max(...rows.map(row => row.name.length)))

  return [
    'MCP servers in this project (tokens: tools kept in front of Claude):',
    ...rows.map(row => `  ${mcpRowText(row, width)}`),
    '',
    '0 tokens: already behind ToolSearch, so turning it off only blocks calls.',
    '/mcp-nexus opens the switcher · off|on <names…> · off unused · on all · /context-nexus shows where the rest of the context goes',
  ].join('\n')
}
