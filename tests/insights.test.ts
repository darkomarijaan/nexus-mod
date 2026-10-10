import { describe, expect, test } from 'claude-code/testing'

import {
  addSample,
  cacheAge,
  commitSubject,
  compactInstructions,
  forecast,
  forecastText,
  handoffLine,
  handoffText,
  NO_LOOP,
  nextStepFrom,
  trackCall,
} from '../hooks/insights'

const MIN = 60_000

describe('limit forecast', () => {
  test('a steady climb runs out before the reset', () => {
    let list = addSample([], { at: 0, pct: 20 }, 30 * MIN)
    list = addSample(list, { at: 10 * MIN, pct: 30 }, 30 * MIN)
    // 1 point a minute from 30%: out in 70 minutes, the reset 3 hours away
    expect(forecast(list, 180 * MIN)).toEqual({ outInMs: 70 * MIN, isBeforeReset: true })
    expect(forecastText(list, 180 * MIN, 10 * MIN)).toBe('out ~1h 10m')
  })

  test('a slow climb that the reset outruns stays quiet', () => {
    const list = [
      { at: 0, pct: 20 },
      { at: 60 * MIN, pct: 22 },
    ]
    expect(forecast(list, 120 * MIN)?.isBeforeReset).toBe(false)
    expect(forecastText(list, 120 * MIN, 60 * MIN)).toBeUndefined()
  })

  test('too little history says nothing; a drop starts over', () => {
    expect(forecast([{ at: 0, pct: 10 }, { at: 2 * MIN, pct: 15 }], null)).toBeUndefined()
    const reset = addSample([{ at: 0, pct: 90 }], { at: MIN, pct: 2 }, 30 * MIN)
    expect(reset).toEqual([{ at: MIN, pct: 2 }])
    const old = addSample([{ at: 0, pct: 10 }], { at: 40 * MIN, pct: 20 }, 30 * MIN)
    expect(old).toEqual([{ at: 40 * MIN, pct: 20 }])
  })
})

describe('cache freshness', () => {
  test('ages the cache from the last request', () => {
    expect(cacheAge(0, 2 * MIN, false)).toEqual({ text: 'warm 2m', color: 'green' })
    expect(cacheAge(0, 12 * MIN, false)).toEqual({ text: 'idle 12m', color: 'yellow' })
    expect(cacheAge(0, 90 * MIN, false).text).toBe('cold')
    expect(cacheAge(0, 90 * MIN, true).text).toBe('live')
  })
})

describe('next-step suggestion', () => {
  test('takes the first item under the heading', () => {
    const answer = '**What Changed**\n- a.ts: x\n\n**Next Steps**\n- Run the app and check the login page\n- Deploy'
    expect(nextStepFrom(answer)).toBe('Run the app and check the login page')
    expect(nextStepFrom('## Next steps\n1. **Add** tests for `parse`')).toBe('Add tests for parse')
    expect(nextStepFrom('**Next Steps**: wire the button')).toBe('wire the button')
  })

  test('none when there is nothing to suggest', () => {
    expect(nextStepFrom('**Next Steps**\nNone.')).toBeUndefined()
    expect(nextStepFrom('All done, the tests pass.')).toBeUndefined()
  })
})

describe('loop detector', () => {
  test('the same call failing three times running is a loop', () => {
    let state = NO_LOOP
    const verdicts: string[] = []
    for (let i = 0; i < 3; i++) {
      const step = trackCall(state, 'Bash:npm test', true)
      state = step.state
      verdicts.push(step.verdict)
    }
    expect(verdicts).toEqual(['none', 'none', 'failing'])
  })

  test('a success or another call breaks the run', () => {
    let { state } = trackCall(NO_LOOP, 'Bash:npm test', true)
    state = trackCall(state, 'Bash:npm test', false).state
    expect(trackCall(state, 'Bash:npm test', true).verdict).toBe('none')
    expect(trackCall(state, 'Read:a.ts', true).state.fails).toBe(1)
  })

  test('the same call six times running is a loop even when it works', () => {
    let state = NO_LOOP
    let verdict = 'none'
    for (let i = 0; i < 6; i++) ({ state, verdict } = trackCall(state, 'Read:a.ts', false))
    expect(verdict).toBe('repeating')
  })
})

describe('compaction guard and handoff', () => {
  const work = {
    files: ['src/a.ts', 'src/b.ts'],
    tasks: [
      { label: 'Write parser', status: 'completed' },
      { label: 'Add tests', status: 'in_progress' },
    ],
    checks: '✗ npm test',
  }

  test('compaction keeps paths, open tasks and checks', () => {
    const text = compactInstructions(work)
    expect(text).toContain('src/a.ts, src/b.ts')
    expect(text).toContain('Add tests (in_progress)')
    expect(text).not.toContain('Write parser')
    expect(text).toContain('✗ npm test')
  })

  test('the handoff names what changed and what is left', () => {
    const record = { at: 0, ...work, lastPrompt: 'add a parser', turns: 4 }
    const text = handoffText(record, 3 * 60 * MIN)
    expect(text).toContain('3h ago (4 turns)')
    expect(text).toContain('Files changed (2): src/a.ts, src/b.ts')
    expect(text).toContain('Unfinished tasks: Add tests')
    expect(handoffLine(record, 30 * MIN)).toBe('Last session 30m ago: 2 files changed, 1 task unfinished. /handoff-nexus to see or resume it.')
  })
})

describe('commit helper', () => {
  test('one clean subject line', () => {
    expect(commitSubject('Commit message: "Add login form validation."\n\nmore')).toBe('Add login form validation')
    expect(commitSubject('   \n')).toBeUndefined()
    expect(commitSubject('x'.repeat(100))?.length).toBe(72)
  })
})
