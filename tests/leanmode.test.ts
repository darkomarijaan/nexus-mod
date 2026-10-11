import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { readConfig } from '../hooks/config'
import { nextStepFrom } from '../hooks/insights'
import { footerText } from '../hooks/lean'
import {
  backupName,
  checkCompressed,
  compressTarget,
  isOverride,
  isSafeBase,
  leanBadge,
  leanLabel,
  leanRules,
  leanSettings,
  parseLeanArgs,
  readLeanPick,
  reviewPrompt,
  summaryRules,
  untrackedFiles,
  unwrapFence,
} from '../hooks/leanmode'

describe('lean settings', () => {
  test('a stored pick keeps only valid fields', () => {
    expect(readLeanPick({ talk: 'ultra', code: false })).toEqual({ talk: 'ultra', code: false })
    expect(readLeanPick({ talk: 'mega', code: 'yes' })).toEqual({})
    expect(readLeanPick(null)).toEqual({})
    expect(readLeanPick('lite')).toEqual({})
  })

  test('a pick beats the settings field by field', () => {
    const base = { talk: 'lite', code: true } as const
    expect(leanSettings(base, {})).toEqual(base)
    expect(leanSettings(base, { talk: 'ultra' })).toEqual({ talk: 'ultra', code: true })
    expect(leanSettings(base, { code: false })).toEqual({ talk: 'lite', code: false })
    expect(isOverride({})).toBe(false)
    expect(isOverride({ code: true })).toBe(true)
  })

  test('the config reads lean talk and minimal code with safe defaults', () => {
    expect(readConfig({} as never).leanTalk).toBe('lite')
    expect(readConfig({} as never).leanCode).toBe(true)
    expect(readConfig({ leanTalk: ' ULTRA ' } as never).leanTalk).toBe('ultra')
    expect(readConfig({ leanTalk: 'mega' } as never).leanTalk).toBe('lite')
    expect(readConfig({ leanCode: false } as never).leanCode).toBe(false)
  })
})

describe('lean rules', () => {
  test('lite cuts preamble and recaps but keeps payloads exact', () => {
    const text = leanRules({ talk: 'lite', code: false })
    expect(text).toContain('Nexus lean: lite')
    expect(text).toContain('Lead with the answer')
    expect(text).toContain('Keep code, commands, paths, error text and numbers exact')
    expect(text).toContain('security warnings')
    expect(text).not.toContain('Telegraphic')
    expect(text).not.toContain('Minimal code')
  })

  test('ultra adds the telegraphic style and never drops a negation', () => {
    const text = leanRules({ talk: 'ultra', code: false })
    expect(text).toContain('Telegraphic')
    expect(text).toContain('Never drop a negation')
    expect(text).toContain('tidak, bukan, jangan, hanya')
  })

  test('minimal code is the ladder with what is never cut', () => {
    const text = leanRules({ talk: 'off', code: true })
    expect(text).toContain('Minimal code (Nexus lean)')
    expect(text).toContain('Already in the codebase? Reuse it.')
    expect(text).toContain('Add a new one only after asking')
    expect(text).toContain('Never cut: validation at trust boundaries')
    expect(text).not.toContain('Terse replies')
  })

  test('all off is empty, and the largest set stays near 400 tokens', () => {
    expect(leanRules({ talk: 'off', code: false })).toBe('')
    expect(leanRules({ talk: 'ultra', code: true }).length).toBeLessThanOrEqual(1600)
  })

  test('the summary is terse when talk is on and keeps all three headings', () => {
    for (const talk of ['off', 'lite', 'ultra'] as const) {
      const text = summaryRules(talk)
      expect(text).toContain('**What Changed**')
      expect(text).toContain('**Verification Status**')
      expect(text).toContain('**Next Steps**')
    }
    expect(summaryRules('off')).toContain('plain English for a non-specialist')
    expect(summaryRules('lite')).toContain('one short line per file')
    expect(summaryRules('lite')).toContain('skipped or left unchecked')
  })

  test('a terse report still feeds the next-step suggestion', () => {
    const answer = '**What Changed**: hooks/a.ts: adds the parser\n**Verification Status**: tests pass\n**Next Steps**: Run the app'
    expect(nextStepFrom(answer)).toBe('Run the app')
  })
})

