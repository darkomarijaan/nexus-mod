import { describe, expect, mock, test } from 'claude-code/testing'

import {
  anchorText,
  contextReport,
  crossedWindows,
  footerText,
  isNoisyCommand,
  lastRequestIn,
  mcpServerOf,
  trimOutput,
} from '../hooks/lean'

// Each test turns on the module it covers; the rest stay out of the way.
const BASE = {
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

const npmInstall = [
  ...Array.from({ length: 300 }, (_, i) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} 12ms`),
  'npm warn deprecated inflight@1.0.6: This module is not supported',
  ...Array.from({ length: 100 }, (_, i) => `  ✓ test case ${i} (3 ms)`),
  'added 812 packages, and audited 813 packages in 14s',
  'found 0 vulnerabilities',
].join('\n')

describe('trimming noisy output', () => {
  test('routine lines fold, problems and the end stay', () => {
    const cut = trimOutput(npmInstall)
    expect(cut).toBeDefined()
    expect(cut?.text).toContain('npm warn deprecated inflight')
    expect(cut?.text).toContain('found 0 vulnerabilities')
    expect(cut?.text).toContain('more lines like it')
    expect((cut?.text.split('\n').length ?? 0) < 40).toBe(true)
    expect(cut?.dropped ?? 0).toBeGreaterThan(350)
  })

  test('short output and output that will not fold are left alone', () => {
    expect(trimOutput('ok\ndone')).toBeUndefined()
    const prose = Array.from({ length: 200 }, (_, i) => `line ${i} of a story with different words ${i * 7}`).join('\n')
    expect(trimOutput(prose)?.text ?? '').toContain('lines trimmed')
  })

  test('only installs, builds, tests and logs are trimmed, never a file being printed', () => {
    expect(isNoisyCommand('npm install')).toBe(true)
    expect(isNoisyCommand('python -m pytest -q')).toBe(true)
    expect(isNoisyCommand('git log --stat')).toBe(true)
    expect(isNoisyCommand('cat src/app.ts')).toBe(false)
    expect(isNoisyCommand('git diff')).toBe(false)
    expect(isNoisyCommand('Get-Content big.log')).toBe(false)
  })

  test('a long npm install reaches Claude folded, with a pointer to the whole', { options: { ...BASE, trimOutput: true } }, async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: npmInstall, stderr: '', interrupted: false } }))
    const answer = await $.tool.call({ tool: 'Bash', command: 'npm install' })
    const stdout = (answer.result as { stdout: string }).stdout
    expect(stdout).toContain('[Nexus folded')
    expect(stdout.length < npmInstall.length / 4).toBe(true)
  })

  test('off, output reaches Claude whole', { options: BASE }, async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: npmInstall, stderr: '', interrupted: false } }))
    const answer = await $.tool.call({ tool: 'Bash', command: 'npm install' })
    expect((answer.result as { stdout: string }).stdout).toBe(npmInstall)
  })
})

describe('after compaction', () => {
  test('the anchor carries the request word for word, open tasks only, and CLAUDE.md', () => {
    const text = anchorText({
      request: 'Add a CSV export to the orders page, keep the old JSON one',
      tasks: [
        { label: 'Write the exporter', status: 'completed' },
        { label: 'Wire the button', status: 'in_progress' },
      ],
      files: ['src/orders.ts'],
      checks: 'lint ✓ test ✗',
      claudeMd: '# Rules\nUse pnpm.',
    })
    expect(text).toContain('Add a CSV export to the orders page, keep the old JSON one')
    expect(text).toContain('[in progress] Wire the button')
    expect(text).not.toContain('Write the exporter')
    expect(text).toContain('Use pnpm.')
    expect(text).toContain('src/orders.ts')
  })

  test('the last request is the newest message the person typed', () => {
    expect(
      lastRequestIn([
        { role: 'user', text: 'Build the parser' },
        { role: 'assistant', text: 'On it' },
        { role: 'user', text: '', toolResults: [{}] },
        { role: 'user', text: '<system-reminder>todo</system-reminder>' },
      ]),
    ).toBe('Build the parser')
  })

  test('the next prompt after a compaction carries the anchor', { options: { ...BASE, compactGuard: true } }, async ($, on) => {
    let context: readonly string[] = []
    on('session.root', () => ({ value: 'C:/app' }))
    on('fs.read', () => ({ value: '# Rules\nUse pnpm.' }))
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'Summary of earlier work', toolUses: [] }] }) as never)
    on('prompt.submit', (_, e) => {
      context = e.context ?? []
      return { text: e.text }
    })
    await $.session.compact({
      trigger: 'manual',
      messages: [{ role: 'user', text: 'Rename every Order to Purchase in src/', toolUses: [] }],
    } as never)
    await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' } } as never)
    expect(context.join('\n')).toContain('Rename every Order to Purchase in src/')
    expect(context.join('\n')).toContain('Use pnpm.')
    context = []
    await $.prompt.submit({ text: 'and then?', origin: { kind: 'composer' } } as never)
    expect(context).toEqual([])
  })
})

describe('MCP servers per project', () => {
  test('a server is read from the tool name', () => {
    expect(mcpServerOf('mcp__playwright__browser_click')).toBe('playwright')
    expect(mcpServerOf('mcp__plugin_context7_context7__query')).toBe('plugin_context7_context7')
    expect(mcpServerOf('Bash')).toBeUndefined()
  })

  test('a server turned off is refused and described as off', { options: BASE }, async ($, on) => {
    mock.store(on)
    on('session.root', () => ({ value: 'C:/app' }))
    on('tool.list', () => ({ value: [{ name: 'mcp__figma__get_file', description: 'Get a file', mcp: true }] }) as never)
    on('tool.call', { tool: 'mcp__figma__get_file' }, () => ({ result: {} as never }))
    const off = await $.command.run({ command: 'mcp-nexus', args: 'off figma' } as never)
    expect(off.text).toContain('is off in this project')
    const call = await $.tool.call({ tool: 'mcp__figma__get_file' } as never)
    expect(call.deny).toContain('/mcp-nexus on figma')
    const listed = await $.command.run({ command: 'mcp-nexus', args: '' } as never)
    expect(listed.text).toContain('○ off  figma')
    await $.command.run({ command: 'mcp-nexus', args: 'on figma' } as never)
    expect((await $.tool.call({ tool: 'mcp__figma__get_file' } as never)).deny).toBeUndefined()
  })

  test('an unknown server is not turned off', { options: BASE }, async ($, on) => {
    mock.store(on)
    on('session.root', () => ({ value: 'C:/app' }))
    on('tool.list', () => ({ value: [] }) as never)
    expect((await $.command.run({ command: 'mcp-nexus', args: 'off nope' } as never)).text).toContain('No MCP server "nope"')
  })
})

describe('context audit', () => {
  const breakdown = {
    model: 'claude-opus-5-5',
    totalTokens: 52_000,
    rawMaxTokens: 200_000,
    percentage: 26,
    autoCompactThreshold: 167_000,
    categories: [
      { name: 'System tools', tokens: 14_000, color: '', isDeferred: false, kind: 'used' as const },
      { name: 'MCP tools', tokens: 6_000, color: '', isDeferred: false, kind: 'used' as const },
      { name: 'Free space', tokens: 140_000, color: '', isDeferred: false, kind: 'free' as const },
    ],
    mcpTools: [
      ...Array.from({ length: 20 }, (_, i) => ({ name: `mcp__playwright__t${i}`, serverName: 'playwright', tokens: 250, isLoaded: true })),
      { name: 'mcp__figma__x', serverName: 'figma', tokens: 300, isLoaded: false },
    ],
    memoryFiles: [{ path: 'C:/app/CLAUDE.md', type: 'Project', tokens: 3_100 }],
    agents: [{ agentType: 'reviewer', source: 'plugin', tokens: 400 }],
    skills: {
      totalSkills: 30,
      includedSkills: 30,
      tokens: 2_000,
      skillFrontmatter: Array.from({ length: 10 }, (_, i) => ({ name: `seo-${i}`, source: 'plugin', pluginName: 'searchfit-seo', tokens: 120 })),
    },
  }

  test('the report names the heavy parts and what to do about them', () => {
    const text = contextReport(breakdown, ['figma'], 'C:/app')
    expect(text).toContain('Context on claude-opus-5-5: 52k of 200k (26%)')
    expect(text).toContain('/mcp-nexus off playwright')
    expect(text).toContain('[off here]')
    expect(text).toContain('"searchfit-seo" lists 10 skills')
    expect(text).toContain('C:/app/CLAUDE.md costs 3.1k in this project')
  })

  test('a lean context gets no suggestions', () => {
    const lean = { ...breakdown, mcpTools: [], memoryFiles: [], agents: [], skills: undefined }
    expect(contextReport(lean, [], 'C:/app')).toContain('Nothing heavy')
  })
})

describe('quota guard', () => {
  const limits = [
    { kind: 'five_hour', percentUsed: 91, resetsAt: 5000 },
    { kind: 'seven_day', percentUsed: 40, resetsAt: 9000 },
    { kind: 'spend_limit', percentUsed: 99, resetsAt: null },
  ]

  test('a window past the guard is raised once per reset', () => {
    expect(crossedWindows(limits, 90, new Set()).map(one => one.kind)).toEqual(['five_hour'])
    expect(crossedWindows(limits, 90, new Set(['five_hour:5000']))).toEqual([])
    expect(crossedWindows([{ kind: 'five_hour', percentUsed: 91, resetsAt: 6000 }], 90, new Set(['five_hour:5000']))).toHaveLength(1)
    expect(crossedWindows(limits, 0, new Set())).toEqual([])
  })
})

describe('turn footer', () => {
  test('one line: time, tools, files, context, checks', () => {
    expect(footerText({ durationMs: 192_000, tools: 14, files: 4, contextPct: 42, checks: 'passed' })).toBe('⏱ 3m 12s · 14 tools · 4 files · ctx 42% · checks ✓')
    expect(footerText({ durationMs: 8_000, tools: 1, files: 0, contextPct: null, checks: null })).toBe('⏱ 8s · 1 tool')
  })

  test('a turn that ran tools ends with the footer under its answer', { options: { ...BASE, turnFooter: true } }, async ($, on) => {
    on('clock.now', () => ({ value: 1000 }))
    on('session.root', () => ({ value: 'C:/app' }))
    on('tool.call', { tool: 'Read' }, () => ({ result: {} as never }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    await $.tool.call({ tool: 'Read', file_path: 'C:/app/a.ts' } as never)
    const done = await $.turn.complete({ answer: 'Done.', durationMs: 65_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    expect(done.text).toBe('⏱ 1m 5s · 1 tool')
  })
})

describe('prompt keys as commands', () => {
  test('/enhance-nexus puts the rewrite in the prompt box', { options: BASE }, async ($, on) => {
    const filled: string[] = []
    let asked = ''
    on('session.root', () => ({ value: 'C:/app' }))
    on('fs.read', () => ({ value: '' }))
    on('fs.list', () => ({ value: [] }))
    on('command.list', () => ({ value: [] }) as never)
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('model.complete', (_, e) => {
      asked = String((e as { prompt?: unknown }).prompt ?? '')
      return { value: { isAnswered: true, text: 'Goal: a CSV export on the orders page', usage: {} } } as never
    })
    on('prompt.fill', (_, e) => {
      filled.push(e.text)
      return { isFilled: true } as never
    })
    const answer = await $.command.run({ command: 'enhance-nexus', args: 'csv export di halaman order' } as never)
    for (let i = 0; i < 2000 && filled.length === 0; i++) await Promise.resolve()
    expect(answer.text).toContain('prompt box')
    expect(asked).toContain('csv export di halaman order')
    expect(filled).toEqual(['Goal: a CSV export on the orders page'])
  })

  test('/enhance-nexus with nothing after it says how to use it', { options: BASE }, async $ => {
    expect((await $.command.run({ command: 'enhance-nexus', args: '' } as never)).text).toContain('/enhance-nexus add a CSV export')
  })
})
