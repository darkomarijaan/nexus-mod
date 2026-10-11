import { describe, expect, test } from 'claude-code/testing'

import { readConfig } from '../hooks/config'
import { nextStepFrom } from '../hooks/insights'
import {
  isOverride,
  leanBadge,
  leanLabel,
  leanRules,
  leanSettings,
  parseLeanArgs,
  readLeanPick,
  summaryRules,
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