describe('/lean-nexus arguments', () => {
  test('every valid form', () => {
    expect(parseLeanArgs('')).toEqual({ kind: 'status' })
    expect(parseLeanArgs('reset')).toEqual({ kind: 'reset' })
    expect(parseLeanArgs('on')).toEqual({ kind: 'set', pick: { talk: 'lite', code: true } })
    expect(parseLeanArgs('off')).toEqual({ kind: 'set', pick: { talk: 'off', code: false } })
    expect(parseLeanArgs('talk ultra')).toEqual({ kind: 'set', pick: { talk: 'ultra' } })
    expect(parseLeanArgs('code off')).toEqual({ kind: 'set', pick: { code: false } })
    expect(parseLeanArgs('talk off code on')).toEqual({ kind: 'set', pick: { talk: 'off', code: true } })
  })

  test('casing and extra spaces do not matter', () => {
    expect(parseLeanArgs('  Talk   ULTRA ')).toEqual({ kind: 'set', pick: { talk: 'ultra' } })
  })

  test('a typo is refused with the valid forms', () => {
    for (const bad of ['talk mega', 'code maybe', 'talk', 'fast', 'reset now']) {
      const parsed = parseLeanArgs(bad)
      expect(parsed.kind).toBe('error')
      if (parsed.kind === 'error') expect(parsed.text).toContain('/lean-nexus [talk off|lite|ultra]')
    }
  })
})

describe('lean label and badge', () => {
  test('the label names both modes', () => {
    expect(leanLabel({ talk: 'lite', code: true })).toBe('Talk: lite · Minimal code: on')
    expect(leanLabel({ talk: 'off', code: false })).toBe('Talk: off · Minimal code: off')
  })

  test('the badge shows what is on and hides when nothing is', () => {
    expect(leanBadge({ talk: 'lite', code: true }, '✂')).toBe('✂ lite · min')
    expect(leanBadge({ talk: 'ultra', code: false }, '✂')).toBe('✂ ultra')
    expect(leanBadge({ talk: 'off', code: true }, '[lean]')).toBe('[lean] min')
    expect(leanBadge({ talk: 'off', code: false }, '✂')).toBeNull()
  })
})

// Only the delivery rules under test: every other module stays out of the way.
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

const FACTS = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: ['Bash', 'Edit'],
  outputStyle: null,
  traits: [],
} as const

describe('lean rules in the system prompt', () => {
  test('the defaults join lite talk, minimal code and the terse summary', { options: BASE }, async ($, on) => {
    on('prompt.compose', () => ({ sections: [] }))
    const { sections } = await $.prompt.compose(FACTS as never)
    const ours = sections.filter(section => section.id === 'nexus:delivery')
    expect(ours).toHaveLength(1)
    expect(ours[0]?.text).toContain('Nexus lean: lite')
    expect(ours[0]?.text).toContain('Minimal code (Nexus lean)')
    expect(ours[0]?.text).toContain('one short line per file')
  })

  test('talk off brings the full report back', { options: { ...BASE, leanTalk: 'off' } }, async ($, on) => {
    on('prompt.compose', () => ({ sections: [] }))
    const text = (await $.prompt.compose(FACTS as never)).sections.find(section => section.id === 'nexus:delivery')?.text ?? ''
    expect(text).toContain('plain English for a non-specialist')
    expect(text).not.toContain('Terse replies')
  })

  test('without the executive summary the talk rules still hold', { options: { ...BASE, executiveSummary: false } }, async ($, on) => {
    on('prompt.compose', () => ({ sections: [] }))
    const text = (await $.prompt.compose(FACTS as never)).sections.find(section => section.id === 'nexus:delivery')?.text ?? ''
    expect(text).toContain('Nexus lean: lite')
    expect(text).not.toContain('**What Changed**')
  })

  test('everything off adds no section', { options: { ...BASE, executiveSummary: false, leanTalk: 'off', leanCode: false } }, async ($, on) => {
    on('prompt.compose', () => ({ sections: [] }))
    const { sections } = await $.prompt.compose(FACTS as never)
    expect(sections.find(section => section.id === 'nexus:delivery')).toBeUndefined()
  })
})

