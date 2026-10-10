import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { paint, THEMES, themedBar, themeListText, themeOf } from '../hooks/theme'

const QUIET = {
  checkpoints: false,
  autoVerify: false,
  designLens: false,
  assumptionAudit: 'off',
  handoff: false,
  notify: false,
  suggestNext: false,
} as const

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

describe('themes', () => {
  test('an unknown name falls back to the default', () => {
    expect(themeOf('nope').name).toBe('default')
    expect(themeOf(' Dracula ').name).toBe('dracula')
  })

  test('bars draw in the theme glyphs', () => {
    expect(themedBar(68, themeOf('default'))).toBe('▰▰▰▰▰▰▰▱▱▱')
    expect(themedBar(50, themeOf('ascii'), 4)).toBe('##--')
  })

  test('plain colors map to the theme roles', () => {
    const nord = themeOf('nord')
    expect(paint('green', nord)).toBe(nord.ok)
    expect(paint('red', nord)).toBe(nord.bad)
    expect(paint('#123456', nord)).toBe('#123456')
  })

  test('every theme has a distinct name and both bar glyphs', () => {
    expect(new Set(THEMES.map(theme => theme.name)).size).toBe(THEMES.length)
    for (const theme of THEMES) expect(theme.bar.every(glyph => glyph.length > 0)).toBe(true)
    expect(themeListText('ocean')).toContain('▸ ocean')
  })
})

describe('/skin-nexus', () => {
  test('switching repaints the band and the status', { options: QUIET }, async ($, on) => {
    mock.store(on)
    const answer = await $.command.run({ command: 'skin-nexus', args: 'ascii' } as never)
    expect(answer.text).toBe('Skin: ascii')
    expect((await $.command.run({ command: 'nexus', args: '' } as never)).text).toContain('Skin                ascii')

    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /git:/ })).toBeDefined()
    await ui.unmount()
  })

  test('an unknown theme is refused with the list', { options: QUIET }, async $ => {
    const answer = await $.command.run({ command: 'skin-nexus', args: 'neon-pink' } as never)
    expect(answer.text).toContain('No skin named "neon-pink"')
    expect(answer.text).toContain('dracula')
  })

  test('reset goes back to the configured theme', { options: { ...QUIET, theme: 'nord' } }, async ($, on) => {
    mock.store(on)
    await $.command.run({ command: 'skin-nexus', args: 'sunset' } as never)
    const answer = await $.command.run({ command: 'skin-nexus', args: 'reset' } as never)
    expect(answer.text).toContain('nord')
  })
})

describe("Claude Code's theme follows the skin", () => {
  const follow = (on: On, start: string) => {
    let current = start
    const sets: string[] = []
    mock.store(on)
    on('config.list', () => ({
      value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: current, options: ['dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi'], provider: { plugin: 'engine', tier: 'core' }, isLocked: false }],
    }) as never)
    on('config.set', (_, e) => {
      current = String(e.value)
      sets.push(current)
      return { value: e.value }
    })
    return sets
  }

  test('a dark skin keeps daltonized, and default puts the person\'s own back', { options: QUIET }, async ($, on) => {
    const sets = follow(on, 'light-daltonized')
    await $.command.run({ command: 'skin-nexus', args: 'nord' } as never)
    await $.command.run({ command: 'skin-nexus', args: 'forest' } as never)
    await $.command.run({ command: 'skin-nexus', args: 'default' } as never)
    expect(sets).toEqual(['dark-daltonized', 'light-daltonized'])
  })

  test('ascii keeps light or dark in ANSI colors', { options: QUIET }, async ($, on) => {
    const sets = follow(on, 'light')
    await $.command.run({ command: 'skin-nexus', args: 'ascii' } as never)
    expect(sets).toEqual(['light-ansi'])
  })

  test('off, Claude Code\'s theme is left alone', { options: { ...QUIET, syncClaudeTheme: false } }, async ($, on) => {
    const sets = follow(on, 'light')
    await $.command.run({ command: 'skin-nexus', args: 'dracula' } as never)
    expect(sets).toEqual([])
  })
})
