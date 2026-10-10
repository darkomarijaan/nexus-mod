import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const launcher = fileURLToPath(new URL('./claude-nexus.mjs', import.meta.url))

test('claude runs behind the router with both tokens, and its exit code comes back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-launch-'))
  const fake = join(dir, 'fake-claude.mjs')
  writeFileSync(
    fake,
    `const base = process.env.ANTHROPIC_BASE_URL
const control = process.env.NEXUS_ROUTER_TOKEN
const header = process.env.ANTHROPIC_CUSTOM_HEADERS.split('\\n').find(line => line.startsWith('x-nexus-router: '))
const status = await fetch(base + '/__nexus/status', { headers: { 'x-nexus-control': control } })
const body = await status.json()
console.log(JSON.stringify({ base, route: body.route, hasRouterHeader: header !== undefined, args: process.argv.slice(2), kept: process.env.ANTHROPIC_CUSTOM_HEADERS.startsWith('X-Team: a') }))
process.exit(7)
`,
  )
  const run = spawnSync(process.execPath, [launcher, fake, '--resume', 'abc'], {
    env: { ...process.env, CLAUDE_NEXUS_CLAUDE: process.execPath, ANTHROPIC_CUSTOM_HEADERS: 'X-Team: a' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(run.status, 7, run.stderr)
  const out = JSON.parse(run.stdout.trim().split('\n').at(-1))
  assert.match(out.base, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(out.route, 'claude')
  assert.equal(out.hasRouterHeader, true)
  assert.equal(out.kept, true)
  assert.deepEqual(out.args, ['--resume', 'abc'])
})

test('a claude that cannot start is reported and fails', () => {
  const run = spawnSync(process.execPath, [launcher], {
    env: { ...process.env, CLAUDE_NEXUS_CLAUDE: 'definitely-not-a-command-nexus' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /could not start definitely-not-a-command-nexus/)
})

test('on Windows, a claude.cmd shim starts through a shell with its arguments intact', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-launch-'))
  const fake = join(dir, 'fake-claude.mjs')
  writeFileSync(fake, `console.log(JSON.stringify({ base: process.env.ANTHROPIC_BASE_URL, args: process.argv.slice(2) }))\nprocess.exit(7)\n`)
  const shim = join(dir, 'claude.cmd')
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`)
  const run = spawnSync(process.execPath, [launcher, '--resume', 'abc def'], {
    env: { ...process.env, CLAUDE_NEXUS_CLAUDE: shim },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(run.status, 7, run.stderr)
  const out = JSON.parse(run.stdout.trim().split('\n').at(-1))
  assert.match(out.base, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.deepEqual(out.args, ['--resume', 'abc def'])
})

test('on Windows, a claude.cmd found on PATH is started through a shell too', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-launch-'))
  const fake = join(dir, 'fake-claude.mjs')
  writeFileSync(fake, `console.log(JSON.stringify({ args: process.argv.slice(2) }))\nprocess.exit(7)\n`)
  writeFileSync(join(dir, 'nexus-shim-claude.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`)
  const run = spawnSync(process.execPath, [launcher, 'x y'], {
    env: { ...process.env, CLAUDE_NEXUS_CLAUDE: 'nexus-shim-claude', PATH: `${dir};${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(run.status, 7, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1)).args, ['x y'])
})

test('settings env that sets the base URL, headers or auth token is warned about by file and name, never by value', () => {
  const home = mkdtempSync(join(tmpdir(), 'nexus-home-'))
  const project = mkdtempSync(join(tmpdir(), 'nexus-proj-'))
  mkdirSync(join(home, '.claude'))
  mkdirSync(join(project, '.claude'))
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://secret-hub.example/v1', OTHER: 'x' } }))
  writeFileSync(join(project, '.claude', 'settings.json'), '{ not json')
  writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-super-secret', ANTHROPIC_CUSTOM_HEADERS: 'X-K: hush' } }))
  const fake = join(project, 'fake.mjs')
  writeFileSync(fake, 'process.exit(0)\n')
  const run = spawnSync(process.execPath, [launcher, fake], {
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_NEXUS_CLAUDE: process.execPath },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stderr, /settings\.json sets ANTHROPIC_BASE_URL/)
  assert.match(run.stderr, /settings\.local\.json sets ANTHROPIC_AUTH_TOKEN/)
  assert.match(run.stderr, /settings\.local\.json sets ANTHROPIC_CUSTOM_HEADERS/)
  assert.equal(/OTHER/.test(run.stderr), false)
  for (const secret of ['secret-hub', 'sk-super-secret', 'hush']) assert.equal(run.stderr.includes(secret), false)
})

test('settings files that are missing or hold no env say nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'nexus-home-'))
  const project = mkdtempSync(join(tmpdir(), 'nexus-proj-'))
  mkdirSync(join(project, '.claude'))
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ env: null }))
  const fake = join(project, 'fake.mjs')
  writeFileSync(fake, 'process.exit(0)\n')
  const run = spawnSync(process.execPath, [launcher, fake], {
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_NEXUS_CLAUDE: process.execPath },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(/overrides what claude-nexus sets/.test(run.stderr), false)
})

test('the sh launcher finds the bridge when started through a symlink', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-link-'))
  const fake = join(dir, 'fake.mjs')
  writeFileSync(fake, `console.log('base=' + process.env.ANTHROPIC_BASE_URL)\n`)
  const link = join(dir, 'claude-nexus')
  symlinkSync(fileURLToPath(new URL('../bin/claude-nexus', import.meta.url)), link)
  const run = spawnSync(link, [fake], { env: { ...process.env, CLAUDE_NEXUS_CLAUDE: process.execPath }, encoding: 'utf8', timeout: 20_000 })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /base=http:\/\/127\.0\.0\.1:\d+/)
})
