import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { mcpListText, mcpRows, mcpSummary, parseMcpArgs, resolveMcp, rowKey } from '../hooks/mcp'

const QUIET = {
  checkpoints: false,
  autoVerify: false,
  designLens: false,
  assumptionAudit: 'off',
  handoff: false,
  notify: false,
  suggestNext: false,
  compactGuard: false,
  loopGuard: false,
  trimOutput: false,
  quotaGuard: 0,
  turnFooter: false,
} as const

const TOOLS = [
  ...Array.from({ length: 3 }, (_, i) => `mcp__plugin_playwright_playwright__browser_${i}`),
  'mcp__claude_ai_Gmail__search_threads',
  'mcp__claude_ai_Gmail__get_thread',
  'mcp__claude_ai_Figma__authenticate',
  'mcp__claude_ai_Figma__complete_authentication',
  'mcp__plugin_design_figma__authenticate',
  'mcp__plugin_design_figma__complete_authentication',
  'mcp__claude_ai_Windsor_ai_for_Social_Media__authenticate',
  'mcp__nexus__design_options',
  'Bash',
]
const SIZES = [{ serverName: 'plugin_playwright_playwright', tokens: 1800, isLoaded: true }]

describe('MCP rows', () => {
  test('one row per server, the heaviest first, Nexus itself and built-in tools left out', () => {
    const rows = mcpRows(TOOLS, SIZES, [], 'nexus')
    expect(rows.map(row => row.name)).toEqual([
      'plugin_playwright_playwright',
      'claude_ai_Figma',
      'claude_ai_Gmail',
      'claude_ai_Windsor_ai_for_Social_Media',
      'plugin_design_figma',
    ])
    expect(rows[0]).toEqual({ name: 'plugin_playwright_playwright', tools: 3, tokens: 1800, needsSignIn: false, isOff: false })
  })

  test('a server with only sign-in tools needs sign-in', () => {
    const rows = mcpRows(TOOLS, SIZES, [], 'nexus')
    const signIn = rows.filter(row => row.needsSignIn).map(row => row.name)
    expect(signIn).toEqual(['claude_ai_Figma', 'claude_ai_Windsor_ai_for_Social_Media', 'plugin_design_figma'])
  })

  test('a server turned off but no longer connected still has a row, so it can come back on', () => {
    const rows = mcpRows(TOOLS, SIZES, ['old_server'], 'nexus')
    expect(rows.find(row => row.name === 'old_server')).toEqual({ name: 'old_server', tools: 0, tokens: 0, needsSignIn: false, isOff: true })
  })

  test('the summary counts servers, those on, those needing sign-in and the tokens up front', () => {
    const rows = mcpRows(TOOLS, SIZES, ['claude_ai_Gmail'], 'nexus')
    expect(mcpSummary(rows)).toBe('5 servers · 4 on · 3 need sign-in · 1.8k tokens of tools up front')
  })

  test('row keys run 1-9 then letters, skipping o and x, for 33 rows', () => {
    expect([0, 8, 9, 22, 23, 32, 33].map(rowKey)).toEqual(['1', '9', 'a', 'n', 'p', 'z', undefined])
    const keys = Array.from({ length: 33 }, (_, i) => rowKey(i))
    expect(keys).not.toContain('o')
    expect(keys).not.toContain('x')
    expect(new Set(keys).size).toBe(33)
  })
})

describe('MCP arguments', () => {
  test('nothing opens the pane; list, off and on take names', () => {
    expect(parseMcpArgs('')).toEqual({ verb: 'pane' })
    expect(parseMcpArgs(' list ')).toEqual({ verb: 'list' })
    expect(parseMcpArgs('OFF gmail  calendar')).toEqual({ verb: 'off', names: ['gmail', 'calendar'] })
    expect(parseMcpArgs('on')).toEqual({ verb: 'on', names: [] })
    expect(parseMcpArgs('toggle x')).toEqual({ verb: 'unknown' })
  })

  const rows = mcpRows(TOOLS, SIZES, ['claude_ai_Gmail'], 'nexus')

  test('a whole name, any case, or a part only one server has', () => {
    expect(resolveMcp('off', ['CLAUDE_AI_FIGMA'], rows, 'nexus')).toEqual({ targets: ['claude_ai_Figma'], problems: [] })
    expect(resolveMcp('off', ['playwright', 'windsor'], rows, 'nexus')).toEqual({
      targets: ['plugin_playwright_playwright', 'claude_ai_Windsor_ai_for_Social_Media'],
      problems: [],
    })
  })

  test('a part several servers share is a problem naming them', () => {
    const answer = resolveMcp('off', ['figma'], rows, 'nexus')
    expect(answer.targets).toEqual([])
    expect(answer.problems).toEqual(['"figma" matches 2 servers: claude_ai_Figma, plugin_design_figma'])
  })

  test('an unknown name and Nexus itself are problems', () => {
    expect(resolveMcp('off', ['nope'], rows, 'nexus').problems).toEqual(['No MCP server matches "nope"'])
    expect(resolveMcp('off', ['nexus'], rows, 'nexus').problems).toEqual(['Nexus keeps its own tools on'])
  })

  test('unused is every server needing sign-in not yet switched that way; all is every server not yet switched', () => {
    expect(resolveMcp('off', ['unused'], rows, 'nexus').targets).toEqual(['claude_ai_Figma', 'claude_ai_Windsor_ai_for_Social_Media', 'plugin_design_figma'])
    expect(resolveMcp('on', ['all'], rows, 'nexus').targets).toEqual(['claude_ai_Gmail'])
    expect(resolveMcp('off', ['all'], rows, 'nexus').targets).toEqual(rows.filter(row => !row.isOff).map(row => row.name))
  })

  test('a name given twice is changed once', () => {
    expect(resolveMcp('off', ['gmail', 'claude_ai_gmail'], rows, 'nexus').targets).toEqual(['claude_ai_Gmail'])
  })
})

