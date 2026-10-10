import { describe, expect, mock, test } from 'claude-code/testing'

import { masksIn } from '../hooks/secrets'
import { branchMatches, isMutatingCommand, scanCommand } from '../hooks/shield'
import { callSignature } from '../hooks/util'

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

const scan = (command: string, branch: string | null = 'feature/x', protectedBranches = ['main', 'master']) =>
  scanCommand(command, { branch, protectedBranches }).map(hit => hit.id)

describe('shield sees through wrappers and global options', () => {
  test('git global options do not hide a push or a force', () => {
    expect(scan('git -C ../app push origin main')).toContain('protected-push')
    expect(scan('git -c core.x=1 --no-pager push --force origin dev')).toContain('git-force-push')
    expect(scan('/usr/bin/git reset --hard')).toContain('git-reset-hard')
  })

  test('rm behind a path, xargs, busybox, timeout or find -exec is still rm', () => {
    expect(scan('/bin/rm -rf build')).toContain('rm-recursive')
    expect(scan('find . -name "*.tmp" | xargs rm -rf')).toContain('rm-recursive')
    expect(scan('busybox rm -rf /data')).toContain('rm-recursive')
    expect(scan('timeout -s KILL 5 rm -rf /data')).toContain('rm-recursive')
    expect(scan('find . -type d -exec rm -rf {} +')).toContain('find-exec-rm')
  })

  test('protected branches take * patterns', () => {
    expect(scan('git push origin release/1.4', 'x', ['release/*'])).toContain('protected-push')
    expect(scan('git push origin feature/release', 'x', ['release/*'])).toEqual([])
    expect(branchMatches('main', 'main')).toBe(true)
    expect(branchMatches('mainline', 'main')).toBe(false)
  })

  test('text a command only prints or searches for is not an action', () => {
    expect(scan('git commit -m "drop table docs from the guide"')).toEqual([])
    expect(scan('grep -rn "DROP TABLE" migrations')).toEqual([])
    expect(scan('cat src/shutdown.ts')).toEqual([])
    expect(scan('npm run reboot-api')).toEqual([])
    expect(scan('git rm -r --cached dist')).toEqual([])
  })

  test('what it leaves out never hides what follows', () => {
    expect(scan('grep -rn "x" src | xargs rm -rf')).toContain('rm-recursive')
    expect(scan('git commit -m "wip"; git push --force origin dev')).toContain('git-force-push')
    expect(scan('psql -c "DROP TABLE users;"')).toContain('sql-drop')
    expect(scan('sudo shutdown -r now')).toContain('power')
    expect(scan('systemctl reboot')).toContain('power')
  })

  test('a DELETE whose WHERE is on the next line is not a delete-all', () => {
    expect(scan('psql <<EOF\nDELETE FROM orders\nWHERE id = 4;\nEOF')).toEqual([])
    expect(scan('psql -c "DELETE FROM orders"')).toContain('sql-delete-all')
  })
})

describe('commands that change files', () => {
  test('read-only commands are not changes', () => {
    for (const command of [
      'yarn test',
      'npm test',
      'pnpm lint',
      'git log --oneline',
      'git status && git diff',
      'ls 2>&1',
      'cat x > /dev/null',
      'Get-ChildItem 2>$null',
      'node -e "const f = a => a > 1"',
      'grep -rn move src',
      'sed -n 1,20p file.ts',
      'tar -tzf build.tgz',
      'black --check .',
    ]) {
      expect([command, isMutatingCommand(command)]).toEqual([command, false])
    }
  })

  test('writing commands are changes', () => {
    for (const command of [
      'yarn',
      'yarn add react',
      'npm install',
      'npm run format',
      'echo hi >> notes.txt',
      'Get-Content a.txt | Out-File b.txt',
      'copy a.txt b.txt',
      'npx prettier --write .',
      'python -m pip install requests',
      'tar -xzf build.tgz',
      'sed -i s/a/b/ file.ts',
      'git -C app checkout main',
      'ruff format .',
    ]) {
      expect([command, isMutatingCommand(command)]).toEqual([command, true])
    }
  })
})