describe('/lean-nexus', () => {
  test('a switch beats the settings until reset', { options: BASE }, async ($, on) => {
    mock.store(on)
    on('prompt.compose', () => ({ sections: [] }))
    const delivery = async () => (await $.prompt.compose(FACTS as never)).sections.find(section => section.id === 'nexus:delivery')?.text ?? ''
    const switched = await $.command.run({ command: 'lean-nexus', args: 'talk ultra' } as never)
    expect(switched.text).toContain('Talk: ultra · Minimal code: on')
    expect(switched.text).toContain('next turn')
    expect(await delivery()).toContain('Nexus lean: ultra')
    expect((await $.command.run({ command: 'lean-nexus', args: '' } as never)).text).toContain('(override)')
    await $.command.run({ command: 'lean-nexus', args: 'reset' } as never)
    expect(await delivery()).toContain('Nexus lean: lite')
    expect((await $.command.run({ command: 'lean-nexus', args: '' } as never)).text).not.toContain('(override)')
  })

  test('off and on switch both modes', { options: BASE }, async ($, on) => {
    mock.store(on)
    expect((await $.command.run({ command: 'lean-nexus', args: 'off' } as never)).text).toContain('Talk: off · Minimal code: off')
    expect((await $.command.run({ command: 'lean-nexus', args: 'on' } as never)).text).toContain('Talk: lite · Minimal code: on')
  })

  test('a typo changes nothing', { options: BASE }, async ($, on) => {
    mock.store(on)
    const answer = await $.command.run({ command: 'lean-nexus', args: 'talk mega' } as never)
    expect(answer.text).toContain('Not understood')
    expect((await $.command.run({ command: 'lean-nexus', args: '' } as never)).text).toContain('Talk: lite')
  })

  test('/nexus lists both modes', { options: BASE }, async ($, on) => {
    mock.store(on)
    await $.command.run({ command: 'lean-nexus', args: 'code off' } as never)
    const status = (await $.command.run({ command: 'nexus', args: '' } as never)).text ?? ''
    expect(status).toContain('Lean talk           lite (override)')
    expect(status).toContain('Minimal code        off (override)')
  })
})

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

describe('lean badge in the HUD', () => {
  test('the band shows what is on, spells it out in ascii, and hides when off', { options: BASE }, async ($, on) => {
    mock.store(on)
    const first = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await first.find({ type: 'Text', text: /✂ lite · min/ })).toBeDefined()
    await first.unmount()

    await $.command.run({ command: 'skin-nexus', args: 'ascii' } as never)
    await $.command.run({ command: 'lean-nexus', args: 'talk ultra' } as never)
    const ascii = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ascii.find({ type: 'Text', text: /\[lean\] ultra · min/ })).toBeDefined()
    await ascii.unmount()

    await $.command.run({ command: 'lean-nexus', args: 'off' } as never)
    const off = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await off.find({ type: 'Text', text: /\[lean\]/ })).toBeUndefined()
    await off.unmount()
  })
})

