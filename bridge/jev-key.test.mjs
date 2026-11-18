import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { cleanKey, dropEnvLine, runJevKey, setEnvLine } from './jev-key.mjs'

const sink = () => {
  const out = new PassThrough()
  let text = ''
  out.on('data', chunk => {
    text += chunk
  })

  return { stream: out, text: () => text }
}

const piped = line => {
  const input = new PassThrough()
  input.end(line)

  return input
}

const tmpFile = (content) => {
  const file = join(mkdtempSync(join(tmpdir(), 'jevkey-')), '.env')
  if (content !== undefined) writeFileSync(file, content)

  return file
}

test('setEnvLine adds, replaces and keeps the rest, in the file’s own line endings', () => {
  assert.equal(setEnvLine('', 'CMD_API_KEY', 'k1'), 'CMD_API_KEY=k1\n')
  assert.equal(setEnvLine('A=1\n# note\n', 'CMD_API_KEY', 'k1'), 'A=1\n# note\nCMD_API_KEY=k1\n')
  assert.equal(setEnvLine('A=1\r\nCMD_API_KEY=old\r\nB=2\r\n', 'CMD_API_KEY', 'new'), 'A=1\r\nCMD_API_KEY=new\r\nB=2\r\n')
  assert.equal(setEnvLine('export CMD_API_KEY=old\n', 'CMD_API_KEY', 'new'), 'CMD_API_KEY=new\n')
})

test('dropEnvLine removes only that name', () => {
  assert.equal(dropEnvLine('A=1\nCMD_API_KEY=k\nB=2\n', 'CMD_API_KEY'), 'A=1\nB=2\n')
  assert.equal(dropEnvLine('CMD_API_KEY=k\n', 'CMD_API_KEY'), '')
})

test('cleanKey takes one token and refuses anything else', () => {
  assert.deepEqual(cleanKey('  abc123  '), { key: 'abc123' })
  assert.match(cleanKey('').error, /nothing/)
  assert.match(cleanKey('a b').error, /no spaces/)
  assert.match(cleanKey('a"b').error, /no spaces/)
  assert.match(cleanKey('x'.repeat(600)).error, /too long/)
})

test('jev-key saves a piped key to the file and never prints it', async () => {
  const file = tmpFile('OTHER=1\n')
  const out = sink()
  const code = await runJevKey([], { file, input: piped('secret-key-123\n'), output: out.stream })
  assert.equal(code, 0)
  assert.equal(readFileSync(file, 'utf8'), 'OTHER=1\nCMD_API_KEY=secret-key-123\n')
  assert.ok(!out.text().includes('secret-key-123'))
  assert.match(out.text(), /saved/)
})

test('jev-key refuses a bad key and a name that cannot hold one, and writes nothing', async () => {
  const file = tmpFile()
  const out = sink()
  assert.equal(await runJevKey([], { file, input: piped('two words\n'), output: out.stream }), 1)
  assert.equal(await runJevKey(['PATH'], { file, input: piped('k\n'), output: out.stream }), 1)
  assert.throws(() => readFileSync(file, 'utf8'))
})

test('jev-key --remove forgets the key', async () => {
  const file = tmpFile('A=1\nCMD_API_KEY=k\n')
  assert.equal(await runJevKey(['--remove'], { file, output: sink().stream }), 0)
  assert.equal(readFileSync(file, 'utf8'), 'A=1\n')
})