describe('MCP list text', () => {
  test('columns fit the longest name up to 28, longer ones clipped; off and sign-in marked', () => {
    const text = mcpListText(mcpRows(TOOLS, SIZES, ['claude_ai_Gmail'], 'nexus'))
    expect(text).toContain('  ● on   plugin_playwright_playwright    3 tools   1.8k\n')
    expect(text).toContain(`  ○ off  ${'claude_ai_Gmail'.padEnd(28)}    2 tools      0\n`)
    expect(text).toContain('  ● on   claude_ai_Windsor_ai_for_So…    1 tools      0  sign-in\n')
    expect(text).toContain('0 tokens: already behind ToolSearch')
    expect(text).toContain('/mcp-nexus opens the switcher')
  })

  test('no servers says so', () => {
    expect(mcpListText([])).toBe('No MCP server is connected to this session.')
  })
})

/** A store the test can read back: what the plugin saved, by key. */
function memoryStore(on: On): Record<string, unknown> {
  const now: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: now[e.key] }) as never)
  on('store.set', (_, e) => {
    now[e.key] = e.value
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => {
    delete now[e.key]
    return { value: undefined } as never
  })
  return now
}

function connect(on: On): Record<string, unknown> {
  const store = memoryStore(on)
  on('session.root', () => ({ value: 'C:/app' }))
  on('tool.list', () => ({ value: TOOLS.map(name => ({ name, description: name, mcp: name.startsWith('mcp__') })) }) as never)
  on('session.usage', () => ({ value: { context: { breakdown: { mcpTools: SIZES } } } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }) as never)
  return store
}

const offIn = (store: Record<string, unknown>) => Object.entries(store).find(([key]) => key.startsWith('mcpOff.'))?.[1]

describe('/mcp-nexus', () => {
  test('several parts of names at once turn those servers off', { options: QUIET }, async ($, on) => {
    const store = connect(on)
    const answer = await $.command.run({ command: 'mcp-nexus', args: 'off gmail windsor' } as never)
    expect(answer.text).toContain('Off in this project: claude_ai_Gmail, claude_ai_Windsor_ai_for_Social_Media.')
    expect(offIn(store)).toEqual(['claude_ai_Gmail', 'claude_ai_Windsor_ai_for_Social_Media'])
    expect((await $.tool.call({ tool: 'mcp__claude_ai_Gmail__get_thread' } as never)).deny).toContain('turned off')
  })

  test('an ambiguous part changes nothing and names the matches', { options: QUIET }, async ($, on) => {
    const store = connect(on)
    const answer = await $.command.run({ command: 'mcp-nexus', args: 'off gmail figma' } as never)
    expect(answer.text).toContain('"figma" matches 2 servers')
    expect(answer.text).toContain('Nothing changed')
    expect(offIn(store)).toBeUndefined()
  })

  test('off unused, then on all', { options: QUIET }, async ($, on) => {
    const store = connect(on)
    expect((await $.command.run({ command: 'mcp-nexus', args: 'off unused' } as never)).text).toContain('Off in this project: claude_ai_Figma')
    expect(offIn(store)).toEqual(['claude_ai_Figma', 'claude_ai_Windsor_ai_for_Social_Media', 'plugin_design_figma'])
    expect((await $.command.run({ command: 'mcp-nexus', args: 'on all' } as never)).text).toContain('On again in this project')
    expect(offIn(store)).toEqual([])
  })

  test('unused with nothing needing sign-in says so', { options: QUIET }, async ($, on) => {
    connect(on)
    await $.command.run({ command: 'mcp-nexus', args: 'off unused' } as never)
    expect((await $.command.run({ command: 'mcp-nexus', args: 'off unused' } as never)).text).toContain('Nothing to change')
  })

  test('the switcher pane: a key per server, a press toggles it and saves it', { options: QUIET }, async ($, on) => {
    const store = connect(on)
    expect((await $.command.run({ command: 'mcp-nexus', args: '' } as never)).text).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-mcp', props: PANE })
    const row = (await ui.find({ key: 'mcp-claude_ai_Gmail' })) as { props?: { hotkey?: string } } | undefined
    expect(row?.props?.hotkey).toBe('3')
    expect(await ui.find({ type: 'Text', text: /5 servers · 5 on · 3 need sign-in · 1.8k tokens/ })).toBeDefined()
    await ui.press({ key: 'mcp-claude_ai_Gmail' })
    expect(offIn(store)).toEqual(['claude_ai_Gmail'])
    expect(await ui.find({ type: 'Text', text: /4 on/ })).toBeDefined()
    await ui.press({ key: 'mcp-claude_ai_Gmail' })
    expect(offIn(store)).toEqual([])
    await ui.unmount()
  })

  test('the switcher pane: off for every server needing sign-in, then all on', { options: QUIET }, async ($, on) => {
    const store = connect(on)
    await $.command.run({ command: 'mcp-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-mcp', props: PANE })
    expect(((await ui.find({ key: 'mcp-unused' })) as { props?: { hotkey?: string } } | undefined)?.props?.hotkey).toBe('x')
    await ui.press({ key: 'mcp-unused' })
    expect(offIn(store)).toEqual(['claude_ai_Figma', 'claude_ai_Windsor_ai_for_Social_Media', 'plugin_design_figma'])
    await ui.press({ key: 'mcp-allon' })
    expect(offIn(store)).toEqual([])
    await ui.unmount()
  })
})

const PANE = { title: 'MCP servers', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
