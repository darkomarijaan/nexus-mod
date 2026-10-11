import type { PluginOptions } from 'claude-code'

import { isLeanTalk, type LeanTalk } from './leanmode'
import { DEFAULT_THEME, isTheme } from './theme'

export type AuditMode = 'plan' | 'first-edit' | 'off'

export type NexusConfig = {
  shield: boolean
  protectedBranches: string[]
  sanitizer: boolean
  checkpoints: boolean
  assumptionAudit: AuditMode
  autoVerify: boolean
  maxHealAttempts: number
  verifyTimeoutMs: number
  quietTranscript: boolean
  executiveSummary: boolean
  leanTalk: LeanTalk
  leanCode: boolean
  designLens: boolean
  devServerUrl: string
  helperModel: string
  notify: boolean
  notifyAfterMs: number
  compactGuard: boolean
  handoff: boolean
  loopGuard: boolean
  maxAgents: number
  suggestNext: boolean
  commitHelper: boolean
  theme: string
  syncClaudeTheme: boolean
  trimOutput: boolean
  quotaGuard: number
  turnFooter: boolean
  fallbackMode: 'ask' | 'auto' | 'off'
}

const flag = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback

const count = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

const text = (value: unknown, fallback: string) =>
  typeof value === 'string' ? value : fallback

export function readConfig(options: PluginOptions): NexusConfig {
  const audit = text(options.assumptionAudit, 'plan')
  const theme = text(options.theme, DEFAULT_THEME).trim().toLowerCase()
  const fallback = text(options.fallbackMode, 'ask')
  const talk = text(options.leanTalk, 'lite').trim().toLowerCase()

  return {
    shield: flag(options.shield, true),
    protectedBranches: text(options.protectedBranches, 'main,master,production,release')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
    sanitizer: flag(options.sanitizer, true),
    checkpoints: flag(options.checkpoints, true),
    assumptionAudit: audit === 'first-edit' || audit === 'off' ? audit : 'plan',
    autoVerify: flag(options.autoVerify, true),
    maxHealAttempts: Math.floor(count(options.maxHealAttempts, 2)),
    verifyTimeoutMs: Math.min(600, Math.max(10, count(options.verifyTimeoutSec, 180))) * 1000,
    quietTranscript: flag(options.quietTranscript, true),
    executiveSummary: flag(options.executiveSummary, true),
    leanTalk: isLeanTalk(talk) ? talk : 'lite',
    leanCode: flag(options.leanCode, true),
    designLens: flag(options.designLens, true),
    devServerUrl: text(options.devServerUrl, '').trim(),
    helperModel: text(options.helperModel, 'haiku').trim() || 'haiku',
    notify: flag(options.notify, true),
    notifyAfterMs: Math.min(3600, count(options.notifyAfterSec, 30)) * 1000,
    compactGuard: flag(options.compactGuard, true),
    handoff: flag(options.handoff, true),
    loopGuard: flag(options.loopGuard, true),
    maxAgents: Math.floor(count(options.maxAgents, 0)),
    suggestNext: flag(options.suggestNext, true),
    commitHelper: flag(options.commitHelper, true),
    theme: isTheme(theme) ? theme : DEFAULT_THEME,
    syncClaudeTheme: flag(options.syncClaudeTheme, true),
    trimOutput: flag(options.trimOutput, true),
    quotaGuard: Math.min(100, Math.floor(count(options.quotaGuard, 90))),
    turnFooter: flag(options.turnFooter, true),
    fallbackMode: fallback === 'auto' || fallback === 'off' ? fallback : 'ask',
  }
}
