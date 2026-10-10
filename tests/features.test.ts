import { describe, expect, test } from 'claude-code/testing'

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
} as const

describe('loop detector', () => {
  test('a call failing three times running tells Claude to change approach', { options: { ...BASE, loopGuard: true } }, async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true }))
    const answers = []
    for (let i = 0; i < 3; i++) answers.push(await $.tool.call({ tool: 'Bash', command: 'npm test' }))
    expect(answers[1]?.context ?? []).toEqual([])
    expect((answers[2]?.context ?? []).join(' ')).toContain('failed 3 times in a row')
  })

  test('off, it never speaks', { options: BASE }, async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true }))
    let last
    for (let i = 0; i < 3; i++) last = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(last?.context ?? []).toEqual([])
  })
})

describe('compaction guard', () => {
  test('compaction is told what to keep', { options: { ...BASE, compactGuard: true } }, async ($, on) => {
    let seen: string | undefined
    on('session.compact', (_, e) => {
      seen = e.instructions
      return { skip: 'test' } as never
    })
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'Add a parser', toolUses: [] }], instructions: 'Focus on the parser.' } as never).catch(() => undefined)
    expect(seen).toContain('Focus on the parser.')
    expect(seen).toContain('Every file path read, created or changed')
  })
})

describe('subagent cap', () => {
  test('a subagent past the cap is refused', { options: { ...BASE, maxAgents: 1 } }, async ($, on) => {
    on('agent.list', () => ({ value: [{ id: 'a1', description: 'busy', type: 'Explore', status: 'running' }] }) as never)
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a2' }))
    const answer = await $.agent.spawn({
      tool_use_id: 't1',
      prompt: 'look around',
      description: 'look',
      subagentType: 'Explore',
      provider: { kind: 'tool' } as never,
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })
    expect(answer.deny).toContain('at most 1 subagents')
  })
})

describe('turn end', () => {
  // Raises the end of a main-thread turn as the engine does.
  const finish = ($: { turn: { complete: (input: never) => Promise<unknown> } }, answer: string, durationMs: number) =>
    $.turn.complete({ answer, durationMs, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)

  test('the next step is offered as the suggestion', { options: { ...BASE, suggestNext: true } }, async ($, on) => {
    const offered: string[] = []
    const slept: number[] = []
    on('clock.sleep', (_, e) => {
      slept.push(1)
      return { value: undefined }
    })
    on('clock.now', () => ({ value: 1000 }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('prompt.suggest', (_, e) => {
      offered.push(e.text)
      return { isShown: true }
    })
    await finish($, '**What Changed**\n- a.ts\n\n**Next Steps**\n- Run the app and try the login', 2000)
    for (let i = 0; i < 500 && offered.length === 0; i++) await Promise.resolve()
    expect({ slept: slept.length, offered }).toEqual({ slept: 1, offered: ['Run the app and try the login'] })
  })

  test('a long turn raises the done alert, a short one does not', { options: { ...BASE, notify: true, notifyAfterSec: 30 } }, async ($, on) => {
    const sent: string[] = []
    on('clock.now', () => ({ value: 1000 }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('ui.notify', (_, e) => {
      sent.push(String((e as { text?: unknown }).text ?? ''))
      return { value: { isSent: true, channel: 'test' } } as never
    })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
    on('fs.exists', () => ({ value: false }))
    on('env.get', () => ({ value: undefined }))
    on('session.root', () => ({ value: 'D:/work/shop' }))
    await finish($, 'All set.', 5000)
    await finish($, 'Refactor finished, tests pass.', 95_000)
    for (let i = 0; i < 10 && sent.length === 0; i++) await Promise.resolve()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Done in 2m: Refactor finished, tests pass.')
  })
})