describe('secret masks are never written back', () => {
  const MASKED = 'ANTHROPIC_API_KEY=sk-a…[REDACTED:anthropic-key]'

  test('masks are found by their shape', () => {
    expect(masksIn(`${MASKED}\nB=ghp_…[REDACTED:github-token]`)).toEqual(['…[REDACTED:anthropic-key]', '…[REDACTED:github-token]'])
    expect(masksIn("expect(text).toContain('[REDACTED:')")).toEqual([])
  })

  test('a write carrying a mask is asked about, and blocked on Block', { options: BASE }, async ($, on) => {
    let ran = false
    let asked = ''
    on('session.root', () => ({ value: 'C:/app' }))
    on('fs.read', () => ({ value: 'ANTHROPIC_API_KEY=the-real-value' }))
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      asked = e.questions[0]?.question ?? ''
      return { result: { questions: e.questions, answers: { [asked]: 'Block it' } } }
    })
    on('tool.call', { tool: 'Write' }, () => {
      ran = true
      return { result: {} as never }
    })
    const answer = await $.tool.call({ tool: 'Write', file_path: 'C:/app/.env', content: `${MASKED}\nDEBUG=1` } as never)
    expect(asked).toContain('SECRET MASK')
    expect(answer.deny).toContain('real secret')
    expect(ran).toBe(false)
  })

  test('an edit whose old_string holds a mask is told why it cannot match', { options: BASE }, async ($, on) => {
    let asked = false
    on('fs.read', () => ({ value: 'ANTHROPIC_API_KEY=the-real-value' }))
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      asked = true
      return { result: {} as never }
    })
    const answer = await $.tool.call({ tool: 'Edit', file_path: 'C:/app/.env', old_string: MASKED, new_string: 'X=1' } as never)
    expect(answer.deny).toContain('can never match')
    expect(asked).toBe(false)
  })

  test('a mask the file already holds on disk passes', { options: BASE }, async ($, on) => {
    let ran = false
    on('fs.read', () => ({ value: `const sample = '${MASKED}'` }))
    on('tool.call', { tool: 'Edit' }, () => {
      ran = true
      return { result: {} as never }
    })
    const answer = await $.tool.call({ tool: 'Edit', file_path: 'C:/app/sample.test.ts', old_string: `'${MASKED}'`, new_string: `'${MASKED}' // kept` } as never)
    expect(answer.deny).toBeUndefined()
    expect(ran).toBe(true)
  })

  test('off, the sanitizer stays out of writes', { options: { ...BASE, sanitizer: false } }, async ($, on) => {
    on('tool.call', { tool: 'Write' }, () => ({ result: {} as never }))
    const answer = await $.tool.call({ tool: 'Write', file_path: 'C:/app/.env', content: MASKED } as never)
    expect(answer.deny).toBeUndefined()
  })
})

describe('rollback', () => {
  test('a typo is refused, never a rollback', { options: BASE }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/app' }))
    mock.store(on)
    const answer = await $.command.run({ command: 'rollback-nexus', args: 'lsit' } as never)
    expect(answer.text).toContain('Nothing rolled back')
    expect(answer.text).toContain('/rollback-nexus list')
  })

  test('zero is not a checkpoint number', { options: BASE }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/app' }))
    mock.store(on)
    expect((await $.command.run({ command: 'rollback-nexus', args: '0' } as never)).text).toContain('Nothing rolled back')
  })
})

describe('loop detector', () => {
  test('different edits to one file are not a loop', { options: { ...BASE, loopGuard: true } }, async ($, on) => {
    on('tool.call', { tool: 'Edit' }, () => ({ result: {} as never }))
    let last
    for (let i = 0; i < 7; i++) {
      last = await $.tool.call({ tool: 'Edit', file_path: 'C:/app/a.ts', old_string: `a${i}`, new_string: `b${i}` } as never)
    }
    expect(last?.context ?? []).toEqual([])
  })

  test('a call is the same call whatever its id', () => {
    expect(callSignature({ tool: 'Bash', command: 'ls', tool_use_id: 'a' })).toBe(callSignature({ tool: 'Bash', command: 'ls', tool_use_id: 'b' }))
    expect(callSignature({ tool: 'Edit', old_string: 'a' })).not.toBe(callSignature({ tool: 'Edit', old_string: 'b' }))
  })
})
