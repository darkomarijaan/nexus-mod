import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { envFileCandidates, loadEnvFiles, mergeEnv, parseEnv } from './env-file.mjs'

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
  assert.deepEqual(envFileCandidates({ env: {}, cwd, home }), [join(cwd, '.env'), join(home, '.claude', 'nexus', '.env')])
  assert.deepEqual(envFileCandidates({ env: { NEXUS_ENV_FILE: 'secrets/jev.env' }, cwd, home })[0], resolve(cwd, 'secrets/jev.env'))
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
