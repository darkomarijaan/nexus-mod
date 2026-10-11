/**
 * Themes (skins) for everything Nexus draws: the colors of each role, the
 * glyphs of the bars, the icons in the HUD and the border of the drawers.
 * Colors are terminal names, hex, or Claude Code's own theme keys (the
 * `claude` theme), so that one follows whatever `/theme` Claude Code is on.
 */

export type ThemeIcons = {
  branch: string
  model: string
  dot: string
  agent: string
  warn: string
  speed: string
  ok: string
  fail: string
  busy: string
  checkpoint: string
  lean: string
}

export type Theme = {
  name: string
  description: string
  /** Branch, task label: the HUD's headline color. */
  accent: string
  ok: string
  warn: string
  bad: string
  /** Idle sessions and quiet readings. */
  idle: string
  /** Running subagents. */
  agent: string
  /** Filled and empty cell of every bar. */
  bar: readonly [string, string]
  border: 'round' | 'single' | 'double' | 'bold' | 'classic'
  icons: ThemeIcons
  /**
   * The Claude Code theme the skin pairs with: `dark` or `ansi` in the
   * person's own variant (daltonized kept), or null to leave the person's own.
   */
  claudeTheme: 'dark' | 'ansi' | null
}

const UNICODE: ThemeIcons = {
  branch: '⎇',
  model: '◆',
  dot: '●',
  agent: '⚙',
  warn: '⚠',
  speed: '⚡',
  ok: '✓',
  fail: '✗',
  busy: '⟳',
  checkpoint: '⚑',
  lean: '✂',
}

const ASCII: ThemeIcons = {
  branch: 'git:',
  model: '>',
  dot: '*',
  agent: '+',
  warn: '!',
  speed: '~',
  ok: 'ok',
  fail: 'x',
  busy: '..',
  checkpoint: '#',
  lean: '[lean]',
}

export const THEMES: readonly Theme[] = [
  {
    name: 'default',
    description: 'The classic Nexus look: bright terminal colors',
    accent: 'cyan',
    ok: 'green',
    warn: 'yellow',
    bad: 'red',
    idle: 'gray',
    agent: 'magenta',
    bar: ['▰', '▱'],
    border: 'round',
    icons: UNICODE,
    claudeTheme: null,
  },
  {
    name: 'claude',
    description: "Follows Claude Code's own /theme (light, dark, daltonized)",
    accent: 'claude',
    ok: 'success',
    warn: 'warning',
    bad: 'error',
    idle: 'inactive',
    agent: 'permission',
    bar: ['█', '░'],
    border: 'round',
    icons: UNICODE,
    claudeTheme: null,
  },
  {
    name: 'dracula',
    description: 'Dracula: neon pastels on dark',
    accent: '#8be9fd',
    ok: '#50fa7b',
    warn: '#f1fa8c',
    bad: '#ff5555',
    idle: '#6272a4',
    agent: '#bd93f9',
    bar: ['▰', '▱'],
    border: 'round',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    name: 'nord',
    description: 'Nord: cool arctic blues, calm',
    accent: '#88c0d0',
    ok: '#a3be8c',
    warn: '#ebcb8b',
    bad: '#bf616a',
    idle: '#4c566a',
    agent: '#b48ead',
    bar: ['■', '□'],
    border: 'single',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    name: 'ocean',
    description: 'Deep sea: teal and aqua',
    accent: '#4fc3f7',
    ok: '#26c6da',
    warn: '#ffd54f',
    bad: '#ff7043',
    idle: '#607d8b',
    agent: '#9575cd',
    bar: ['▮', '▯'],
    border: 'round',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    name: 'sunset',
    description: 'Warm oranges and pinks',
    accent: '#ff8c61',
    ok: '#ffd166',
    warn: '#f78c6b',
    bad: '#ef476f',
    idle: '#8d7b8a',
    agent: '#c77dff',
    bar: ['━', '─'],
    border: 'bold',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    name: 'forest',
    description: 'Mossy greens and amber',
    accent: '#8fbc8f',
    ok: '#7cb342',
    warn: '#d4a017',
    bad: '#c0392b',
    idle: '#6b705c',
    agent: '#a3b18a',
    bar: ['●', '○'],
    border: 'round',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    name: 'mono',
    description: 'Monochrome: no color, only shades',
    accent: 'white',
    ok: 'white',
    warn: 'white',
    bad: 'white',
    idle: 'gray',
    agent: 'white',
    bar: ['█', '░'],
    border: 'single',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    name: 'ascii',
    description: 'Plain ASCII glyphs for fonts or terminals without Unicode',
    accent: 'cyan',
    ok: 'green',
    warn: 'yellow',
    bad: 'red',
    idle: 'gray',
    agent: 'magenta',
    bar: ['#', '-'],
    border: 'classic',
    icons: ASCII,
    claudeTheme: 'ansi',
  },
]

export const DEFAULT_THEME = 'default'

export const THEME_NAMES: readonly string[] = THEMES.map(theme => theme.name)

/** The theme by name, case-insensitive; the default for anything unknown. */
export function themeOf(name: string | null | undefined): Theme {
  const wanted = (name ?? '').trim().toLowerCase()

  return THEMES.find(theme => theme.name === wanted) ?? (THEMES[0] as Theme)
}

export function isTheme(name: string): boolean {
  return THEME_NAMES.includes(name.trim().toLowerCase())
}

/**
 * Maps the plain color names the readings carry (green good, yellow
 * warning, red bad, gray idle, cyan accent, magenta agents) to the theme's
 * roles; any other color passes through.
 */
export function paint(color: string, theme: Theme): string {
  switch (color) {
    case 'green':
      return theme.ok
    case 'yellow':
      return theme.warn
    case 'red':
      return theme.bad
    case 'gray':
      return theme.idle
    case 'cyan':
      return theme.accent
    case 'magenta':
      return theme.agent
    default:
      return color
  }
}

/** A bar of `cells` cells for `percent`, in the theme's glyphs. */
export function themedBar(percent: number, theme: Theme, cells = 10): string {
  const full = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))

  return theme.bar[0].repeat(full) + theme.bar[1].repeat(cells - full)
}

/**
 * The Claude Code theme value a skin asks for, given the person's own theme
 * (`dark`, `light-daltonized`, ...): a dark skin keeps the daltonized
 * variant, an ANSI one keeps light or dark; null leaves it as it is.
 */
export function claudeThemeFor(theme: Theme, own: string): string {
  const isLight = own.startsWith('light')
  const isDaltonized = own.includes('daltonized')
  switch (theme.claudeTheme) {
    case 'dark':
      return isDaltonized ? 'dark-daltonized' : 'dark'
    case 'ansi':
      return isLight ? 'light-ansi' : 'dark-ansi'
    default:
      return own
  }
}

/** Text for `/skin-nexus list`: every theme, the current one marked. */
export function themeListText(current: string): string {
  const now = themeOf(current).name

  return [
    'Nexus themes',
    ...THEMES.map(theme => `  ${theme.name === now ? '▸' : ' '} ${theme.name.padEnd(8)} ${themedBar(60, theme, 6)}  ${theme.description}`),
    '',
    '/skin-nexus opens the picker · /skin-nexus <name> switches · /skin-nexus reset goes back to the configured one',
  ].join('\n')
}
