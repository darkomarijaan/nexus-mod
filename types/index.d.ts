export type NexusPeerStatus = 'working' | 'waiting' | 'done'

export type NexusPeer = {
  id: string
  pid: number
  name: string
  cwd: string
  status: NexusPeerStatus
  rawStatus: string
  updatedAt: number
  version: string
  isSelf: boolean
}

export type NexusAgent = { id: string; description: string; type: string; status: string }

export type NexusShieldAlert = { tool: string; command: string; reasons: string[] }

/** One account usage window: `five_hour`, `seven_day` or a gateway's `spend_limit`. */
export type NexusLimit = { kind: string; percentUsed: number; resetsAt: number | null }

/** One item of Claude's todo/task list, which drives the progress meter. */
export type NexusTask = { id: string; label: string; status: 'pending' | 'in_progress' | 'completed' }

/**
 * Readings of the latest main-thread model response: output speed, the share
 * of input the prompt cache served, and why a reply stopped short.
 */
export type NexusSpeed = { tps: number | null; cacheHit: number | null; cutoff: string | null; at: number }

/** What this session did, across turns: the handoff, compaction and commit read it. */
export type NexusWork = {
  files: string[]
  turns: number
  lastPrompt: string
  commitReady: boolean
  agentStarts: Record<string, number>
}

/** The work tree beside the branch: commits to push and pull, and files by state. */
export type NexusGit = {
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  changed: number
  untracked: number
  conflicts: number
}

export type NexusHud = {
  branch: string | null
  /** Null outside a git repository, or before the first read. */
  git: NexusGit | null
  model: string
  tokens: number | null
  window: number | null
  percent: number | null
  limits: NexusLimit[]
  peers: NexusPeer[]
  agents: NexusAgent[]
  at: number
}

export type NexusTurn = {
  id: string | null
  isWorking: boolean
  isWaiting: boolean
  tool: string | null
  detail: string | null
  tools: number
  changed: string[]
  hasMutated: boolean
}

export type NexusCheck = { name: string; isOk: boolean; ms: number; tail: string }

export type NexusVerify = {
  phase: 'idle' | 'running' | 'passed' | 'failed' | 'none'
  checks: NexusCheck[]
  at: number
}

export type NexusCheckpoint = {
  sha: string
  label: string
  at: number
  turnId: string | null
  kind: 'turn' | 'safety'
}

export type NexusDesignOption = {
  id: string
  name: string
  description?: string
  colors?: Record<string, string>
  fonts?: { heading?: string; body?: string; mono?: string }
  radius?: string
  spacing?: string
  html?: string
}

export type NexusDesign = {
  id: string
  title: string
  kind: string
  url: string
  options: NexusDesignOption[]
}

/** One provider profile as the pane shows it: the key masked, never whole. */
export type NexusProviderSummary = {
  name: string
  hubUrl: string
  key: string
  model: string
  contextWindow: number
  fallback: boolean
  isDefault: boolean
}
/** The profile being added or edited in the pane, one field at a time. */
export type NexusProviderDraft = {
  step: 'name' | 'hubUrl' | 'apiKey' | 'opus' | 'sonnet' | 'haiku' | 'contextWindow' | 'fallback'
  editing: string | null
  values: Record<string, string>
  models: string[]
  error: string | null
}
export type NexusProviderView = {
  linked: boolean
  route: string
  model: string | null
  /** The hub this person switched to last (kept across sessions); null: none yet. */
  lastHub: string | null
  profiles: NexusProviderSummary[]
  tests: Record<string, string>
  draft: NexusProviderDraft | null
}
/** The router this session runs behind (its control token), kept so a reload finds it. */
export type NexusRouterLink = { url: string; token: string }

/** The person's /lean-nexus pick over the settings; a missing field follows the settings. */
export type NexusLeanPick = { talk?: 'off' | 'lite' | 'ultra'; code?: boolean }

/** One MCP server as /mcp-nexus shows it in this project. */
export type NexusMcpRow = { name: string; tools: number; tokens: number; needsSignIn: boolean; isOff: boolean }

/** One subagent of this session as the Agents panel shows it. */
export type NexusAgentRun = {
  id: string
  type: string
  description: string
  model: string
  /** ended: gone from the engine's list without a turn.complete seen. */
  status: 'running' | 'done' | 'failed' | 'ended'
  startedAt: number
  endedAt: number | null
  tools: number
  lastTool: string | null
  lastDetail: string | null
  lastActivityAt: number
  /** The last request's input, cache reads and writes, and output. */
  contextTokens: number
  /** Every request's, summed. */
  tokens: number
  step: { done: number; total: number; note: string | null } | null
  /** Tool calls started and not yet answered. */
  inTool: number
}

declare module 'claude-code' {
  interface PluginState {
    'nexus': {
      hud: NexusHud
      turn: NexusTurn
      verify: NexusVerify
      checkpoints: NexusCheckpoint[]
      design: NexusDesign | null
      ideas: string[]
      busy: string | null
      selectedPeer: string | null
      healAttempts: number
      bridgePort: number | null
      shieldAlert: NexusShieldAlert | null
      tasks: NexusTask[]
      speed: NexusSpeed | null
      work: NexusWork
      /** The theme (skin) the HUD and drawers are drawn in. */
      theme: string
      /** The provider route, profiles (masked) and the pane's draft. */
      provider: NexusProviderView
      /** The router this claude-nexus session runs behind; null in a plain session. */
      routerLink: NexusRouterLink | null
      /** The generation of the loop that listens to the router; a loop ends once this is no longer its own (0: none yet). */
      routerWatcher: number
      /** When Claude's plan limit resets after a fallback (ms); null: nothing to offer. */
      claudeBackAt: number | null
      /** The /lean-nexus pick, remembered across sessions in $.store. */
      leanPick: NexusLeanPick
      /** The MCP servers the /mcp-nexus pane lists, read when it opens. */
      mcpRows: NexusMcpRow[]
      /** The subagents of this session for the Agents panel; never stored across sessions. */
      agentRuns: NexusAgentRun[]
      /** The agent picked in the Agents panel, for its message box. */
      selectedAgent: string | null
    }
  }
}