describe('output tokens in the footer', () => {
  test('the footer counts the output tokens when the turn reports them', () => {
    expect(footerText({ durationMs: 65_000, tools: 1, files: 0, contextPct: null, checks: null, outputTokens: 1234 })).toBe('⏱ 1m 5s · 1 tool · out 1.2k')
    expect(footerText({ durationMs: 65_000, tools: 1, files: 0, contextPct: null, checks: null })).toBe('⏱ 1m 5s · 1 tool')
  })

  test('a finished turn passes its usage to the footer', { options: { ...BASE, turnFooter: true } }, async ($, on) => {
    on('clock.now', () => ({ value: 1000 }))
    on('session.root', () => ({ value: 'C:/app' }))
    on('tool.call', { tool: 'Read' }, () => ({ result: {} as never }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    await $.tool.call({ tool: 'Read', file_path: 'C:/app/a.ts' } as never)
    const done = await $.turn.complete({
      answer: 'Done.',
      durationMs: 65_000,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
      usage: { input_tokens: 10, output_tokens: 1234, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    } as never)
    expect(done.text).toBe('⏱ 1m 5s · 1 tool · out 1.2k')
  })
})

describe('lean review prompt', () => {
  test('the prompt carries the ladder, the diff and the new files', () => {
    const text = reviewPrompt({ base: null, diff: '+const x = 1', stat: '', untracked: ['src/new.ts'] })
    expect(text).toContain('Already in the codebase? Reuse it.')
    expect(text).toContain('Do not edit any file')
    expect(text).toContain('+const x = 1')
    expect(text).toContain('- src/new.ts')
  })

  test('a large diff sends the file list only', () => {
    const text = reviewPrompt({ base: 'main', diff: '', stat: ' a.ts | 900 +++', untracked: [] })
    expect(text).toContain('against main')
    expect(text).toContain('too large')
    expect(text).toContain(' a.ts | 900 +++')
  })

  test('untracked files come from porcelain lines', () => {
    expect(untrackedFiles('?? src/new.ts\n M hooks/a.ts\n?? docs/x.md\n')).toEqual(['src/new.ts', 'docs/x.md'])
  })

  test('a base that looks like a git option is refused', () => {
    expect(isSafeBase('main')).toBe(true)
    expect(isSafeBase('origin/release-1.2')).toBe(true)
    expect(isSafeBase('--output=/tmp/x')).toBe(false)
    expect(isSafeBase('-p')).toBe(false)
  })
})

type Run = { exitCode?: number; stdout?: string; stderr?: string }

/** Answers each git call by its exact argv; anything else succeeds silently. */
function fakeGit(on: On, answers: Record<string, Run>): string[] {
  const seen: string[] = []
  on('process.run', (_, e) => {
    const key = e.argv.join(' ')
    seen.push(key)
    const hit = answers[key] ?? {}
    return { value: { exitCode: hit.exitCode ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' } } as never
  })
  return seen
}

function submissions(on: On): string[] {
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return sent
}

describe('/lean-review-nexus', () => {
  test('outside git nothing is sent', { options: BASE }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/app' }))
    fakeGit(on, { 'git rev-parse --is-inside-work-tree': { exitCode: 128, stderr: 'fatal: not a git repository' } })
    const sent = submissions(on)
    const answer = await $.command.run({ command: 'lean-review-nexus', args: '' } as never)
    expect(answer.text).toContain('Not a git repository')
    expect(sent).toEqual([])
  })

  test('a clean tree is not reviewed', { options: BASE }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/app' }))
    fakeGit(on, {})
    const sent = submissions(on)
    expect((await $.command.run({ command: 'lean-review-nexus', args: '' } as never)).text).toBe('No changes to review.')
    expect(sent).toEqual([])
  })

  test('new files alone are reviewed', { options: BASE }, async ($, on) => {
    const clock = mock.clock(on)
    on('session.root', () => ({ value: 'C:/app' }))
    fakeGit(on, { 'git status --porcelain -uall': { stdout: '?? src/new.ts\n' } })
    const sent = submissions(on)
    const answer = await $.command.run({ command: 'lean-review-nexus', args: '' } as never)
    await clock.advance(1)
    await clock.settle()
    expect(answer.text).toContain('sent to Claude')
    expect(sent[0]).toContain('- src/new.ts')
  })

  test('a repo with no commits yet reviews the staged changes', { options: BASE }, async ($, on) => {
    const clock = mock.clock(on)
    on('session.root', () => ({ value: 'C:/app' }))
    const seen = fakeGit(on, {
      'git rev-parse --verify -q HEAD': { exitCode: 1 },
      'git diff --cached': { stdout: '+first line' },
    })
    const sent = submissions(on)
    await $.command.run({ command: 'lean-review-nexus', args: '' } as never)
    await clock.advance(1)
    await clock.settle()
    expect(seen).toContain('git diff --cached')
    expect(sent[0]).toContain('+first line')
  })

  test('a large diff goes as the file list', { options: BASE }, async ($, on) => {
    const clock = mock.clock(on)
    on('session.root', () => ({ value: 'C:/app' }))
    fakeGit(on, {
      'git diff HEAD': { stdout: 'x'.repeat(50_000) },
      'git diff --stat HEAD': { stdout: ' big.ts | 2000 +++' },
    })
    const sent = submissions(on)
    const answer = await $.command.run({ command: 'lean-review-nexus', args: '' } as never)
    await clock.advance(1)
    await clock.settle()
    expect(answer.text).toContain('file list only')
    expect(sent[0]).toContain(' big.ts | 2000 +++')
    expect(sent[0]).not.toContain('x'.repeat(1000))
  })

  test('a base that looks like an option never reaches git diff', { options: BASE }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/app' }))
    const seen = fakeGit(on, {})
    const answer = await $.command.run({ command: 'lean-review-nexus', args: '--output=/tmp/x' } as never)
    expect(answer.text).toContain('branch, tag or commit')
    expect(seen.some(call => call.startsWith('git diff'))).toBe(false)
  })

  test('a wrong base shows what git said', { options: BASE }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/app' }))
    fakeGit(on, { 'git diff nope': { exitCode: 128, stderr: "fatal: bad revision 'nope'" } })
    const sent = submissions(on)
    expect((await $.command.run({ command: 'lean-review-nexus', args: 'nope' } as never)).text).toContain("fatal: bad revision 'nope'")
    expect(sent).toEqual([])
  })
})

const CLAUDE_MD = [
  '# Project rules',
  '',
  'Please always make sure that you run the tests with `npm test` before you say that the work is done, it is really important.',
  'The launcher lives in bin/claude-nexus.cmd and the docs are at https://example.com/docs for reference.',
  'We basically support up to 3 retries in total, so please keep that in mind at all times.',
  '',
  '```sh',
  'npm run build',
  '```',
].join('\n')

const SHORT_MD = [
  '# Project rules',
  '',
  'Run `npm test` before saying done.',
  'Launcher: bin/claude-nexus.cmd. Docs: https://example.com/docs',
  'Max 3 retries.',
  '',
  '```sh',
  'npm run build',
  '```',
].join('\n')

describe('compress check', () => {
  test('a faithful shorter version passes', () => {
    expect(checkCompressed(CLAUDE_MD, SHORT_MD)).toEqual({ ok: true })
  })

  test('CRLF original passes against an LF result', () => {
    expect(checkCompressed(CLAUDE_MD.replace(/\n/g, '\r\n'), SHORT_MD)).toEqual({ ok: true })
  })

  const refused = (result: string) => {
    const check = checkCompressed(CLAUDE_MD, result)
    return check.ok ? '' : check.reason
  }

  test('a changed code block is refused', () => {
    expect(refused(SHORT_MD.replace('npm run build', 'npm run b'))).toContain('code block')
  })

  test('a lost path, URL or number is refused and named', () => {
    expect(refused(SHORT_MD.replace('Launcher: bin/claude-nexus.cmd. ', ''))).toContain('bin/claude-nexus.cmd')
    expect(refused(SHORT_MD.replace(' Docs: https://example.com/docs', ''))).toContain('https://example.com/docs')
    expect(refused(SHORT_MD.replace('Max 3 retries.', 'Max 5 retries.'))).toContain('3')
  })

  test('a result that is not shorter, or kept too little, is refused', () => {
    expect(refused(`${CLAUDE_MD}\nMore.`)).toContain('not shorter')
    expect(refused('# Project rules')).toContain('kept only')
  })

  test('an outer fence around the reply is dropped', () => {
    expect(unwrapFence(`\`\`\`markdown\n${SHORT_MD}\n\`\`\``)).toBe(SHORT_MD)
    expect(unwrapFence(`\n${SHORT_MD}\n`)).toBe(SHORT_MD)
  })
})

describe('compress target and backup', () => {
  test('the target defaults to the project CLAUDE.md and expands ~', () => {
    expect(compressTarget('', 'C:/app', 'C:/Users/me')).toBe('C:/app/CLAUDE.md')
    expect(compressTarget('~/.claude/CLAUDE.md', 'C:/app', 'C:/Users/me')).toBe('C:/Users/me/.claude/CLAUDE.md')
    expect(compressTarget('docs\\RULES.md', 'C:/app', 'C:/Users/me')).toBe('C:/app/docs/RULES.md')
    expect(compressTarget('./CLAUDE.md', 'C:/app', 'C:/Users/me')).toBe('C:/app/CLAUDE.md')
    expect(compressTarget('D:\\work\\CLAUDE.md', 'C:/app', 'C:/Users/me')).toBe('D:/work/CLAUDE.md')
  })

  test('the backup name carries the UTC time', () => {
    expect(backupName('C:/app/CLAUDE.md', Date.UTC(2026, 9, 11, 8, 5, 9))).toBe('C:/app/CLAUDE.md.bak-20261011-080509')
  })
})

const NOW = Date.UTC(2026, 9, 11, 8, 5, 9)

/** A project whose CLAUDE.md reads `files[0]` first and `files[1]` on any later read. */
function compressWorld(on: On, opts: { reply?: unknown; answer?: string; files?: string[] } = {}) {
  const writes: { path: string; text: string }[] = []
  const asked: string[] = []
  let reads = 0
  on('session.root', () => ({ value: 'C:/app' }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.read', () => {
    const files = opts.files ?? [CLAUDE_MD]
    const text = files[Math.min(reads, files.length - 1)]
    reads += 1
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined } as never
  })
  on('model.complete', () => ({ value: opts.reply ?? { isAnswered: true, text: SHORT_MD, usage: {} } }) as never)
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: opts.answer ?? 'Write' } } }
  })
  return { writes, asked }
}

