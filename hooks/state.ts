import type {
  NexusHud,
  NexusProviderView,
  NexusTurn,
  NexusVerify,
  NexusWork,
} from '../types'

export const EMPTY_HUD: NexusHud = {
  branch: null,
  model: '',
  tokens: null,
  window: null,
  percent: null,
  limits: [],
  peers: [],
  agents: [],
  at: 0,
}

export const IDLE_TURN: NexusTurn = {
  id: null,
  isWorking: false,
  isWaiting: false,
  tool: null,
  detail: null,
  tools: 0,
  changed: [],
  hasMutated: false,
}

export const EMPTY_WORK: NexusWork = { files: [], turns: 0, lastPrompt: '', commitReady: false, agentStarts: {} }

export const IDLE_PROVIDER: NexusProviderView = { linked: false, route: 'claude', model: null, lastHub: null, profiles: [], tests: {}, draft: null }

export const IDLE_VERIFY: NexusVerify = { phase: 'idle', checks: [], at: 0 }

/** Pane ids: every drawer the layout coordinator owns. */
export const PANE = {
  sessions: 'nexus-sessions',
  idea: 'nexus-idea',
  design: 'nexus-design',
  shield: 'nexus-shield',
  theme: 'nexus-theme',
  provider: 'nexus-provider',
} as const

export const DESIGN_TOOL = 'mcp__nexus__design_options'
