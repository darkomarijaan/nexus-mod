import { describe, expect, mock, test } from 'claude-code/testing'

import { gitMarks, parseGitStatus } from '../hooks/gitstat'
import { themeOf } from '../hooks/theme'

const QUIET = {
  checkpoints: false,
  autoVerify: false,
  designLens: false,
  assumptionAudit: 'off',
  handoff: false,
  notify: false,
  suggestNext: false,
} as const

const OID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/** `git status --porcelain=v2 --branch` output, one line per item. */
const status = (...lines: string[]) => `${lines.join('\n')}\n`

const CLEAN = { upstream: 'origin/main', ahead: 0, behind: 0, staged: 0, changed: 0, untracked: 0, conflicts: 0 }

describe('git status parser', () => {
  test('a clean branch in step with its upstream', () => {
    const parsed = parseGitStatus(status(`# branch.oid ${OID}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0'))
    expect(parsed).toEqual({ branch: 'main', git: CLEAN })
  })

  test('ahead and behind, staged, changed, untracked and conflicts', () => {
    const parsed = parseGitStatus(
      status(
        `# branch.oid ${OID}`,
        '# branch.head feat/coupons',
        '# branch.upstream origin/feat/coupons',
        '# branch.ab +2 -1',
        '1 M. N... 100644 100644 100644 aaa bbb src/checkout.ts',
        '1 .M N... 100644 100644 100644 aaa bbb src/coupons.ts',
        '1 MM N... 100644 100644 100644 aaa bbb src/cart total.ts',
        '1 A. N... 000000 100644 100644 000 bbb src/new.ts',
        '2 R. N... 100644 100644 100644 aaa bbb R100 src/renamed.ts\tsrc/old.ts',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/merge.ts',
        '? notes.md',
        '? scratch/todo.txt',
        '! dist/app.js',
      ),
    )
    expect(parsed).toEqual({
      branch: 'feat/coupons',
      git: { upstream: 'origin/feat/coupons', ahead: 2, behind: 1, staged: 4, changed: 2, untracked: 2, conflicts: 1 },
    })
  })

  test('no upstream: no ahead or behind', () => {
    const parsed = parseGitStatus(status(`# branch.oid ${OID}`, '# branch.head spike', '? a.txt'))
    expect(parsed.git).toEqual({ upstream: null, ahead: 0, behind: 0, staged: 0, changed: 0, untracked: 1, conflicts: 0 })
  })

  test('a detached HEAD shows its short commit', () => {
    expect(parseGitStatus(status(`# branch.oid ${OID}`, '# branch.head (detached)')).branch).toBe('(a1b2c3d)')
  })

  test('a repository with no commit yet keeps its branch name', () => {
    expect(parseGitStatus(status('# branch.oid (initial)', '# branch.head main', '? README.md')).branch).toBe('main')
  })

  test('Windows line endings and an empty output', () => {
    expect(parseGitStatus(`# branch.oid ${OID}\r\n# branch.head main\r\n`).branch).toBe('main')
    expect(parseGitStatus('')).toEqual({ branch: null, git: { ...CLEAN, upstream: null } })
  })
})

describe('header marks', () => {
  const icons = themeOf('default').icons

  test('only what is not zero, in order, each with its skin role', () => {
    const marks = gitMarks({ upstream: 'origin/main', ahead: 2, behind: 1, staged: 3, changed: 2, untracked: 1, conflicts: 1 }, icons)
    expect(marks).toEqual([
      { text: '↑2', role: 'accent' },
      { text: '↓1', role: 'warn' },
      { text: '+3', role: 'ok' },
      { text: '~2', role: 'warn' },
      { text: '?1', role: 'idle' },
      { text: '!1', role: 'bad' },
    ])
  })

  test('a clean branch in step has no marks; no git has none either', () => {
    expect(gitMarks(CLEAN, icons)).toEqual([])
    expect(gitMarks(null, icons)).toEqual([])
  })

  test('ASCII skins point with ^ and v', () => {
    const marks = gitMarks({ ...CLEAN, ahead: 1, behind: 4 }, themeOf('ascii').icons)
    expect(marks.map(mark => mark.text)).toEqual(['^1', 'v4'])
  })
})

/** Every Text that holds its own colored string, as the terminal would paint it. */
function colored(node: unknown): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = []
  const walk = (one: unknown) => {
    if (Array.isArray(one)) return one.forEach(walk)
    if (one === null || typeof one !== 'object') return
    const el = one as { type?: unknown; props?: { color?: unknown }; children?: unknown }
    const kids = Array.isArray(el.children) ? el.children : [el.children]
    if (el.type === 'Text' && typeof el.props?.color === 'string' && kids.every(kid => typeof kid === 'string')) {
      out.push({ text: kids.join(''), color: el.props.color })
    } else walk(el.children)
  }
  walk(node)

  return out
}

describe('HUD git marks', () => {
  const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

  test('the header shows the branch with its marks, read in one git status call', { options: QUIET }, async ($, on) => {
    const runs: string[] = []
    mock.store(on)
    const clock = mock.clock(on)
    on('session.root', () => ({ value: 'C:/app' }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('env.get', () => ({ value: undefined }))
    on('fs.exists', () => ({ value: false }))
    on('fs.list', () => ({ value: [] }) as never)
    on('session.id', () => ({ value: 'sess-1' }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: { context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: [] } }) as never)
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('process.run', (_, e) => {
      runs.push(e.argv.join(' '))
      const isStatus = e.argv.includes('status')
      const stdout = isStatus
        ? status(`# branch.oid ${OID}`, '# branch.head feat/coupons', '# branch.upstream origin/feat/coupons', '# branch.ab +2 -0', '1 .M N... 100644 100644 100644 aaa bbb src/a.ts', '? b.ts')
        : ''
      return { value: { exitCode: 0, stdout, stderr: '' } } as never
    })
    await $.session.start?.({ cwd: 'C:/app', surface: 'terminal', isInteractive: true } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    let branch
    for (let i = 0; i < 20 && branch === undefined; i++) {
      await clock.settle()
      branch = await ui.find({ type: 'Text', text: /feat\/coupons/ })
    }
    expect(branch).toBeDefined()
    const marks = colored(await ui.drawn())
    expect(marks).toContainEqual({ text: ' ↑2', color: themeOf('default').accent })
    expect(marks).toContainEqual({ text: ' ~1', color: themeOf('default').warn })
    expect(marks).toContainEqual({ text: ' ?1', color: themeOf('default').idle })
    expect(runs).toContain('git --no-optional-locks status --porcelain=v2 --branch')
    expect(runs.some(run => run.includes('rev-parse --abbrev-ref'))).toBe(false)
    await ui.unmount()
  })
})
