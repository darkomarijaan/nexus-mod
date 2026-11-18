import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PROTECTED, envFileCandidates, loadEnvFiles, mergeEnv, parseEnv } from './env-file.mjs'

test('a .env file is read as plain KEY=value lines', () => {
  const text = [
    '﻿# a comment',
    '',
    'PLAIN=abc',
    'export EXPORTED=def',
    'SPACED = ghi ',
    'QUOTED="has # hash and spaces"',
    "SINGLE='single quoted'",
    'TRAILING=value # a trailing comment',
    'EMPTY=',
    'not a variable',
    '1BAD=nope',
    'URL=https://example.com/a?b=c#frag',
  ].join('\r\n')
  assert.deepEqual(parseEnv(text), {
    PLAIN: 'abc',
    EXPORTED: 'def',
    SPACED: 'ghi',
    QUOTED: 'has # hash and spaces',
    SINGLE: 'single quoted',
    TRAILING: 'value',
    EMPTY: '',
    URL: 'https://example.com/a?b=c#frag',
  })
})

test('nothing is expanded or executed', () => {
  assert.deepEqual(parseEnv('A=$HOME\nB=`whoami`\nC=$(id)'), { A: '$HOME', B: '`whoami`', C: '$(id)' })
})

test('the places looked in, highest priority first', () => {
  const cwd = resolve('/work/project')
  const home = resolve('/home/me')
  assert.deepEqual(envFileCandidates({ env: {}, cwd, home }), [{ path: join(home, '.claude', 'nexus', '.env'), trusted: true }, { path: join(cwd, '.env'), trusted: false }])
  assert.deepEqual(envFileCandidates({ env: { NEXUS_ENV_FILE: 'secrets/jev.env' }, cwd, home })[0], { path: resolve(cwd, 'secrets/jev.env'), trusted: true })
})

test('files are merged by priority, empty values and missing files are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-env-'))
  const high = join(dir, 'high.env')
  const low = join(dir, 'low.env')
  writeFileSync(high, 'CMD_API_KEY=\nONLY_HIGH=h\nSHARED=from-high\n')
  writeFileSync(low, 'CMD_API_KEY=from-low\nSHARED=from-low\nONLY_LOW=l\n')
  const { vars, files } = loadEnvFiles([high, join(dir, 'missing.env'), low])
  assert.deepEqual(vars, { CMD_API_KEY: 'from-low', ONLY_HIGH: 'h', SHARED: 'from-high', ONLY_LOW: 'l' })
  assert.deepEqual(files, [low, high])
})

test('no files at all is not an error', () => {
  assert.deepEqual(loadEnvFiles([join(tmpdir(), 'nexus-none-1.env'), join(tmpdir(), 'nexus-none-2.env')]), { vars: {}, files: [] })
  assert.deepEqual(loadEnvFiles([]), { vars: {}, files: [] })
})

test('a directory or an oversized file is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-env-'))
  mkdirSync(join(dir, 'a-dir.env'))
  const big = join(dir, 'big.env')
  writeFileSync(big, `A=1\n${'#'.repeat(70_000)}\n`)
  assert.deepEqual(loadEnvFiles([join(dir, 'a-dir.env'), big]), { vars: {}, files: [] })
})

test('the process environment wins over a file, unless its value is empty', () => {
  const merged = mergeEnv({ CMD_API_KEY: 'file', ONLY_FILE: 'f' }, { CMD_API_KEY: 'process', EMPTY: '', PATH: '/bin' })
  assert.equal(merged.CMD_API_KEY, 'process')
  assert.equal(merged.ONLY_FILE, 'f')
  assert.equal(merged.PATH, '/bin')
  assert.equal(mergeEnv({ CMD_API_KEY: 'file' }, { CMD_API_KEY: '' }).CMD_API_KEY, 'file')
})

test('a repo\'s .env cannot widen where the key goes or move the person\'s own file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-env-'))
  const repo = join(dir, 'repo.env')
  writeFileSync(repo, 'NEXUS_JEV_HOSTS=evil.example.com\nNEXUS_ENV_FILE=/tmp/evil.env\nCMD_API_KEY=repo-key\nOTHER=ok\n')
  const { vars } = loadEnvFiles([{ path: repo, trusted: false }])
  assert.equal(vars.NEXUS_JEV_HOSTS, undefined)
  assert.equal(vars.NEXUS_ENV_FILE, undefined)
  assert.equal(vars.CMD_API_KEY, 'repo-key')
  assert.equal(vars.OTHER, 'ok')
  assert.deepEqual(PROTECTED, ['NEXUS_JEV_HOSTS', 'NEXUS_ENV_FILE'])
  const own = join(dir, 'own.env')
  writeFileSync(own, 'NEXUS_JEV_HOSTS=my.example.com\n')
  assert.equal(loadEnvFiles([{ path: own, trusted: true }]).vars.NEXUS_JEV_HOSTS, 'my.example.com')
})

test('the person\'s own file beats a repo\'s .env, which only fills what is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-env-'))
  const own = join(dir, 'own.env')
  const repo = join(dir, 'repo.env')
  writeFileSync(own, 'CMD_API_KEY=mine\n')
  writeFileSync(repo, 'CMD_API_KEY=theirs\nTYPESAFE_API_KEY=theirs-too\n')
  const both = loadEnvFiles([{ path: own, trusted: true }, { path: repo, trusted: false }]).vars
  assert.equal(both.CMD_API_KEY, 'mine')
  assert.equal(both.TYPESAFE_API_KEY, 'theirs-too')
})
