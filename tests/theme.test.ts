import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { claudeThemeFor, paint, pickerKey, THEMES, themedBar, themeListText, themeOf } from '../hooks/theme'

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

const PICKER = { title: 'Skin', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

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

const NEW_SKINS = ['gruvbox', 'mocha', 'tokyo', 'rosepine', 'monokai', 'latte', 'contrast', 'phosphor']
const ICON_KEYS = ['branch', 'model', 'dot', 'agent', 'warn', 'speed', 'ok', 'fail', 'busy', 'checkpoint', 'lean']
const HEX = /^#[0-9a-f]{6}$/

describe('the eight added skins', () => {
  test('each comes after the first nine, so their 1-9 keys stay put', () => {
    expect(THEMES.slice(0, 9).map(theme => theme.name)).toEqual(['default', 'claude', 'dracula', 'nord', 'ocean', 'sunset', 'forest', 'mono', 'ascii'])
    expect(THEMES.slice(9).map(theme => theme.name)).toEqual(NEW_SKINS)
  })

  test('each has a hex color for every role, two bar glyphs, a full icon set and a name that fits the list', () => {
    for (const name of NEW_SKINS) {
      const theme = themeOf(name)
      expect(theme.name).toBe(name)
      expect(name.length).toBeLessThanOrEqual(8)
      expect(theme.description.length).toBeGreaterThan(0)
      for (const role of [theme.accent, theme.ok, theme.warn, theme.bad, theme.idle, theme.agent]) expect(role).toMatch(HEX)
      expect(theme.bar.every(glyph => [...glyph].length === 1)).toBe(true)
      expect(theme.bar[0]).not.toBe(theme.bar[1])
      expect(Object.keys(theme.icons).sort()).toEqual([...ICON_KEYS].sort())
      for (const icon of Object.values(theme.icons)) expect(icon.length).toBeGreaterThan(0)
    }
  })

  test('ok, warn and bad are three different colors in every added skin', () => {
    for (const name of NEW_SKINS) {
      const theme = themeOf(name)
      expect(new Set([theme.ok, theme.warn, theme.bad]).size).toBe(3)
    }
  })

  test('phosphor draws in plain ASCII glyphs; the rest in Unicode', () => {
    const phosphor = themeOf('phosphor')
    expect(phosphor.icons).toEqual(themeOf('ascii').icons)
    expect(/^[\x20-\x7e]+$/.test(phosphor.bar.join(''))).toBe(true)
    expect(phosphor.border).toBe('classic')
    for (const name of NEW_SKINS.filter(one => one !== 'phosphor')) expect(themeOf(name).icons).toEqual(themeOf('default').icons)
  })

  test('latte is a light skin: Claude Code goes light, daltonized kept', () => {
    const latte = themeOf('latte')
    expect(latte.claudeTheme).toBe('light')
    expect(claudeThemeFor(latte, 'dark')).toBe('light')
    expect(claudeThemeFor(latte, 'dark-daltonized')).toBe('light-daltonized')
    expect(claudeThemeFor(latte, 'light-ansi')).toBe('light')
  })

  test('picker keys run 1-9, then a-z, then none', () => {
    expect([0, 8, 9, 16, 34, 35].map(pickerKey)).toEqual(['1', '9', 'a', 'h', 'z', undefined])
  })

  test('the list shows every added skin', () => {
    const text = themeListText('tokyo')
    expect(text).toContain('▸ tokyo')
    for (const name of NEW_SKINS) expect(text).toContain(` ${name} `)
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

  test('an added skin switches by name and is remembered in the store', { options: QUIET }, async ($, on) => {
    const store = memoryStore(on)
    expect((await $.command.run({ command: 'skin-nexus', args: 'Gruvbox' } as never)).text).toBe('Skin: gruvbox')
    expect(store.theme).toBe('gruvbox')
    expect((await $.command.run({ command: 'nexus', args: '' } as never)).text).toContain('Skin                gruvbox')
  })

  test('an added skin can be the configured one', { options: { ...QUIET, theme: 'rosepine' } }, async ($, on) => {
    mock.store(on)
    expect((await $.command.run({ command: 'skin-nexus', args: 'reset' } as never)).text).toContain('rosepine')
  })

  test('the picker gives the added skins letter keys a-h and remembers a pick', { options: QUIET }, async ($, on) => {
    const store = memoryStore(on)
    on('ui.toast', () => ({ value: undefined }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.command.run({ command: 'skin-nexus', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', component: 'Pane', requestId: 'nexus-theme', props: PICKER })
    const keys = await Promise.all(
      THEMES.map(async theme => ((await ui.find({ key: `theme-${theme.name}` })) as { props?: { hotkey?: string } } | undefined)?.props?.hotkey),
    )
    expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    await ui.press({ key: 'theme-phosphor' })
    expect(store.theme).toBe('phosphor')
    await ui.unmount()
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

  test('latte moves a dark Claude Code to light, and default puts the person\'s own back', { options: QUIET }, async ($, on) => {
    const sets = follow(on, 'dark')
    await $.command.run({ command: 'skin-nexus', args: 'latte' } as never)
    await $.command.run({ command: 'skin-nexus', args: 'default' } as never)
    expect(sets).toEqual(['light', 'dark'])
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