describe('/compress-nexus', () => {
  test('Write keeps a backup first, then writes the shorter file', { options: BASE }, async ($, on) => {
    const world = compressWorld(on)
    const answer = await $.command.run({ command: 'compress-nexus', args: '' } as never)
    expect(world.asked[0]).toContain('CLAUDE.md')
    expect(world.asked[0]).toContain('→')
    // the host hands fs.write hooks its own path spelling (backslashes on Windows)
    expect(world.writes.map(write => write.path.replace(/\\/g, '/'))).toEqual(['C:/app/CLAUDE.md.bak-20261011-080509', 'C:/app/CLAUDE.md'])
    expect(world.writes[0]?.text).toBe(CLAUDE_MD)
    expect(world.writes[1]?.text).toBe(`${SHORT_MD}\n`)
    expect(answer.text).toContain('CLAUDE.md.bak-20261011-080509')
  })

  test('Cancel writes nothing', { options: BASE }, async ($, on) => {
    const world = compressWorld(on, { answer: 'Cancel' })
    expect((await $.command.run({ command: 'compress-nexus', args: '' } as never)).text).toContain('untouched')
    expect(world.writes).toEqual([])
  })

  test('a helper failure writes nothing and asks nothing', { options: BASE }, async ($, on) => {
    const world = compressWorld(on, { reply: { isAnswered: false, reason: 'api-error', status: 500, error: 'boom', usage: {} } })
    expect((await $.command.run({ command: 'compress-nexus', args: '' } as never)).text).toContain('Compression failed (api-error)')
    expect(world.asked).toEqual([])
    expect(world.writes).toEqual([])
  })

  test('a result that loses a path is refused before asking', { options: BASE }, async ($, on) => {
    const lossy = SHORT_MD.replace('Launcher: bin/claude-nexus.cmd. ', '')
    const world = compressWorld(on, { reply: { isAnswered: true, text: lossy, usage: {} } })
    const answer = await $.command.run({ command: 'compress-nexus', args: '' } as never)
    expect(answer.text).toContain('Not written')
    expect(answer.text).toContain('bin/claude-nexus.cmd')
    expect(world.asked).toEqual([])
    expect(world.writes).toEqual([])
  })

  test('a file edited while deciding is left alone', { options: BASE }, async ($, on) => {
    const world = compressWorld(on, { files: [CLAUDE_MD, `${CLAUDE_MD}\nA new rule.`] })
    expect((await $.command.run({ command: 'compress-nexus', args: '' } as never)).text).toContain('changed while you were deciding')
    expect(world.writes).toEqual([])
  })

  test('a missing file is refused', { options: BASE }, async ($, on) => {
    const world = compressWorld(on, { files: [] })
    expect((await $.command.run({ command: 'compress-nexus', args: 'NOPE.md' } as never)).text).toContain('missing or empty')
    expect(world.writes).toEqual([])
  })
})
