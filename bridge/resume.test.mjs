import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { latestSession, projectSlug, resumeHint } from './resume.mjs'

const transcript = (dir, name, seconds) => {
  const file = join(dir, name)
  writeFileSync(file, '{}\n')
  utimesSync(file, seconds, seconds)
}

test('a project folder is named after the path with every other character turned into a dash', () => {
  assert.equal(projectSlug('C:\\Users\\encry\\Projects\\nexus-mod'), 'C--Users-encry-Projects-nexus-mod')
  assert.equal(projectSlug('/home/eko/my.app'), '-home-eko-my-app')
})

test('the newest transcript written since the start is the session to resume', () => {
  const config = mkdtempSync(join(tmpdir(), 'nexus-resume-'))
  const cwd = join(config, 'work', 'shop')
  const dir = join(config, 'projects', projectSlug(cwd))
  mkdirSync(dir, { recursive: true })
  transcript(dir, 'old-before-start.jsonl', 1000)
  transcript(dir, 'first.jsonl', 2000)
  transcript(dir, 'latest.jsonl', 3000)
  transcript(dir, 'notes.txt', 4000)
  assert.equal(latestSession(config, cwd, 1500 * 1000), 'latest')
})

test('no transcript since the start, or no project folder, gives nothing', () => {
  const config = mkdtempSync(join(tmpdir(), 'nexus-resume-'))
  const cwd = join(config, 'shop')
  assert.equal(latestSession(config, cwd, 0), undefined)
  const dir = join(config, 'projects', projectSlug(cwd))
  mkdirSync(dir, { recursive: true })
  transcript(dir, 'stale.jsonl', 1000)
  assert.equal(latestSession(config, cwd, 2000 * 1000), undefined)
})

test('the hint names the launcher, not claude', () => {
  assert.equal(resumeHint('claude-nexus', 'abc-123'), 'Behind the router, resume with:\nclaude-nexus --resume abc-123')
})
