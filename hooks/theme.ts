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
  /** Commits to push, and to pull, beside the branch. */
  ahead: string
  behind: string
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
   * The Claude Code theme the skin pairs with: `dark`, `light` or `ansi` in
   * the person's own variant (daltonized kept), or null to leave the person's own.
   */
  claudeTheme: 'dark' | 'light' | 'ansi' | null
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
  ahead: '↑',
  behind: '↓',
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
  ahead: '^',
  behind: 'v',
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
  // Added after the first nine so their 1-9 keys in the picker stay put.
  {
    // Gruvbox dark, bright accents (github.com/morhetz/gruvbox).
    name: 'gruvbox',
    description: 'Gruvbox: retro groove, warm and earthy',
    accent: '#fe8019',
    ok: '#b8bb26',
    warn: '#fabd2f',
    bad: '#fb4934',
    idle: '#928374',
    agent: '#d3869b',
    bar: ['▓', '░'],
    border: 'single',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    // Catppuccin Mocha (catppuccin.com/palette).
    name: 'mocha',
    description: 'Catppuccin Mocha: soothing pastels on dark',
    accent: '#89dceb',
    ok: '#a6e3a1',
    warn: '#f9e2af',
    bad: '#f38ba8',
    idle: '#6c7086',
    agent: '#cba6f7',
    bar: ['◆', '◇'],
    border: 'round',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    // Tokyo Night, night variant (github.com/folke/tokyonight.nvim).
    name: 'tokyo',
    description: 'Tokyo Night: neon city lights after dark',
    accent: '#7aa2f7',
    ok: '#9ece6a',
    warn: '#e0af68',
    bad: '#f7768e',
    idle: '#565f89',
    agent: '#bb9af7',
    bar: ['▬', '─'],
    border: 'round',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    // Rosé Pine, main variant (rosepinetheme.com/palette).
    name: 'rosepine',
    description: 'Rosé Pine: muted rose, gold and foam',
    accent: '#ebbcba',
    ok: '#9ccfd8',
    warn: '#f6c177',
    bad: '#eb6f92',
    idle: '#6e6a86',
    agent: '#c4a7e7',
    bar: ['▪', '▫'],
    border: 'round',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    // Monokai, the classic Sublime Text colors.
    name: 'monokai',
    description: 'Monokai: punchy pink, lime and cyan',
    accent: '#66d9ef',
    ok: '#a6e22e',
    warn: '#e6db74',
    bad: '#f92672',
    idle: '#75715e',
    agent: '#ae81ff',
    bar: ['■', '·'],
    border: 'bold',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    // Catppuccin Latte (catppuccin.com/palette): dark enough for a light background.
    name: 'latte',
    description: 'Catppuccin Latte: for light terminals',
    accent: '#1e66f5',
    ok: '#40a02b',
    warn: '#df8e1d',
    bad: '#d20f39',
    idle: '#8c8fa1',
    agent: '#8839ef',
    bar: ['●', '◦'],
    border: 'round',
    icons: UNICODE,
    claudeTheme: 'light',
  },
  {
    // Okabe & Ito's colorblind-safe hues (jfly.uni-koeln.de/color), with a bright idle gray.
    name: 'contrast',
    description: 'High contrast, colorblind-safe (Okabe-Ito hues)',
    accent: '#56b4e9',
    ok: '#009e73',
    warn: '#f0e442',
    bad: '#d55e00',
    idle: '#bdbdbd',
    agent: '#cc79a7',
    bar: ['█', '▒'],
    border: 'double',
    icons: UNICODE,
    claudeTheme: 'dark',
  },
  {
    // A green P1 phosphor CRT with amber alerts, drawn in plain ASCII.
    name: 'phosphor',
    description: 'Green phosphor CRT, plain ASCII glyphs',
    accent: '#33ff66',
    ok: '#7dff9a',
    warn: '#ffb000',
    bad: '#ff5555',
    idle: '#1f9e46',
    agent: '#b3ffc6',
    bar: ['=', '.'],
    border: 'classic',
    icons: ASCII,
    claudeTheme: 'dark',
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
    case 'light':
      return isDaltonized ? 'light-daltonized' : 'light'
    case 'ansi':
      return isLight ? 'light-ansi' : 'dark-ansi'
    default:
      return own
  }
}

/** The picker key of the theme at `index`: 1-9, then a-z; none past that. */
export function pickerKey(index: number): string | undefined {
  if (index < 9) return String(index + 1)

  return index < 35 ? String.fromCharCode(97 + index - 9) : undefined
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
