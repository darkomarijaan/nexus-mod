# Nexus v0.5 Provider Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sesi Claude Code yang dijalankan lewat `claude-nexus` bisa berpindah antara langganan Claude dan profil hub (URL, API key, model) tanpa restart, dengan tawaran pindah otomatis saat kuota Claude habis.

**Architecture:** Launcher Node `claude-nexus` menyalakan router HTTP lokal di dalam prosesnya sendiri lalu menjalankan `claude` dengan `ANTHROPIC_BASE_URL` menunjuk router. Router meneruskan permintaan ke `api.anthropic.com` (login claude.ai) atau ke `<hub>/messages` (key hub, model dipetakan), dikendalikan Nexus lewat endpoint `/__nexus/*` bertoken. Nexus (hooks) menyimpan profil, menggambar pane dan HUD, dan menangani fallback saat router menahan 429 limit paket.

**Tech Stack:** Node ≥ 24 (`node:http`, `node:https`, `node:crypto`, `node:test`), Claude Code mod API 2.1.296 (`$.http.fetch`, `$.env`, `$.store`, `$.state`, `$.ui`, `$.session`), TypeScript (hooks), JSX dengan `h`.

**Spec:** `docs/superpowers/specs/2026-10-10-provider-router-design.md`

## Global Constraints

- Router hanya mendengarkan di `127.0.0.1`, port acak; `Host` selain `127.0.0.1:<port>`/`localhost:<port>` → 403.
- Permintaan model wajib header `x-nexus-router: <token inferensi>`; `/__nexus/*` wajib `x-nexus-control: <token kontrol>`; tanpa itu 401; kedua header tidak pernah diteruskan ke upstream.
- Rute `claude`: header dan body diteruskan byte demi byte (kecuali `host`, hop-by-hop, dan header token), respons dan SSE dialirkan tanpa buffer.
- Rute hub: header hanya `content-type`, `accept`, `anthropic-version`, `anthropic-beta` tanpa nilai `oauth-*`, ditambah `x-api-key` dan `authorization: Bearer <key hub>`.
- Key hub tidak pernah ditulis ke log, env, transkrip, atau `$.state`; hanya di `$.store` kunci `providers` dan di memori router.
- Profil: `name` cocok `^[a-z0-9-]{1,32}$` dan bukan `claude`; `hubUrl` `http(s)://…` tanpa `/` akhir; `apiKey` wajib; minimal satu dari `models.opus/sonnet/haiku`; `contextWindow` bilangan bulat ≥ 8000, default 200000.
- Tingkat model: `opus`/`haiku` dari nama model Claude, selain itu `sonnet`; tingkat kosong diisi model terisi pertama dengan urutan opus → sonnet → haiku.
- Fallback: permintaan ditahan paling lama 120 detik; `fallbackMode` `ask` (default) | `auto` | `off`.
- Compaction di rute hub pada 85% `contextWindow`; tawaran compaction sebelum pindah bila konteks > 80% `contextWindow` tujuan.
- `claude` biasa (tanpa launcher) tidak berubah perilakunya; `settings.json` tidak disentuh.
- Semua fungsi yang memanggil `$` tinggal di `hooks/register.tsx` (pola repo); logika murni di modul saudara.

## Review Focus

1. **Klien memutus koneksi di tengah streaming** (Esc saat Claude menjawab): router harus menghentikan permintaan upstream, tidak crash, tidak menulis ke respons yang sudah ditutup. Ditambahkan di Task 2 (tes "client abort").
2. **Hub mengembalikan error 4xx/5xx atau tidak bisa dihubungi**: Claude Code harus menerima error yang bisa dibaca (body hub apa adanya, atau 502 berformat error Anthropic), dan Nexus memberi toast. Ditambahkan di Task 2 (tes "hub down → 502 JSON") dan Task 7.
3. **Nexus di-reload saat rute hub sedang aktif**: HUD dan `/provider-nexus status` harus menampilkan rute router yang sebenarnya, bukan kembali ke `claude`. Ditangani `providerStatus` saat start dan di perintah status (Task 5); tes "the link survives a reload" memeriksa status tetap memakai token dari state.
4. **Dua keputusan untuk permintaan yang ditahan, atau keputusan setelah timeout**: keputusan kedua → 404, tidak ada respons ganda. Ditambahkan di Task 2.
5. **Nexus di-hot-reload saat sesi `claude-nexus` berjalan**: token kontrol sudah dihapus dari env, jadi link router harus dibaca dari `$.state`. Ditambahkan di Task 5 (tes "link survives reload").

---

## File Structure

| File | Tanggung jawab |
|---|---|
| `bridge/route-core.mjs` (baru) | Logika rute murni tanpa Node API: tingkat model, header hub/claude, transformasi body, klasifikasi 429, target URL |
| `bridge/route-core.test.mjs` (baru) | Tes unit `node --test` |
| `bridge/router.mjs` (baru) | Server HTTP: penerimaan, rute, streaming, penahanan 429, endpoint kontrol |
| `bridge/router.test.mjs` (baru) | Tes integrasi dengan Anthropic palsu dan hub palsu |
| `bridge/claude-nexus.mjs` (baru) | Launcher: token, router, menjalankan `claude` |
| `bridge/claude-nexus.test.mjs` (baru) | Tes launcher dengan `claude` palsu |
| `bin/claude-nexus.cmd`, `bin/claude-nexus` (baru) | Pembungkus untuk Windows dan sh |
| `hooks/provider.ts` (baru) | Logika murni Nexus: validasi profil, penyamaran key, argumen perintah, teks HUD, pilihan fallback |
| `tests/provider.test.ts` (baru) | Tes unit dan engine untuk provider |
| `hooks/register.tsx` | Link router, store profil, perintah, pane, HUD, loop kejadian, fallback, compaction |
| `hooks/state.ts` | `PANE.provider`, nilai awal state provider |
| `types/index.d.ts` | Tipe state `provider` dan `routerLink` |
| `hooks/config.ts`, `.claude-plugin/plugin.json` | Setting `fallbackMode`, versi 0.5.0 |
| `README.md` | Bagian Provider router, perintah, setting, Roadmap, versi |

Perintah tes yang dipakai:

- Router/launcher: `node --test bridge/`
- Hooks: `claude plugin test .`
- Type-check: `npx -y -p typescript@5.6.3 tsc -p <scratchpad>/tc/tsconfig.json` (tsconfig sementara yang meng-include `claude-code.d.ts` bawaan skill plugin-authoring, `hooks`, `types`, `tests`; lihat Task 5 Step 0)
- Validasi: `claude plugin validate .`

---

### Task 1: Logika rute murni (`bridge/route-core.mjs`)

**Files:**
- Create: `bridge/route-core.mjs`
- Test: `bridge/route-core.test.mjs`

**Interfaces:**
- Produces: `TIERS`, `tierOf(model: string): 'opus'|'sonnet'|'haiku'`, `hubModel(model: string, models: {opus?,sonnet?,haiku?}): string|undefined`, `hubHeaders(incoming: Record<string,string|string[]|undefined>, key: string): Record<string,string>`, `claudeHeaders(incoming): Record<string,string|string[]>`, `toHubBody(body: object, models): object`, `withSafeToolIds(body: object): object` (objek yang sama bila tidak ada perubahan), `planLimit(status: number, headers: Record<string,string|string[]|undefined>): {window: string|null, resetsAt: number|null} | null`, `hostAllowed(host: string|undefined, port: number): boolean`, `routeFor(method: string, path: string, route: string): 'control'|'claude'|'hub'`, `hubTarget(hubUrl: string, path: string): string`, `isInference(method: string, path: string): boolean`

- [ ] **Step 1: Tulis tes yang gagal**

`bridge/route-core.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  claudeHeaders,
  hostAllowed,
  hubHeaders,
  hubModel,
  hubTarget,
  isInference,
  planLimit,
  routeFor,
  tierOf,
  toHubBody,
  withSafeToolIds,
} from './route-core.mjs'

const MODELS = { opus: 'big', haiku: 'small' }

test('a Claude model id maps to its tier, unknown ids to sonnet', () => {
  assert.equal(tierOf('claude-opus-5-5'), 'opus')
  assert.equal(tierOf('claude-haiku-5-5'), 'haiku')
  assert.equal(tierOf('claude-sonnet-5-5'), 'sonnet')
  assert.equal(tierOf('claude-fable-5-1'), 'sonnet')
})

test('an empty tier takes the first filled model, opus then sonnet then haiku', () => {
  assert.equal(hubModel('claude-opus-5-5', MODELS), 'big')
  assert.equal(hubModel('claude-haiku-5-5', MODELS), 'small')
  assert.equal(hubModel('claude-sonnet-5-5', MODELS), 'big')
  assert.equal(hubModel('claude-sonnet-5-5', { haiku: 'only' }), 'only')
  assert.equal(hubModel('claude-sonnet-5-5', {}), undefined)
})

test('hub headers: allowlist only, OAuth beta and credentials never pass', () => {
  const out = hubHeaders(
    {
      authorization: 'Bearer sk-ant-oat01-secret',
      cookie: 'a=b',
      'x-nexus-router': 'tok',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20, interleaved-thinking-2025-05-14',
      'x-claude-code-session-id': 'abc',
    },
    'hub-key',
  )
  assert.deepEqual(out, {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'interleaved-thinking-2025-05-14',
    'x-api-key': 'hub-key',
    authorization: 'Bearer hub-key',
  })
})

test('claude headers keep everything but hop-by-hop and the router tokens', () => {
  const out = claudeHeaders({
    host: '127.0.0.1:5000',
    connection: 'keep-alive',
    'content-length': '10',
    'x-nexus-router': 'tok',
    'x-nexus-control': 'ctl',
    authorization: 'Bearer oauth',
    'anthropic-beta': 'oauth-2025-04-20',
  })
  assert.deepEqual(out, { authorization: 'Bearer oauth', 'anthropic-beta': 'oauth-2025-04-20' })
})

test('the hub body maps the model and drops earlier thinking blocks only', () => {
  const body = {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'z' }] },
    ],
  }
  const out = toHubBody(body, MODELS)
  assert.equal(out.model, 'big')
  assert.deepEqual(out.system, body.system)
  assert.deepEqual(out.messages[1].content, [{ type: 'text', text: 'ok' }])
  assert.deepEqual(out.messages[2].content, [{ type: 'text', text: '…' }])
  assert.equal(body.messages[1].content.length, 2, 'input is not mutated')
})

test('tool ids outside the Claude pattern are fixed the same way on both sides', () => {
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call:1/a', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call:1/a', content: 'ok' }] },
    ],
  }
  const out = withSafeToolIds(body)
  assert.equal(out.messages[0].content[0].id, 'call_1_a')
  assert.equal(out.messages[1].content[0].tool_use_id, 'call_1_a')
  const clean = { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} }] }] }
  assert.equal(withSafeToolIds(clean), clean, 'an already valid body is returned as is')
})

test('a 429 is a plan limit only when a unified status says rejected', () => {
  assert.deepEqual(
    planLimit(429, {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': '1790000000',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    }),
    { window: 'five_hour', resetsAt: 1790000000000 },
  )
  assert.deepEqual(planLimit(429, { 'anthropic-ratelimit-unified-7d-status': 'rejected' }), { window: null, resetsAt: null })
  assert.equal(planLimit(429, { 'retry-after': '3' }), null)
  assert.equal(planLimit(429, { 'anthropic-ratelimit-unified-status': 'allowed_warning' }), null)
  assert.equal(planLimit(200, { 'anthropic-ratelimit-unified-status': 'rejected' }), null)
})

test('only the router address is accepted as Host', () => {
  assert.equal(hostAllowed('127.0.0.1:5000', 5000), true)
  assert.equal(hostAllowed('localhost:5000', 5000), true)
  assert.equal(hostAllowed('evil.example:5000', 5000), false)
  assert.equal(hostAllowed(undefined, 5000), false)
})

test('routing: control paths, messages to the hub, everything else to Claude', () => {
  assert.equal(routeFor('GET', '/__nexus/status', 'myhub'), 'control')
  assert.equal(routeFor('POST', '/v1/messages?beta=true', 'myhub'), 'hub')
  assert.equal(routeFor('POST', '/v1/messages/count_tokens?beta=true', 'myhub'), 'hub')
  assert.equal(routeFor('HEAD', '/api/hello', 'myhub'), 'claude')
  assert.equal(routeFor('POST', '/v1/messages?beta=true', 'claude'), 'claude')
  assert.equal(isInference('POST', '/v1/messages?beta=true'), true)
  assert.equal(isInference('POST', '/v1/messages/count_tokens'), false)
})

test('the hub target drops the /v1 the hub URL already has', () => {
  assert.equal(hubTarget('https://hub.example/v1', '/v1/messages?beta=true'), 'https://hub.example/v1/messages?beta=true')
  assert.equal(hubTarget('https://hub.example/v1', '/v1/messages/count_tokens'), 'https://hub.example/v1/messages/count_tokens')
})
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test bridge/route-core.test.mjs`
Expected: FAIL, `Cannot find module '.../bridge/route-core.mjs'`

- [ ] **Step 3: Implementasi**

`bridge/route-core.mjs`:

```js
// Nexus provider router: the routing rules, pure. No Node APIs here, so the
// router and its tests share exactly this logic.

export const TIERS = ['opus', 'sonnet', 'haiku']

/** The tier a Claude model id belongs to; anything unrecognised counts as sonnet. */
export function tierOf(model) {
  const id = String(model ?? '').toLowerCase()
  if (id.includes('opus')) return 'opus'
  if (id.includes('haiku')) return 'haiku'

  return 'sonnet'
}

const filled = value => typeof value === 'string' && value.trim() !== ''

/** The hub model for a Claude model id: its tier's, else the first one the profile fills (opus, sonnet, haiku). */
export function hubModel(model, models) {
  const own = models?.[tierOf(model)]
  if (filled(own)) return own.trim()
  const first = TIERS.map(tier => models?.[tier]).find(filled)

  return first === undefined ? undefined : first.trim()
}

const TO_HUB = ['content-type', 'accept', 'anthropic-version']

/** Headers for a hub request: an allowlist, the OAuth beta dropped, the hub key added. Never the caller's credentials. */
export function hubHeaders(incoming, key) {
  const out = {}
  for (const name of TO_HUB) {
    const value = incoming[name]
    if (value !== undefined) out[name] = String(value)
  }
  const betas = String(incoming['anthropic-beta'] ?? '')
    .split(',')
    .map(one => one.trim())
    .filter(one => one !== '' && !one.startsWith('oauth-'))
  if (betas.length > 0) out['anthropic-beta'] = betas.join(',')
  out['x-api-key'] = key
  out.authorization = `Bearer ${key}`

  return out
}

const NOT_FORWARDED = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'x-nexus-router', 'x-nexus-control'])

/** Headers for api.anthropic.com: everything the client sent but hop-by-hop headers and the router's tokens. */
export function claudeHeaders(incoming) {
  const out = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (!NOT_FORWARDED.has(name) && value !== undefined) out[name] = value
  }

  return out
}

function withoutThinking(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message
  const content = message.content.filter(block => block?.type !== 'thinking' && block?.type !== 'redacted_thinking')

  return { ...message, content: content.length > 0 ? content : [{ type: 'text', text: '…' }] }
}

/** The request body for a hub: its model mapped, the thinking blocks of earlier assistant turns dropped, nothing else touched. */
export function toHubBody(body, models) {
  const messages = Array.isArray(body.messages) ? body.messages.map(withoutThinking) : body.messages

  return { ...body, model: hubModel(body.model, models) ?? body.model, messages }
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/
const safeId = id => (typeof id === 'string' && !SAFE_ID.test(id) ? id.replace(/[^a-zA-Z0-9_-]/g, '_') : id)

/** A body whose tool ids fit the Claude API's pattern; the very same object when they already do. */
export function withSafeToolIds(body) {
  if (!Array.isArray(body?.messages)) return body
  let changed = false
  const messages = body.messages.map(message => {
    if (!Array.isArray(message?.content)) return message

    return {
      ...message,
      content: message.content.map(block => {
        if (block?.type === 'tool_use' && safeId(block.id) !== block.id) {
          changed = true
          return { ...block, id: safeId(block.id) }
        }
        if (block?.type === 'tool_result' && safeId(block.tool_use_id) !== block.tool_use_id) {
          changed = true
          return { ...block, tool_use_id: safeId(block.tool_use_id) }
        }
        return block
      }),
    }
  })

  return changed ? { ...body, messages } : body
}

/** A plan-limit rejection (5-hour, weekly) told apart from a short throttle; null for anything else. */
export function planLimit(status, headers) {
  if (status !== 429) return null
  const unified = Object.entries(headers).filter(([name]) => name.toLowerCase().startsWith('anthropic-ratelimit-unified-'))
  const isRejected = unified.some(([name, value]) => /status$/i.test(name) && String(value).toLowerCase() === 'rejected')
  if (!isRejected) return null
  const reset = Number(headers['anthropic-ratelimit-unified-reset'])
  const claim = headers['anthropic-ratelimit-unified-representative-claim']

  return {
    window: typeof claim === 'string' && claim !== '' ? claim : null,
    resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
  }
}

/** Only the router's own address: any other Host is DNS rebinding. */
export function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

const bare = path => String(path).split('?')[0]

/** A model request worth holding when it hits a plan limit. */
export function isInference(method, path) {
  return method === 'POST' && bare(path) === '/v1/messages'
}

/** Which way a request goes: the router's control API, Claude, or the active hub. */
export function routeFor(method, path, route) {
  const one = bare(path)
  if (one.startsWith('/__nexus/')) return 'control'
  if (route === 'claude') return 'claude'
  if (method === 'POST' && (one === '/v1/messages' || one === '/v1/messages/count_tokens')) return 'hub'

  return 'claude'
}

/** `<hub>/messages…` for `/v1/messages…`: the hub URL already ends in /v1. */
export function hubTarget(hubUrl, path) {
  const [one, query] = String(path).split('?')

  return `${hubUrl}${one.replace(/^\/v1/, '')}${query === undefined ? '' : `?${query}`}`
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test bridge/route-core.test.mjs`
Expected: PASS, 10 tes

- [ ] **Step 5: Commit**

```bash
git add bridge/route-core.mjs bridge/route-core.test.mjs
git commit -m "Router core: tiers, header allowlist, hub body, plan-limit 429"
```

---

### Task 2: Router HTTP (`bridge/router.mjs`)

**Files:**
- Create: `bridge/router.mjs`
- Test: `bridge/router.test.mjs`

**Interfaces:**
- Consumes: semua fungsi Task 1.
- Produces: `startRouter({ token: string, controlToken: string, anthropic?: string, holdMs?: number, log?: (line: string) => void, debug?: boolean }): Promise<{ port: number, close(): Promise<void> }>`.
- Endpoint kontrol (JSON, header `x-nexus-control`):
  - `GET /__nexus/status` → `{ route: string, model: string|null, counts: {claude:number, hub:number}, held: string[] }`
  - `POST /__nexus/route` body `{ route: 'claude' }` atau `{ route: string, profile: { hubUrl, apiKey, models, contextWindow } }` → `{ ok: true, route }` atau 400 `{ error }`
  - `GET /__nexus/events?wait=<detik>` → `{ events: Array<{ type: 'limit', id, window, resetsAt } | { type: 'upstream-error', route, status }> }`
  - `POST /__nexus/decision` body `{ id, action: 'retry' | 'release' }` → `{ ok: true }` atau 404 `{ error: 'unknown id' }`

- [ ] **Step 1: Tulis tes integrasi yang gagal**

`bridge/router.test.mjs`:

```js
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'

import { startRouter } from './router.mjs'

const TOKEN = 't'.repeat(64)
const CONTROL = 'c'.repeat(64)
let anthropic, hub, router
const seen = { anthropic: [], hub: [] }
let anthropicMode = 'ok'

function fake(name, handler) {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        seen[name].push({ method: req.method, url: req.url, headers: req.headers, body })
        handler(req, res, body)
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function sse(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed' })
  res.write('event: message_start\ndata: {}\n\n')
  setTimeout(() => {
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ text })}\n\n`)
    res.end('event: message_stop\ndata: {}\n\n')
  }, 50)
}

function call({ method = 'POST', path = '/v1/messages?beta=true', headers = {}, body, host }) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: router.port, method, path, headers: { host: host ?? `127.0.0.1:${router.port}`, ...headers } },
      res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
      },
    )
    req.on('error', reject)
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}

const inference = (extra = {}) => ({
  headers: {
    'x-nexus-router': TOKEN,
    'content-type': 'application/json',
    authorization: 'Bearer oauth-secret',
    'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14',
    ...extra,
  },
  body: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
})
const control = (path, method = 'GET', body) => call({ method, path, headers: { 'x-nexus-control': CONTROL, 'content-type': 'application/json' }, body })
const PROFILE = { hubUrl: '', apiKey: 'hub-key', models: { opus: 'big' }, contextWindow: 128000 }

before(async () => {
  anthropic = await fake('anthropic', (req, res) => {
    if (anthropicMode === 'limit') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': '1790000000',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      })
      return res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}')
    }
    sse(res, 'from-claude')
  })
  hub = await fake('hub', (req, res) => sse(res, 'from-hub'))
  PROFILE.hubUrl = `http://127.0.0.1:${hub.address().port}/v1`
  router = await startRouter({ token: TOKEN, controlToken: CONTROL, anthropic: `http://127.0.0.1:${anthropic.address().port}`, holdMs: 400 })
})

after(async () => {
  await router.close()
  anthropic.close()
  hub.close()
})

test('the claude route passes OAuth and streams the answer through', async () => {
  anthropicMode = 'ok'
  const answer = await call(inference())
  assert.equal(answer.status, 200)
  assert.match(answer.text, /from-claude/)
  assert.match(answer.text, /message_stop/)
  const last = seen.anthropic.at(-1)
  assert.equal(last.headers.authorization, 'Bearer oauth-secret')
  assert.equal(last.headers['x-nexus-router'], undefined)
  assert.equal(answer.headers['anthropic-ratelimit-unified-status'], 'allowed')
})

test('requests without the token, with a foreign Host, or a wrong control token are refused', async () => {
  assert.equal((await call({ body: {} })).status, 401)
  assert.equal((await call({ ...inference(), host: 'evil.example' })).status, 403)
  assert.equal((await call({ method: 'GET', path: '/__nexus/status', headers: { 'x-nexus-control': 'wrong' } })).status, 401)
  assert.equal((await call({ method: 'GET', path: '/__nexus/status', headers: { 'x-nexus-router': TOKEN } })).status, 401)
})

test('the hub route swaps credentials and the model, and never leaks OAuth', async () => {
  assert.equal((await control('/__nexus/route', 'POST', { route: 'myhub', profile: PROFILE })).status, 200)
  const answer = await call(inference())
  assert.match(answer.text, /from-hub/)
  const last = seen.hub.at(-1)
  assert.equal(last.url, '/v1/messages?beta=true')
  assert.equal(last.headers.authorization, 'Bearer hub-key')
  assert.equal(last.headers['x-api-key'], 'hub-key')
  assert.equal(last.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14')
  assert.equal(JSON.stringify(last.headers).includes('oauth-secret'), false)
  assert.equal(JSON.parse(last.body).model, 'big')
  const status = JSON.parse((await control('/__nexus/status')).text)
  assert.equal(status.route, 'myhub')
  assert.equal(status.model, 'big')
  assert.equal(JSON.stringify(status).includes('hub-key'), false)
  await control('/__nexus/route', 'POST', { route: 'claude' })
})

test('a bad route request is refused', async () => {
  assert.equal((await control('/__nexus/route', 'POST', { route: 'x', profile: { hubUrl: 'ftp://x' } })).status, 400)
})

test('a plan-limit 429 is held, announced, and retried on the hub when asked', async () => {
  anthropicMode = 'limit'
  await control('/__nexus/route', 'POST', { route: 'claude' })
  const pending = call(inference())
  const events = JSON.parse((await control('/__nexus/events?wait=2')).text).events
  const limit = events.find(one => one.type === 'limit')
  assert.equal(limit.window, 'five_hour')
  assert.equal(limit.resetsAt, 1790000000000)
  await control('/__nexus/route', 'POST', { route: 'myhub', profile: PROFILE })
  assert.equal((await control('/__nexus/decision', 'POST', { id: limit.id, action: 'retry' })).status, 200)
  const answer = await pending
  assert.equal(answer.status, 200)
  assert.match(answer.text, /from-hub/)
  assert.equal((await control('/__nexus/decision', 'POST', { id: limit.id, action: 'retry' })).status, 404)
  await control('/__nexus/route', 'POST', { route: 'claude' })
})

test('a held 429 is released as it was, on refusal or after the hold time', async () => {
  anthropicMode = 'limit'
  const refused = call(inference())
  const limit = JSON.parse((await control('/__nexus/events?wait=2')).text).events.find(one => one.type === 'limit')
  await control('/__nexus/decision', 'POST', { id: limit.id, action: 'release' })
  const first = await refused
  assert.equal(first.status, 429)
  assert.match(first.text, /rate_limit_error/)
  const timedOut = await call(inference())
  assert.equal(timedOut.status, 429)
  await control('/__nexus/events?wait=0')
  anthropicMode = 'ok'
})

test('an unreachable hub answers 502 as an Anthropic error', async () => {
  const empty = await startRouter({ token: TOKEN, controlToken: CONTROL, anthropic: `http://127.0.0.1:${anthropic.address().port}` })
  const ask = (port, path, method, body, headers) =>
    new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      })
      req.end(JSON.stringify(body))
    })
  await ask(empty.port, '/__nexus/route', 'POST', { route: 'dead', profile: { ...PROFILE, hubUrl: 'http://127.0.0.1:9/v1' } }, { 'x-nexus-control': CONTROL })
  const down = await ask(empty.port, '/v1/messages', 'POST', { model: 'claude-opus-5-5', messages: [] }, { 'x-nexus-router': TOKEN })
  assert.equal(down.status, 502)
  assert.equal(JSON.parse(down.text).type, 'error')
  await empty.close()
})

test('a client that hangs up mid-stream leaves the router serving', async () => {
  anthropicMode = 'ok'
  await new Promise(resolve => {
    const req = request(
      { host: '127.0.0.1', port: router.port, method: 'POST', path: '/v1/messages', headers: { host: `127.0.0.1:${router.port}`, 'x-nexus-router': TOKEN } },
      res => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      },
    )
    req.end('{"model":"claude-opus-5-5","messages":[]}')
  })
  const next = await call(inference())
  assert.equal(next.status, 200)
})
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test bridge/router.test.mjs`
Expected: FAIL, `Cannot find module '.../bridge/router.mjs'`

- [ ] **Step 3: Implementasi**

`bridge/router.mjs`:

```js
// Nexus provider router: Claude Code talks to this local server, which sends
// each request on to api.anthropic.com (the claude.ai login) or to the active
// hub profile (its key, its models). Nexus steers it through /__nexus/*.
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomUUID, timingSafeEqual } from 'node:crypto'

import { claudeHeaders, hostAllowed, hubHeaders, hubModel, hubTarget, isInference, planLimit, routeFor, toHubBody, withSafeToolIds } from './route-core.mjs'

const same = (given, expected) => {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(expected)

  return a.length === b.length && timingSafeEqual(a, b)
}

const readAll = stream =>
  new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })

const json = (res, status, value) => {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
}

// An error Claude Code reads like the API's own.
const apiError = (res, status, message) => json(res, status, { type: 'error', error: { type: 'api_error', message: `Nexus router: ${message}` } })

function send(target, method, headers, body, signal) {
  const url = new URL(target)
  const open = url.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise((resolve, reject) => {
    const req = open(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : url.port,
        method,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host, ...(body.length > 0 ? { 'content-length': String(body.length) } : {}) },
        signal,
      },
      resolve,
    )
    req.on('error', reject)
    req.end(body.length > 0 ? body : undefined)
  })
}

function pipe(upstream, res, abort) {
  res.writeHead(upstream.statusCode ?? 502, upstream.headers)
  upstream.pipe(res)
  res.on('close', () => {
    if (!res.writableFinished) abort()
  })
}

const validProfile = profile =>
  profile !== null &&
  typeof profile === 'object' &&
  typeof profile.hubUrl === 'string' &&
  /^https?:\/\/[^\s/]+/.test(profile.hubUrl) &&
  typeof profile.apiKey === 'string' &&
  profile.apiKey !== '' &&
  hubModel('claude-sonnet', profile.models) !== undefined

export async function startRouter({ token, controlToken, anthropic = 'https://api.anthropic.com', holdMs = 120_000, log = () => {}, debug = false }) {
  const state = { route: 'claude', profile: null, usedHub: false, counts: { claude: 0, hub: 0 } }
  const held = new Map()
  const events = []
  const waiters = new Set()

  const emit = event => {
    events.push(event)
    for (const wake of waiters) wake()
  }

  async function toHub(req, res, body) {
    const profile = state.profile
    if (profile === null) return apiError(res, 503, 'no hub profile is active; switch with /provider-nexus')
    state.counts.hub += 1
    state.usedHub = true
    const parsed = body.length > 0 ? JSON.parse(body.toString('utf8')) : {}
    const out = Buffer.from(JSON.stringify(toHubBody(parsed, profile.models)))
    const abort = new AbortController()
    let upstream
    try {
      upstream = await send(hubTarget(profile.hubUrl, req.url), req.method, hubHeaders(req.headers, profile.apiKey), out, abort.signal)
    } catch (error) {
      emit({ type: 'upstream-error', route: state.route, status: 502 })
      return apiError(res, 502, `the hub "${state.route}" could not be reached (${error.code ?? error.message})`)
    }
    if ((upstream.statusCode ?? 502) >= 400) emit({ type: 'upstream-error', route: state.route, status: upstream.statusCode })
    log(`${req.method} ${req.url} -> hub:${state.route} ${upstream.statusCode}`)
    pipe(upstream, res, () => abort.abort())
  }

  async function toClaude(req, res, body) {
    state.counts.claude += 1
    let payload = body
    if (state.usedHub && body.length > 0 && String(req.headers['content-type'] ?? '').includes('json')) {
      const parsed = JSON.parse(body.toString('utf8'))
      const safe = withSafeToolIds(parsed)
      if (safe !== parsed) payload = Buffer.from(JSON.stringify(safe))
    }
    const abort = new AbortController()
    let upstream
    try {
      upstream = await send(`${anthropic}${req.url}`, req.method, claudeHeaders(req.headers), payload, abort.signal)
    } catch (error) {
      return apiError(res, 502, `api.anthropic.com could not be reached (${error.code ?? error.message})`)
    }
    if (debug) {
      const unified = Object.entries(upstream.headers).filter(([name]) => name.startsWith('anthropic-ratelimit-unified-'))
      if (unified.length > 0) log(`unified ${upstream.statusCode} ${unified.map(([name, value]) => `${name}=${value}`).join(' ')}`)
    }
    log(`${req.method} ${req.url} -> claude ${upstream.statusCode}`)
    const limit = isInference(req.method, req.url) ? planLimit(upstream.statusCode, upstream.headers) : null
    if (limit === null) return pipe(upstream, res, () => abort.abort())

    // A plan limit: hold the request while Nexus asks where it should go.
    const rejected = await readAll(upstream)
    const id = randomUUID()
    const decision = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ action: 'release' }), holdMs)
      held.set(id, one => {
        clearTimeout(timer)
        resolve(one)
      })
      emit({ type: 'limit', id, window: limit.window, resetsAt: limit.resetsAt })
    })
    held.delete(id)
    if (res.destroyed) return
    if (decision.action === 'retry' && state.profile !== null && state.route !== 'claude') return toHub(req, res, body)
    res.writeHead(upstream.statusCode ?? 429, upstream.headers).end(rejected)
  }

  async function control(req, res, path) {
    const body = req.method === 'POST' ? await readAll(req) : Buffer.alloc(0)
    const input = body.length > 0 ? JSON.parse(body.toString('utf8')) : {}
    const [bare, query = ''] = path.split('?')
    if (req.method === 'GET' && bare === '/__nexus/status') {
      const model = state.route === 'claude' || state.profile === null ? null : hubModel('claude-opus', state.profile.models) ?? null
      return json(res, 200, { route: state.route, model, counts: state.counts, held: [...held.keys()] })
    }
    if (req.method === 'POST' && bare === '/__nexus/route') {
      if (input.route === 'claude') {
        state.route = 'claude'
        return json(res, 200, { ok: true, route: 'claude' })
      }
      if (typeof input.route !== 'string' || input.route === '' || !validProfile(input.profile)) return json(res, 400, { error: 'route needs a name and a profile with hubUrl, apiKey and a model' })
      state.route = input.route
      state.profile = { hubUrl: input.profile.hubUrl, apiKey: input.profile.apiKey, models: input.profile.models }
      return json(res, 200, { ok: true, route: state.route })
    }
    if (req.method === 'GET' && bare === '/__nexus/events') {
      const wait = Math.min(30, Math.max(0, Number(new URLSearchParams(query).get('wait') ?? 0))) * 1000
      if (events.length === 0 && wait > 0) {
        await new Promise(resolve => {
          const wake = () => {
            waiters.delete(wake)
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(wake, wait)
          waiters.add(wake)
        })
      }
      return json(res, 200, { events: events.splice(0) })
    }
    if (req.method === 'POST' && bare === '/__nexus/decision') {
      const decide = held.get(input.id)
      if (decide === undefined) return json(res, 404, { error: 'unknown id' })
      decide({ action: input.action === 'retry' ? 'retry' : 'release' })
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'not found' })
  }

  const server = createServer(async (req, res) => {
    try {
      const port = server.address().port
      if (!hostAllowed(req.headers.host, port)) return json(res, 403, { error: 'forbidden' })
      const kind = routeFor(req.method, req.url, state.route)
      if (kind === 'control') {
        if (!same(req.headers['x-nexus-control'], controlToken)) return json(res, 401, { error: 'unauthorized' })
        return await control(req, res, req.url)
      }
      if (!same(req.headers['x-nexus-router'], token)) return json(res, 401, { error: 'unauthorized' })
      const body = await readAll(req)
      return kind === 'hub' ? await toHub(req, res, body) : await toClaude(req, res, body)
    } catch (error) {
      log(`error ${error.message}`)
      if (!res.headersSent) apiError(res, 502, error.message)
      else res.destroy()
    }
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    port: server.address().port,
    close: () =>
      new Promise(resolve => {
        for (const decide of held.values()) decide({ action: 'release' })
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test bridge/`
Expected: PASS, 10 tes Task 1 + 8 tes Task 2

- [ ] **Step 5: Commit**

```bash
git add bridge/router.mjs bridge/router.test.mjs
git commit -m "Router: claude and hub routes, held plan-limit 429, control API"
```

---

### Task 3: Launcher `claude-nexus`

**Files:**
- Create: `bridge/claude-nexus.mjs`, `bin/claude-nexus.cmd`, `bin/claude-nexus`
- Test: `bridge/claude-nexus.test.mjs`

**Interfaces:**
- Consumes: `startRouter` (Task 2).
- Produces: env pada child `claude`: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ANTHROPIC_CUSTOM_HEADERS` (nilai lama + `\n` + `x-nexus-router: <token>`), `NEXUS_ROUTER_TOKEN=<token kontrol>`; `CLAUDE_NEXUS_CLAUDE` (opsional) menimpa perintah `claude`; `NEXUS_ROUTER_DEBUG=1` menulis log ke `~/.claude/nexus/router-<pid>.log`.

- [ ] **Step 1: Tulis tes yang gagal**

`bridge/claude-nexus.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
const url = new URL(base)
const status = await fetch(base + '/__nexus/status', { headers: { 'x-nexus-control': control, host: url.host } })
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
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test bridge/claude-nexus.test.mjs`
Expected: FAIL (launcher tidak ada, `run.status` bukan 7)

- [ ] **Step 3: Implementasi**

`bridge/claude-nexus.mjs`:

```js
#!/usr/bin/env node
// claude-nexus: Claude Code with Nexus's provider router in front of it.
// Plain `claude` stays as it is (Remote Control works there; not here, since
// ANTHROPIC_BASE_URL points at this router).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { startRouter } from './router.mjs'

const token = randomBytes(32).toString('hex')
const controlToken = randomBytes(32).toString('hex')
const logFile = process.env.NEXUS_ROUTER_DEBUG === '1' ? join(homedir(), '.claude', 'nexus', `router-${process.pid}.log`) : null
if (logFile !== null) mkdirSync(join(homedir(), '.claude', 'nexus'), { recursive: true })
const log = line => {
  if (logFile !== null) appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
}

const router = await startRouter({ token, controlToken, log, debug: logFile !== null })

for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
  if (process.env[name]) console.error(`claude-nexus: ${name} is set, so it, not your claude.ai login, reaches Anthropic on the Claude route.`)
}

const own = process.env.ANTHROPIC_CUSTOM_HEADERS
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${router.port}`,
  ANTHROPIC_CUSTOM_HEADERS: own ? `${own}\nx-nexus-router: ${token}` : `x-nexus-router: ${token}`,
  NEXUS_ROUTER_TOKEN: controlToken,
}
const claude = process.env.CLAUDE_NEXUS_CLAUDE ?? 'claude'
const child = spawn(claude, process.argv.slice(2), { stdio: 'inherit', env })

// ctrl+c belongs to claude, which shares this console.
process.on('SIGINT', () => {})
child.on('error', async error => {
  console.error(`claude-nexus: could not start ${claude}: ${error.message}`)
  await router.close()
  process.exit(1)
})
child.on('exit', async (code, signal) => {
  await router.close()
  process.exit(code ?? (signal === null ? 0 : 1))
})
```

`bin/claude-nexus.cmd`:

```bat
@echo off
node "%~dp0..\bridge\claude-nexus.mjs" %*
```

`bin/claude-nexus`:

```sh
#!/bin/sh
exec node "$(dirname "$0")/../bridge/claude-nexus.mjs" "$@"
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test bridge/`
Expected: PASS, semua tes bridge (20)

- [ ] **Step 5: Commit**

```bash
git add bridge/claude-nexus.mjs bridge/claude-nexus.test.mjs bin/claude-nexus.cmd bin/claude-nexus
git update-index --chmod=+x bin/claude-nexus
git commit -m "Launcher: claude-nexus starts the router and claude behind it"
```

---

### Task 4: Logika provider murni (`hooks/provider.ts`)

**Files:**
- Create: `hooks/provider.ts`
- Test: `tests/provider.test.ts`

**Interfaces:**
- Produces:
  - `type ProviderModels = { opus?: string; sonnet?: string; haiku?: string }`
  - `type ProviderProfile = { name: string; hubUrl: string; apiKey: string; models: ProviderModels; contextWindow: number; fallback: boolean; isDefault: boolean }`
  - `type ProfileDraft = { name?: string; hubUrl?: string; apiKey?: string; models?: ProviderModels; contextWindow?: string | number; fallback?: boolean; isDefault?: boolean }`
  - `DEFAULT_WINDOW = 200_000`
  - `normalizeHubUrl(url: string): string`
  - `validateProfile(draft: ProfileDraft, others: readonly ProviderProfile[]): { profile: ProviderProfile; errors: null } | { profile: null; errors: Record<string, string> }`
  - `maskKey(key: string): string`
  - `primaryModel(models: ProviderModels): string | undefined`
  - `routerLinkFrom(baseUrl: string | undefined, controlToken: string | undefined): { url: string; token: string } | null`
  - `fallbackChoices(profiles: readonly ProviderProfile[]): ProviderProfile[]`
  - `needsCompaction(tokens: number | null, window: number, share: number): boolean`
  - `hubBadge(route: string, model: string | null): string`
  - `parseProviderArgs(args: string): { verb: 'pane' } | { verb: 'status' } | { verb: 'use'; name: string } | { verb: 'error'; message: string }`
  - `readProfiles(stored: unknown): ProviderProfile[]`

- [ ] **Step 1: Tulis tes yang gagal**

`tests/provider.test.ts`:

```ts
import { describe, expect, test } from 'claude-code/testing'

import {
  fallbackChoices,
  hubBadge,
  maskKey,
  needsCompaction,
  parseProviderArgs,
  primaryModel,
  readProfiles,
  routerLinkFrom,
  validateProfile,
  type ProviderProfile,
} from '../hooks/provider'

const MYHUB: ProviderProfile = {
  name: 'myhub',
  hubUrl: 'https://hub.example.com/v1',
  apiKey: 'sk-abcdefghijklmnop',
  models: { opus: 'antigravity/gemini-3.8-flash-tiered' },
  contextWindow: 1_000_000,
  fallback: true,
  isDefault: true,
}

describe('provider profiles', () => {
  test('a good draft becomes a profile with the URL tidied and the window defaulted', () => {
    const result = validateProfile({ name: 'omni', hubUrl: ' https://omni.example/v1/ ', apiKey: ' k-123456789 ', models: { haiku: 'deepseek' } }, [MYHUB])
    expect(result.errors).toBeNull()
    expect(result.profile).toEqual({
      name: 'omni',
      hubUrl: 'https://omni.example/v1',
      apiKey: 'k-123456789',
      models: { haiku: 'deepseek' },
      contextWindow: 200_000,
      fallback: false,
      isDefault: false,
    })
  })

  test('every broken field is named', () => {
    const result = validateProfile({ name: 'Claude', hubUrl: 'ftp://x', apiKey: '', models: {}, contextWindow: '100' }, [])
    expect(result.profile).toBeNull()
    expect(Object.keys(result.errors ?? {}).sort()).toEqual(['apiKey', 'contextWindow', 'hubUrl', 'models', 'name'])
    expect(validateProfile({ ...MYHUB, name: 'claude' }, []).errors?.name).toContain('claude')
    expect(validateProfile({ ...MYHUB }, [MYHUB]).errors?.name).toContain('already')
  })

  test('keys show only their ends', () => {
    expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-a…mnop')
    expect(maskKey('short')).toBe('••••')
  })

  test('the stored list keeps only valid profiles', () => {
    expect(readProfiles([MYHUB, { name: 'broken' }, 'x'])).toEqual([MYHUB])
    expect(readProfiles(null)).toEqual([])
  })

  test('the primary model is opus, then sonnet, then haiku', () => {
    expect(primaryModel({ haiku: 'h', sonnet: 's' })).toBe('s')
    expect(primaryModel({})).toBeUndefined()
  })
})

describe('router link and commands', () => {
  test('only a loopback base URL and a long token make a link', () => {
    const token = 'c'.repeat(64)
    expect(routerLinkFrom('http://127.0.0.1:51234', token)).toEqual({ url: 'http://127.0.0.1:51234', token })
    expect(routerLinkFrom('https://hub.example.com/v1', token)).toBeNull()
    expect(routerLinkFrom('http://127.0.0.1:51234', '')).toBeNull()
    expect(routerLinkFrom(undefined, token)).toBeNull()
  })

  test('arguments: nothing opens the pane, status, use with a name', () => {
    expect(parseProviderArgs('')).toEqual({ verb: 'pane' })
    expect(parseProviderArgs('status')).toEqual({ verb: 'status' })
    expect(parseProviderArgs('use Myhub')).toEqual({ verb: 'use', name: 'myhub' })
    expect(parseProviderArgs('use')).toEqual({ verb: 'error', message: 'Name a profile: /provider-nexus use <name> (or claude).' })
    expect(parseProviderArgs('nope').verb).toBe('error')
  })

  test('fallback choices put the default first', () => {
    const other = { ...MYHUB, name: 'omni', isDefault: false }
    const off = { ...MYHUB, name: 'off', fallback: false, isDefault: false }
    expect(fallbackChoices([other, off, MYHUB]).map(one => one.name)).toEqual(['myhub', 'omni'])
  })

  test('compaction is due past the share of the profile window', () => {
    expect(needsCompaction(90_000, 100_000, 0.85)).toBe(true)
    expect(needsCompaction(80_000, 100_000, 0.85)).toBe(false)
    expect(needsCompaction(null, 100_000, 0.85)).toBe(false)
  })

  test('the HUD badge names the profile and its model', () => {
    expect(hubBadge('myhub', 'antigravity/gemini-3.8-flash-tiered')).toBe('⇄ myhub · antigravity/gemini-3.8-flash-tiered')
    expect(hubBadge('myhub', null)).toBe('⇄ myhub')
  })
})
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `claude plugin test .`
Expected: FAIL di `tests/provider.test.ts` (modul `../hooks/provider` tidak ada)

- [ ] **Step 3: Implementasi**

`hooks/provider.ts`:

```ts
/*
 * Provider router, the Nexus side: profiles (a hub's URL, key and models),
 * their checks, and the words the pane, the HUD and the commands use. Pure;
 * register.tsx talks to the router and the store.
 */

export type ProviderModels = { opus?: string; sonnet?: string; haiku?: string }

export type ProviderProfile = {
  name: string
  hubUrl: string
  apiKey: string
  models: ProviderModels
  contextWindow: number
  fallback: boolean
  isDefault: boolean
}

export type ProfileDraft = {
  name?: string
  hubUrl?: string
  apiKey?: string
  models?: ProviderModels
  contextWindow?: string | number
  fallback?: boolean
  isDefault?: boolean
}

export const DEFAULT_WINDOW = 200_000
const TIERS = ['opus', 'sonnet', 'haiku'] as const
const NAME = /^[a-z0-9-]{1,32}$/

export function normalizeHubUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function cleanModels(models: ProviderModels | undefined): ProviderModels {
  const out: ProviderModels = {}
  for (const tier of TIERS) {
    const value = models?.[tier]?.trim()
    if (value !== undefined && value !== '') out[tier] = value
  }

  return out
}

export function primaryModel(models: ProviderModels): string | undefined {
  return TIERS.map(tier => models[tier]).find((one): one is string => typeof one === 'string' && one !== '')
}

export function validateProfile(
  draft: ProfileDraft,
  others: readonly ProviderProfile[],
): { profile: ProviderProfile; errors: null } | { profile: null; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const name = (draft.name ?? '').trim().toLowerCase()
  if (name === 'claude') errors.name = 'claude is the subscription route; pick another name'
  else if (!NAME.test(name)) errors.name = 'use 1-32 lowercase letters, digits or dashes'
  else if (others.some(one => one.name === name)) errors.name = `a profile named ${name} already exists`
  const hubUrl = normalizeHubUrl(draft.hubUrl ?? '')
  if (!/^https?:\/\/[^\s/]+/.test(hubUrl)) errors.hubUrl = 'an http(s) URL, such as https://hub.example.com/v1'
  const apiKey = (draft.apiKey ?? '').trim()
  if (apiKey === '') errors.apiKey = 'the hub needs a key'
  const models = cleanModels(draft.models)
  if (primaryModel(models) === undefined) errors.models = 'fill at least one of the opus, sonnet or haiku models'
  const rawWindow = draft.contextWindow === undefined || draft.contextWindow === '' ? DEFAULT_WINDOW : Number(draft.contextWindow)
  if (!Number.isInteger(rawWindow) || rawWindow < 8000) errors.contextWindow = 'a whole number of tokens, 8000 or more'
  if (Object.keys(errors).length > 0) return { profile: null, errors }

  return {
    profile: { name, hubUrl, apiKey, models, contextWindow: rawWindow, fallback: draft.fallback === true, isDefault: draft.isDefault === true },
    errors: null,
  }
}

/** The profiles a store holds, broken entries left out. */
export function readProfiles(stored: unknown): ProviderProfile[] {
  if (!Array.isArray(stored)) return []

  return stored.flatMap(one => {
    if (one === null || typeof one !== 'object') return []
    const result = validateProfile(one as ProfileDraft, [])
    const raw = one as ProviderProfile
    return result.profile === null ? [] : [{ ...result.profile, fallback: raw.fallback === true, isDefault: raw.isDefault === true }]
  })
}

export function maskKey(key: string): string {
  const one = key.trim()

  return one.length < 12 ? '••••' : `${one.slice(0, 4)}…${one.slice(-4)}`
}

/** The router this session runs behind: a loopback ANTHROPIC_BASE_URL and its control token, or none. */
export function routerLinkFrom(baseUrl: string | undefined, controlToken: string | undefined): { url: string; token: string } | null {
  if (baseUrl === undefined || controlToken === undefined || controlToken.length < 32) return null
  const match = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\/?$/.exec(baseUrl.trim())

  return match === null ? null : { url: `http://127.0.0.1:${match[2]}`, token: controlToken }
}

export function fallbackChoices(profiles: readonly ProviderProfile[]): ProviderProfile[] {
  return profiles.filter(one => one.fallback).sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

export function needsCompaction(tokens: number | null, window: number, share: number): boolean {
  return tokens !== null && tokens >= window * share
}

export function hubBadge(route: string, model: string | null): string {
  return model === null ? `⇄ ${route}` : `⇄ ${route} · ${model}`
}

export function parseProviderArgs(
  args: string,
): { verb: 'pane' } | { verb: 'status' } | { verb: 'use'; name: string } | { verb: 'error'; message: string } {
  const [verb = '', name = ''] = args.trim().toLowerCase().split(/\s+/)
  if (verb === '') return { verb: 'pane' }
  if (verb === 'status') return { verb: 'status' }
  if (verb === 'use') return name === '' ? { verb: 'error', message: 'Name a profile: /provider-nexus use <name> (or claude).' } : { verb: 'use', name }

  return { verb: 'error', message: 'Use /provider-nexus, /provider-nexus status or /provider-nexus use <name|claude>.' }
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `claude plugin test .`
Expected: PASS, semua tes lama (90) + 10 tes provider

- [ ] **Step 5: Commit**

```bash
git add hooks/provider.ts tests/provider.test.ts
git commit -m "Provider profiles: validation, masking, router link, commands"
```

---

### Task 5: Link router, store profil, `/provider-nexus use|status`, HUD, compaction

**Files:**
- Modify: `types/index.d.ts` (tipe `NexusProviderView`, `NexusRouterLink`, kunci state `provider`, `routerLink`)
- Modify: `hooks/state.ts` (`PANE.provider`, `IDLE_PROVIDER`)
- Modify: `hooks/register.tsx` (atom, fungsi router, perintah, HUD baris model `{now.model !== '' && …}`, `statusText`, `session.start`, `session.measure`)
- Test: `tests/provider.test.ts` (tambahan describe engine)

**Interfaces:**
- Consumes: Task 4 (`routerLinkFrom`, `readProfiles`, `parseProviderArgs`, `primaryModel`, `maskKey`, `hubBadge`, `needsCompaction`), endpoint kontrol Task 2.
- Produces (di `register.tsx`, dipakai Task 6–7):
  - `routerCall($, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>`
  - `loadProfiles($): Promise<ProviderProfile[]>`, `saveProfiles($, list: ProviderProfile[]): Promise<void>` (keduanya memperbarui atom `provider.profiles` dengan ringkasan tersamar)
  - `useRoute($, name: string): Promise<string>` (teks hasil untuk command/toast)
  - atom `provider: NexusProviderView`, atom `routerLink: NexusRouterLink | null`

- [ ] **Step 0: Siapkan type-check (sekali)**

Buat `<scratchpad>/tc/tsconfig.json` bila belum ada:

```json
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": [
    "<path ke plugin-authoring>/types/claude-code.d.ts",
    "C:/Users/encry/Projects/nexus-mod/hooks",
    "C:/Users/encry/Projects/nexus-mod/types",
    "C:/Users/encry/Projects/nexus-mod/tests"
  ]
}
```

`<path ke plugin-authoring>` adalah folder yang disebut skill `plugin-authoring` saat dimuat (berisi `types/claude-code.d.ts`).

- [ ] **Step 1: Tulis tes engine yang gagal** (tambahkan ke `tests/provider.test.ts`; impor `mock` dari `claude-code/testing`)

```ts
const BASE_OPTIONS = {
  checkpoints: false,
  autoVerify: false,
  designLens: false,
  assumptionAudit: 'off',
  handoff: false,
  notify: false,
  suggestNext: false,
  compactGuard: false,
  loopGuard: false,
  trimOutput: false,
  quotaGuard: 0,
  turnFooter: false,
} as const

const CONTROL = 'c'.repeat(64)

function routerEnv(on: Parameters<Parameters<typeof test>[2]>[1]) {
  const env: Record<string, string | undefined> = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:51234', NEXUS_ROUTER_TOKEN: CONTROL }
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('env.set', (_, e) => {
    env[e.name] = e.value
    return { value: undefined }
  })
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = []
  on('http.fetch', (_, e) => {
    const body = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    calls.push({ url: e.url, method: e.init?.method ?? 'GET', headers: e.init?.headers ?? {}, body })
    const data = e.url.endsWith('/__nexus/status') ? { route: 'claude', model: null, counts: { claude: 0, hub: 0 }, held: [] } : e.url.includes('/__nexus/events') ? { events: [] } : { ok: true }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) } }
  })
  on('session.root', () => ({ value: 'C:/app' }))

  return { env, calls }
}

describe('router link in a claude-nexus session', () => {
  test('the control token is read once, kept in state, and taken out of the env tools inherit', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    const { env } = routerEnv(on)
    await $.session.start?.({} as never)
    expect(env.NEXUS_ROUTER_TOKEN).toBeUndefined()
    expect((await $.command.run({ command: 'provider-nexus', args: 'status' } as never)).text).toContain('Claude (subscription)')
  })

  test('the link survives a reload: status still works with the token gone from the env', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    const { env, calls } = routerEnv(on)
    await $.session.start?.({} as never)
    await $.session.start?.({} as never)
    expect(env.NEXUS_ROUTER_TOKEN).toBeUndefined()
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    expect(calls.at(-1)?.headers['x-nexus-control']).toBe(CONTROL)
  })

  test('use sends the profile with its key to the router and names the route', { options: BASE_OPTIONS }, async ($, on) => {
    const store = mock.store(on)
    const { calls } = routerEnv(on)
    await $.store.set('providers', [MYHUB])
    await $.session.start?.({} as never)
    const answer = await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)
    expect(answer.text).toContain('myhub')
    const route = calls.find(one => one.url.endsWith('/__nexus/route'))
    expect(route?.body).toEqual({ route: 'myhub', profile: { hubUrl: MYHUB.hubUrl, apiKey: MYHUB.apiKey, models: MYHUB.models, contextWindow: MYHUB.contextWindow } })
    expect(JSON.stringify(await $.state.get({ plugin: 'nexus', key: 'provider' } as never))).not.toContain(MYHUB.apiKey)
    void store
  })

  test('an unknown profile is refused without calling the router', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    const { calls } = routerEnv(on)
    await $.session.start?.({} as never)
    expect((await $.command.run({ command: 'provider-nexus', args: 'use nope' } as never)).text).toContain('No profile named nope')
    expect(calls.some(one => one.url.endsWith('/__nexus/route'))).toBe(false)
  })
})

describe('provider in a plain claude session', () => {
  test('without the launcher the command explains how to start one', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    on('env.get', () => ({ value: undefined }))
    on('session.root', () => ({ value: 'C:/app' }))
    await $.session.start?.({} as never)
    expect((await $.command.run({ command: 'provider-nexus', args: 'use myhub' } as never)).text).toContain('claude-nexus')
  })
})
```

Catatan untuk pelaksana: bila `$.session.start` tidak tersedia sebagai pemanggilan di harness tes, ganti dengan pola yang sudah dipakai `tests/theme.test.ts` (mount lewat `test` options) dan panggil logika start lewat perintah `provider-nexus status` yang memanggil `ensureRouterLink($)` (lihat Step 3) secara lazy. Tes harus tetap memeriksa hal yang sama: env dikosongkan, link dibaca dari state.

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `claude plugin test .`
Expected: FAIL (perintah `provider-nexus` tidak ada)

- [ ] **Step 3: Implementasi**

`types/index.d.ts` — tambahkan sebelum `declare module`:

```ts
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
  profiles: NexusProviderSummary[]
  tests: Record<string, string>
  draft: NexusProviderDraft | null
}
/** The router this session runs behind (its control token), kept so a reload finds it. */
export type NexusRouterLink = { url: string; token: string }
```

dan di dalam `'nexus': { … }`:

```ts
      /** The provider route, profiles (masked) and the pane's draft. */
      provider: NexusProviderView
      /** The router this claude-nexus session runs behind; null in a plain session. */
      routerLink: NexusRouterLink | null
```

`hooks/state.ts` — tambah `provider: 'nexus-provider',` di `PANE`, dan:

```ts
export const IDLE_PROVIDER: NexusProviderView = { linked: false, route: 'claude', model: null, profiles: [], tests: {}, draft: null }
```

(impor `NexusProviderView` dari `../types`).

`hooks/register.tsx`:

1. Impor:

```ts
import {
  fallbackChoices,
  hubBadge,
  maskKey,
  needsCompaction,
  parseProviderArgs,
  primaryModel,
  readProfiles,
  routerLinkFrom,
  type ProviderProfile,
} from './provider'
```

dan tambahkan `IDLE_PROVIDER` ke impor `./state`, `NexusProviderView`, `NexusRouterLink` ke impor `../types`.

2. Atom (setelah `themeName`):

```ts
// The provider route this session uses, the profiles (keys masked) and the pane's draft.
const provider = atom({ plugin: 'nexus', key: 'provider' } as const, IDLE_PROVIDER)
// The router a claude-nexus session runs behind; its control token lives here once the env forgets it.
const routerLink = atom({ plugin: 'nexus', key: 'routerLink' } as const, null as NexusRouterLink | null)
```

3. Bagian baru sebelum `// ═══ 4. Delivery`:

```ts
// ── Provider router: the claude-nexus session's link to its router ───────

const PROVIDERS_KEY = 'providers'

/** The router link: from state, else from the env the launcher set (then taken out of what tools inherit). */
async function ensureRouterLink($: Engine): Promise<NexusRouterLink | null> {
  const kept = await read($, routerLink)
  if (kept !== null) return kept
  const link = routerLinkFrom(await $.env.get('ANTHROPIC_BASE_URL'), await $.env.get('NEXUS_ROUTER_TOKEN'))
  if (link === null) return null
  await update($, routerLink, () => link)
  await $.env.set('NEXUS_ROUTER_TOKEN', undefined)
  await update($, provider, now => ({ ...now, linked: true }))

  return link
}

async function routerCall(
  $: Engine,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const link = await read($, routerLink)
  if (link === null) return { ok: false, status: 0, data: {} }
  const response = await $.http.fetch(`${link.url}${path}`, {
    method,
    headers: { 'x-nexus-control': link.token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(response.text) as Record<string, unknown>
  } catch {
    // a body that is not JSON: the status says enough
  }

  return { ok: response.ok, status: response.status, data }
}

function summarize(profile: ProviderProfile) {
  return {
    name: profile.name,
    hubUrl: profile.hubUrl,
    key: maskKey(profile.apiKey),
    model: primaryModel(profile.models) ?? '',
    contextWindow: profile.contextWindow,
    fallback: profile.fallback,
    isDefault: profile.isDefault,
  }
}

async function loadProfiles($: Engine): Promise<ProviderProfile[]> {
  const list = readProfiles(await $.store.get(PROVIDERS_KEY).catch(() => null))
  await update($, provider, now => ({ ...now, profiles: list.map(summarize) }))

  return list
}

async function saveProfiles($: Engine, list: ProviderProfile[]): Promise<void> {
  await $.store.set(PROVIDERS_KEY, list)
  await update($, provider, now => ({ ...now, profiles: list.map(summarize) }))
}

const NOT_LINKED =
  'This session does not run behind the Nexus router. Start Claude Code with claude-nexus (bin/claude-nexus.cmd in the Nexus folder) to switch providers; plain claude keeps Remote Control.'

const COMPACT_THEN_SWITCH = 'Compact, then switch'
const SWITCH_ANYWAY = 'Switch anyway'
const CANCEL = 'Cancel'

/** Points the router at Claude or a profile; the text says what happened. */
async function useRoute($: Engine, name: string): Promise<string> {
  if ((await ensureRouterLink($)) === null) return NOT_LINKED
  if (name === 'claude') {
    const answer = await routerCall($, 'POST', '/__nexus/route', { route: 'claude' })
    if (!answer.ok) return `The router refused: ${String(answer.data.error ?? answer.status)}`
    await update($, provider, now => ({ ...now, route: 'claude', model: null }))

    return 'Back on Claude (subscription).'
  }
  const profile = (await loadProfiles($)).find(one => one.name === name)
  if (profile === undefined) return `No profile named ${name}. /provider-nexus opens the list.`
  const tokens = (await read($, hud)).tokens
  if (needsCompaction(tokens, profile.contextWindow, 0.8)) {
    const choice = await $.ui
      .ask(`The context (${tokens ?? 0} tokens) is past 80% of ${profile.name}'s window (${profile.contextWindow}). Compact first?`, {
        header: 'Provider',
        options: [COMPACT_THEN_SWITCH, SWITCH_ANYWAY, CANCEL],
      })
      .catch(() => CANCEL)
    if (choice === CANCEL) return 'Not switched.'
    if (choice === COMPACT_THEN_SWITCH) await $.session.compact({ instructions: 'Keep file paths, open tasks and decisions.' }).catch(() => undefined)
  }
  const answer = await routerCall($, 'POST', '/__nexus/route', {
    route: profile.name,
    profile: { hubUrl: profile.hubUrl, apiKey: profile.apiKey, models: profile.models, contextWindow: profile.contextWindow },
  })
  if (!answer.ok) return `The router refused: ${String(answer.data.error ?? answer.status)}`
  const model = primaryModel(profile.models) ?? null
  await update($, provider, now => ({ ...now, route: profile.name, model }))

  return `Now on ${profile.name}${model === null ? '' : ` (${model})`}. Requests go to ${profile.hubUrl}; /provider-nexus use claude goes back.`
}

async function providerStatus($: Engine): Promise<string> {
  if ((await ensureRouterLink($)) === null) return NOT_LINKED
  const answer = await routerCall($, 'GET', '/__nexus/status')
  if (!answer.ok) return 'The router did not answer. Is this session still running under claude-nexus?'
  const route = String(answer.data.route ?? 'claude')
  const model = typeof answer.data.model === 'string' ? answer.data.model : null
  await update($, provider, now => ({ ...now, route, model }))
  const counts = answer.data.counts as { claude?: number; hub?: number } | undefined

  return [
    `Route: ${route === 'claude' ? 'Claude (subscription)' : hubBadge(route, model)}`,
    `Requests this session: ${counts?.claude ?? 0} to Claude, ${counts?.hub ?? 0} to hubs`,
    `Profiles: ${(await loadProfiles($)).map(one => one.name).join(', ') || 'none yet (/provider-nexus to add one)'}`,
  ].join('\n')
}
```

4. `COMMANDS` — tambahkan:

```ts
  { name: 'provider-nexus', description: 'Nexus: switch this claude-nexus session between Claude and a hub profile', argumentHint: '[status | use <name|claude>]', immediate: true },
```

5. Di `session.start` setelah `await loadMcpOff($)`:

```ts
    await loadProfiles($)
    if ((await ensureRouterLink($)) !== null) void providerStatus($).catch(() => undefined)
```

6. Handler perintah (dekat handler `mcp-nexus`):

```ts
  on('command.run', { command: 'provider-nexus' }, async ($, e) => {
    const parsed = parseProviderArgs(e.args)
    if (parsed.verb === 'error') return { text: parsed.message }
    if (parsed.verb === 'status') return { text: await providerStatus($) }
    if (parsed.verb === 'use') return { text: await useRoute($, parsed.name) }
    await loadProfiles($)
    await openPane($, PANE.provider, 'Providers')

    return {}
  })
```

7. HUD: ganti baris

```tsx
            {now.model !== '' && <Text> · {ic.model} {now.model}</Text>}
```

dengan

```tsx
            {route.route !== 'claude' ? (
              <Text color="magenta"> · {hubBadge(route.route, route.model)}</Text>
            ) : (
              now.model !== '' && <Text> · {ic.model} {now.model}</Text>
            )}
```

dan di awal render `AbovePrompt` (di samping pembacaan atom lain) tambahkan `const route = await read($, provider)`. Bila warna `magenta` tidak lolos validasi tema, pakai `paint(theme, 'accent')` seperti segmen lain di band itu.

8. `statusText`: tambahkan baris sebelum `Context audit`:

```ts
    `  Provider router     /provider-nexus  (sessions started with claude-nexus)`,
```

9. `session.measure`, di dalam blok `if (e.changed.includes('rateLimits') || e.changed.includes('context'))` setelah `update($, hud, …)`:

```ts
      // On a hub, compact before the profile's own window fills.
      const view = await read($, provider)
      if (view.route !== 'claude' && !compactingForHub) {
        const profile = view.profiles.find(one => one.name === view.route)
        if (profile !== undefined && needsCompaction(context.tokens ?? null, profile.contextWindow, 0.85)) {
          compactingForHub = true
          void $.session
            .compact({ instructions: 'Keep file paths, open tasks, check results and decisions.' })
            .catch(() => undefined)
            .finally(() => {
              compactingForHub = false
            })
        }
      }
```

dengan `let compactingForHub = false` dideklarasikan di samping `let lastContextPct = 0`.

- [ ] **Step 4: Jalankan tes, type-check, validasi**

Run: `claude plugin test .` → PASS (semua)
Run: type-check (Step 0) → exit 0
Run: `claude plugin validate .` → `✔ Validation passed`; baris `env reads` memuat `ANTHROPIC_BASE_URL, NEXUS_ROUTER_TOKEN`, `env writes` memuat `NEXUS_ROUTER_TOKEN`

- [ ] **Step 5: Commit**

```bash
git add types/index.d.ts hooks/state.ts hooks/register.tsx tests/provider.test.ts
git commit -m "Provider: router link, profiles store, /provider-nexus use|status, HUD badge, hub compaction"
```

---

### Task 6: Pane profil (daftar, tambah/ubah per langkah, ambil model, tes koneksi)

**Files:**
- Modify: `hooks/register.tsx` (render `Pane` `PANE.provider`, fungsi draft, `fetchHubModels`, `testProfile`)
- Modify: `hooks/provider.ts` (`DRAFT_STEPS`, `nextStep`, `draftToProfile`)
- Test: `tests/provider.test.ts`

**Interfaces:**
- Consumes: `loadProfiles`, `saveProfiles`, `useRoute`, `validateProfile`, `maskKey`.
- Produces (`provider.ts`): `DRAFT_STEPS: readonly NexusProviderDraft['step'][]` = `['name','hubUrl','apiKey','opus','sonnet','haiku','contextWindow','fallback']`; `nextStep(step): step | null`; `draftToProfile(values: Record<string,string>): ProfileDraft`.
- Produces (`register.tsx`): `startDraft($, editing: string | null)`, `submitDraftField($, value: string)`, `fetchHubModels($, hubUrl: string, apiKey: string): Promise<string[]>`, `testProfile($, name: string): Promise<string>`.

- [ ] **Step 1: Tulis tes yang gagal**

Tambahkan ke `tests/provider.test.ts` (impor `DRAFT_STEPS, draftToProfile, nextStep` dari `../hooks/provider`):

```ts
describe('profile draft', () => {
  test('steps run in order and end after fallback', () => {
    expect(DRAFT_STEPS[0]).toBe('name')
    expect(nextStep('apiKey')).toBe('opus')
    expect(nextStep('fallback')).toBeNull()
  })

  test('draft values become a profile draft; yes marks fallback and default', () => {
    expect(
      draftToProfile({ name: 'myhub', hubUrl: 'https://h/v1', apiKey: 'k', opus: 'm', sonnet: '', haiku: '', contextWindow: '', fallback: 'yes-default' }),
    ).toEqual({ name: 'myhub', hubUrl: 'https://h/v1', apiKey: 'k', models: { opus: 'm', sonnet: '', haiku: '' }, contextWindow: '', fallback: true, isDefault: true })
  })
})

describe('provider pane', () => {
  test('a saved profile shows its key masked, never whole', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    await $.store.set('providers', [MYHUB])
    await $.command.run({ command: 'provider-nexus', args: '' } as never)
    const pane = await $.ui.mount({ component: 'Pane', requestId: 'nexus-provider' } as never)
    const text = JSON.stringify(pane)
    expect(text).toContain('myhub')
    expect(text).toContain(maskKey(MYHUB.apiKey))
    expect(text).not.toContain(MYHUB.apiKey)
  })

  test('test connection reports each mapped model', { options: BASE_OPTIONS }, async ($, on) => {
    mock.store(on)
    on('session.root', () => ({ value: 'C:/app' }))
    on('env.get', () => ({ value: undefined }))
    const asked: string[] = []
    on('http.fetch', (_, e) => {
      asked.push(`${e.url} ${JSON.parse(e.init?.body ?? '{}').model}`)
      return { value: { status: 200, ok: true, headers: {}, text: '{"type":"message","content":[{"type":"text","text":"ok"}]}' } }
    })
    await $.store.set('providers', [{ ...MYHUB, models: { opus: 'a', haiku: 'b' } }])
    const answer = await $.command.run({ command: 'provider-nexus', args: 'test myhub' } as never)
    expect(answer.text).toContain('✓ a')
    expect(answer.text).toContain('✓ b')
    expect(asked).toEqual(['https://hub.example.com/v1/messages a', 'https://hub.example.com/v1/messages b'])
  })
})
```

Juga ubah `parseProviderArgs` (Task 4) agar menerima `test <name>` → `{ verb: 'test', name }`, dan tambahkan ke tes Task 4:

```ts
    expect(parseProviderArgs('test myhub')).toEqual({ verb: 'test', name: 'myhub' })
```

Catatan untuk pelaksana: bila harness tidak menyediakan `$.ui.mount` dengan bentuk itu, gunakan pola mount yang dipakai `tests/nexus.test.ts` untuk band (`the band draws the HUD …`) dan sesuaikan pemanggilannya; yang diuji tetap: nama profil dan key tersamar tampil, key utuh tidak.

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `claude plugin test .`
Expected: FAIL (`DRAFT_STEPS` tidak diekspor; verb `test` belum ada)

- [ ] **Step 3: Implementasi**

`hooks/provider.ts` — tambahkan:

```ts
export type DraftStep = 'name' | 'hubUrl' | 'apiKey' | 'opus' | 'sonnet' | 'haiku' | 'contextWindow' | 'fallback'

export const DRAFT_STEPS: readonly DraftStep[] = ['name', 'hubUrl', 'apiKey', 'opus', 'sonnet', 'haiku', 'contextWindow', 'fallback']

export function nextStep(step: DraftStep): DraftStep | null {
  return DRAFT_STEPS[DRAFT_STEPS.indexOf(step) + 1] ?? null
}

/** The pane's answers as a profile draft; fallback answers: no, yes, yes-default. */
export function draftToProfile(values: Record<string, string>): ProfileDraft {
  return {
    name: values.name,
    hubUrl: values.hubUrl,
    apiKey: values.apiKey,
    models: { opus: values.opus, sonnet: values.sonnet, haiku: values.haiku },
    contextWindow: values.contextWindow,
    fallback: values.fallback === 'yes' || values.fallback === 'yes-default',
    isDefault: values.fallback === 'yes-default',
  }
}
```

dan pada `parseProviderArgs` tambahkan cabang sebelum `return { verb: 'error' … }`:

```ts
  if (verb === 'test') return name === '' ? { verb: 'error', message: 'Name a profile: /provider-nexus test <name>.' } : { verb: 'test', name }
```

(perluas tipe kembalian dengan `| { verb: 'test'; name: string }`).

`hooks/register.tsx`:

```ts
const STEP_LABEL: Record<DraftStep, string> = {
  name: 'Name (lowercase, e.g. myhub)',
  hubUrl: 'Hub URL (e.g. https://hub.example.com/v1)',
  apiKey: 'API key (shown while you type; masked once saved)',
  opus: 'Model for opus requests',
  sonnet: 'Model for sonnet requests (empty: same as the first one filled)',
  haiku: 'Model for haiku requests (empty: same as the first one filled)',
  contextWindow: 'Context window in tokens (empty: 200000)',
  fallback: 'Offer this profile when Claude quota runs out?',
}

async function fetchHubModels($: Engine, hubUrl: string, apiKey: string): Promise<string[]> {
  try {
    const response = await $.http.fetch(`${normalizeHubUrl(hubUrl)}/models`, {
      headers: { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) return []
    const parsed = JSON.parse(response.text) as { data?: { id?: string }[] }

    return (parsed.data ?? []).map(one => one.id).filter((id): id is string => typeof id === 'string').slice(0, 60)
  } catch {
    return []
  }
}

async function startDraft($: Engine, editing: string | null): Promise<void> {
  const profile = editing === null ? undefined : (await loadProfiles($)).find(one => one.name === editing)
  const values: Record<string, string> =
    profile === undefined
      ? {}
      : {
          name: profile.name,
          hubUrl: profile.hubUrl,
          apiKey: profile.apiKey,
          opus: profile.models.opus ?? '',
          sonnet: profile.models.sonnet ?? '',
          haiku: profile.models.haiku ?? '',
          contextWindow: String(profile.contextWindow),
          fallback: profile.isDefault ? 'yes-default' : profile.fallback ? 'yes' : 'no',
        }
  await update($, provider, now => ({ ...now, draft: { step: 'name', editing, values, models: [], error: null } }))
}

async function submitDraftField($: Engine, value: string): Promise<void> {
  const view = await read($, provider)
  const draft = view.draft
  if (draft === null) return
  const values = { ...draft.values, [draft.step]: value.trim() }
  let models = draft.models
  if (draft.step === 'apiKey') models = await fetchHubModels($, values.hubUrl ?? '', values.apiKey ?? '')
  const step = nextStep(draft.step)
  if (step !== null) {
    await update($, provider, now => ({ ...now, draft: { ...draft, step, values, models, error: null } }))
    return
  }
  const all = await loadProfiles($)
  const others = all.filter(one => one.name !== draft.editing)
  const result = validateProfile(draftToProfile(values), others)
  if (result.profile === null) {
    const [field, message] = Object.entries(result.errors)[0] ?? ['name', 'check the fields']
    const back = (field === 'models' ? 'opus' : field) as DraftStep
    await update($, provider, now => ({ ...now, draft: { ...draft, step: back, values, models, error: message } }))
    return
  }
  const saved = result.profile
  const list = [...others.map(one => (saved.isDefault ? { ...one, isDefault: false } : one)), saved]
  await saveProfiles($, list)
  await update($, provider, now => ({ ...now, draft: null }))
  $.ui.toast(`Saved ${saved.name} (key ${maskKey(saved.apiKey)}).`)
}

async function testProfile($: Engine, name: string): Promise<string> {
  const profile = (await loadProfiles($)).find(one => one.name === name)
  if (profile === undefined) return `No profile named ${name}.`
  const models = [...new Set(Object.values(profile.models).filter((one): one is string => typeof one === 'string' && one !== ''))]
  const lines: string[] = []
  for (const model of models) {
    const started = await $.clock.now()
    try {
      const response = await $.http.fetch(`${profile.hubUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': profile.apiKey, authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] }),
      })
      const took = (await $.clock.now()) - started
      lines.push(response.ok ? `✓ ${model}  ${took} ms` : `✗ ${model}  HTTP ${response.status}: ${clip(maskSecrets(response.text).text, 160)}`)
    } catch (error) {
      lines.push(`✗ ${model}  ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const text = lines.join('\n')
  await update($, provider, now => ({ ...now, tests: { ...now.tests, [name]: text } }))

  return `${profile.name} (${profile.hubUrl}):\n${text}`
}
```

(Impor tambahan: `DraftStep`, `DRAFT_STEPS`, `draftToProfile`, `nextStep`, `normalizeHubUrl`, `validateProfile` dari `./provider`.)

Handler perintah: tambahkan cabang `if (parsed.verb === 'test') return { text: await testProfile($, parsed.name) }`.

Render pane (di bagian layout, dekat pane lain):

```tsx
  on('ui.render', { component: 'Pane', requestId: PANE.provider }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const Select = 'Select' in elements ? elements.Select : undefined
    const view = await read($, provider)
    const draft = view.draft

    if (draft !== null) {
      const label = STEP_LABEL[draft.step]
      const isModel = draft.step === 'opus' || draft.step === 'sonnet' || draft.step === 'haiku'
      return (
        <Box flexDirection="column">
          <Text bold>{draft.editing === null ? 'New profile' : `Edit ${draft.editing}`} · {DRAFT_STEPS.indexOf(draft.step) + 1}/{DRAFT_STEPS.length}</Text>
          {draft.error !== null && <Text color="red">{draft.error}</Text>}
          {draft.step === 'fallback' && Select !== undefined ? (
            <Select
              key="fallback"
              label={label}
              autoFocus
              options={[
                { value: 'no', label: 'No' },
                { value: 'yes', label: 'Yes' },
                { value: 'yes-default', label: 'Yes, and make it the default' },
              ]}
              value={draft.values.fallback ?? 'no'}
              onSelect={value => void submitDraftField($, value)}
            />
          ) : isModel && draft.models.length > 0 && Select !== undefined ? (
            <Select
              key={draft.step}
              label={label}
              autoFocus
              options={[{ value: '', label: '(empty)' }, ...draft.models.map(id => ({ value: id }))]}
              value={draft.values[draft.step] ?? ''}
              onSelect={value => void submitDraftField($, value)}
            />
          ) : Input !== undefined ? (
            <Input
              key={draft.step}
              label={label}
              autoFocus
              value={draft.step === 'apiKey' ? '' : draft.values[draft.step] ?? ''}
              placeholder={draft.step === 'apiKey' && draft.values.apiKey ? `keep ${maskKey(draft.values.apiKey)}: press Enter` : ''}
              onSubmit={value => void submitDraftField($, draft.step === 'apiKey' && value.trim() === '' ? draft.values.apiKey ?? '' : value)}
            />
          ) : (
            <Text dimColor>This surface has no text field; add profiles from the terminal.</Text>
          )}
          <Button key="cancel" plain hotkey="x" label="Cancel" onPress={() => void update($, provider, now => ({ ...now, draft: null }))} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>{view.linked ? `Route: ${view.route === 'claude' ? 'Claude (subscription)' : hubBadge(view.route, view.model)}` : 'Not a claude-nexus session: profiles can be added and tested here, switching needs claude-nexus.'}</Text>
        {view.linked && view.route !== 'claude' && <Button key="claude" plain hotkey="0" label="Use Claude" onPress={async () => $.ui.toast(await useRoute($, 'claude'))} />}
        {view.profiles.length === 0 && <Text dimColor>No profiles yet.</Text>}
        {view.profiles.map((one, index) => (
          <Box key={`p-${one.name}`} flexDirection="column">
            <Text>
              {one.name === view.route ? '● ' : '  '}
              <Text bold>{one.name}</Text> · {one.model} · {one.key} · {one.contextWindow} tok{one.fallback ? (one.isDefault ? ' · fallback (default)' : ' · fallback') : ''}
            </Text>
            <Box flexDirection="row" columnGap={2}>
              {view.linked && <Button key={`use-${one.name}`} plain hotkey={String(index + 1)} label="Use" onPress={async () => $.ui.toast(await useRoute($, one.name))} />}
              <Button key={`test-${one.name}`} plain label="Test" onPress={async () => void (await testProfile($, one.name))} />
              <Button key={`edit-${one.name}`} plain label="Edit" onPress={() => void startDraft($, one.name)} />
              <Button
                key={`del-${one.name}`}
                plain
                label="Delete"
                onPress={async () => {
                  const answer = await $.ui.ask(`Delete the profile ${one.name}?`, { header: 'Provider', options: ['Delete', 'Keep'] }).catch(() => 'Keep')
                  if (answer === 'Delete') await saveProfiles($, (await loadProfiles($)).filter(profile => profile.name !== one.name))
                }}
              />
            </Box>
            {view.tests[one.name] !== undefined && <Text dimColor>{view.tests[one.name]}</Text>}
          </Box>
        ))}
        <Button key="add" plain hotkey="a" label="Add profile" onPress={() => void startDraft($, null)} />
      </Box>
    )
  })
```

- [ ] **Step 4: Jalankan tes, type-check, validasi**

Run: `claude plugin test .` → PASS
Run: type-check → exit 0
Run: `claude plugin validate .` → `✔ Validation passed`

- [ ] **Step 5: Commit**

```bash
git add hooks/provider.ts hooks/register.tsx tests/provider.test.ts
git commit -m "Provider pane: profiles list, step-by-step form, hub model list, connection test"
```

---

### Task 7: Fallback saat kuota habis, kembali ke Claude, quota guard

**Files:**
- Modify: `hooks/config.ts` (`fallbackMode`), `.claude-plugin/plugin.json` (userConfig `fallbackMode`)
- Modify: `hooks/register.tsx` (`watchRouter`, `handleLimit`, kembali ke Claude di `turn.complete`, opsi quota guard, toast `upstream-error`)
- Test: `tests/provider.test.ts`

**Interfaces:**
- Consumes: `routerCall`, `useRoute`, `loadProfiles`, `fallbackChoices`, `ensureRouterLink`.
- Produces: `NexusConfig.fallbackMode: 'ask' | 'auto' | 'off'`; `handleRouterEvent($, cfg, event): Promise<void>` (diekspor ke tes hanya lewat perilaku: event `limit` dari `GET /__nexus/events`).

- [ ] **Step 1: Tulis tes yang gagal**

```ts
describe('fallback when Claude quota runs out', () => {
  function limitRouter(on: Parameters<Parameters<typeof test>[2]>[1]) {
    const routed = routerEnv(on)
    let served = false
    on('http.fetch', (_, e) => {
      const body = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
      routed.calls.push({ url: e.url, method: e.init?.method ?? 'GET', headers: e.init?.headers ?? {}, body })
      let data: unknown = { ok: true }
      if (e.url.includes('/__nexus/events')) {
        data = served ? { events: [] } : { events: [{ type: 'limit', id: 'h1', window: 'five_hour', resetsAt: 9_000_000 }] }
        served = true
      }
      if (e.url.endsWith('/__nexus/status')) data = { route: 'claude', model: null, counts: { claude: 1, hub: 0 }, held: [] }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) } }
    })
    return routed
  }

  test('ask: the person picks the profile, the held request is retried there', { options: { ...BASE_OPTIONS, fallbackMode: 'ask' } }, async ($, on) => {
    mock.store(on)
    const { calls } = limitRouter(on)
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => ({
      result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Continue on myhub' } },
    }))
    await $.store.set('providers', [MYHUB])
    await $.session.start?.({} as never)
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    for (let i = 0; i < 400 && !calls.some(one => one.url.endsWith('/__nexus/decision')); i++) await Promise.resolve()
    const route = calls.find(one => one.url.endsWith('/__nexus/route'))
    const decision = calls.find(one => one.url.endsWith('/__nexus/decision'))
    expect((route?.body as { route?: string } | undefined)?.route).toBe('myhub')
    expect(decision?.body).toEqual({ id: 'h1', action: 'retry' })
  })

  test('off: the held request is released at once', { options: { ...BASE_OPTIONS, fallbackMode: 'off' } }, async ($, on) => {
    mock.store(on)
    const { calls } = limitRouter(on)
    await $.store.set('providers', [MYHUB])
    await $.session.start?.({} as never)
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    for (let i = 0; i < 400 && !calls.some(one => one.url.endsWith('/__nexus/decision')); i++) await Promise.resolve()
    expect(calls.find(one => one.url.endsWith('/__nexus/decision'))?.body).toEqual({ id: 'h1', action: 'release' })
    expect(calls.some(one => one.url.endsWith('/__nexus/route'))).toBe(false)
  })

  test('no fallback profile: released, nothing asked', { options: { ...BASE_OPTIONS, fallbackMode: 'ask' } }, async ($, on) => {
    mock.store(on)
    const { calls } = limitRouter(on)
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      asked = true
      return { result: {} as never }
    })
    await $.store.set('providers', [{ ...MYHUB, fallback: false, isDefault: false }])
    await $.session.start?.({} as never)
    await $.command.run({ command: 'provider-nexus', args: 'status' } as never)
    for (let i = 0; i < 400 && !calls.some(one => one.url.endsWith('/__nexus/decision')); i++) await Promise.resolve()
    expect(calls.find(one => one.url.endsWith('/__nexus/decision'))?.body).toEqual({ id: 'h1', action: 'release' })
    expect(asked).toBe(false)
  })
})
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `claude plugin test .`
Expected: FAIL (tidak ada pemanggilan `/__nexus/decision`)

- [ ] **Step 3: Implementasi**

`hooks/config.ts`: tambah `fallbackMode: 'ask' | 'auto' | 'off'` ke `NexusConfig`, dan di `readConfig`:

```ts
  const fallback = text(options.fallbackMode, 'ask')
  // …
    fallbackMode: fallback === 'auto' || fallback === 'off' ? fallback : 'ask',
```

`.claude-plugin/plugin.json` userConfig:

```json
    "fallbackMode": {
      "type": "string",
      "title": "Provider fallback",
      "description": "In a claude-nexus session, when Claude's plan limit is hit: ask which profile to continue on, switch to the default fallback profile at once, or do nothing.",
      "options": ["ask", "auto", "off"],
      "default": "ask"
    }
```

`hooks/register.tsx`, bagian Provider router:

```ts
// When Claude's quota comes back after a fallback: offered once, at a turn's end.
let claudeBackAt: number | null = null
let isWatchingRouter = false

const DONT_SWITCH = "Don't switch"
const continueOn = (name: string) => `Continue on ${name}`

async function decide($: Engine, id: string, action: 'retry' | 'release'): Promise<void> {
  await routerCall($, 'POST', '/__nexus/decision', { id, action }).catch(() => undefined)
}

async function handleRouterEvent($: Engine, cfg: NexusConfig, event: Record<string, unknown>): Promise<void> {
  if (event.type === 'upstream-error') {
    $.ui.toast(`The hub ${String(event.route)} answered ${String(event.status)}. /provider-nexus use claude goes back to Claude.`, { timeoutMs: 8000 })
    return
  }
  if (event.type !== 'limit' || typeof event.id !== 'string') return
  const id = event.id
  if (typeof event.resetsAt === 'number') claudeBackAt = event.resetsAt
  const choices = fallbackChoices(await loadProfiles($))
  if (cfg.fallbackMode === 'off' || choices.length === 0) return decide($, id, 'release')
  const now = await $.clock.now()
  const window = event.window === 'seven_day' ? 'weekly' : event.window === 'five_hour' ? '5-hour' : 'plan'
  const when = typeof event.resetsAt === 'number' ? ` (resets in ${untilReset(event.resetsAt, now)})` : ''
  let target: string | undefined
  if (cfg.fallbackMode === 'auto') {
    target = choices[0]?.name
  } else {
    await setWaiting($, true)
    try {
      const answer = await $.ui.ask(`Claude's ${window} limit is reached${when}. Continue this turn on a hub?`, {
        header: 'Provider',
        options: [...choices.slice(0, 3).map(one => continueOn(one.name)), DONT_SWITCH],
      })
      target = choices.find(one => continueOn(one.name) === answer)?.name
    } catch {
      target = undefined
    } finally {
      await setWaiting($, false)
    }
  }
  if (target === undefined) return decide($, id, 'release')
  const text = await useRoute($, target)
  $.ui.toast(text, { timeoutMs: 8000 })
  await decide($, id, (await read($, provider)).route === target ? 'retry' : 'release')
}

/** Listens to the router for the session's life; stops once it cannot be reached. */
async function watchRouter($: Engine, cfg: NexusConfig): Promise<void> {
  if (isWatchingRouter) return
  isWatchingRouter = true
  let failures = 0
  try {
    while (failures < 5) {
      const answer = await routerCall($, 'GET', '/__nexus/events?wait=25').catch(() => ({ ok: false, status: 0, data: {} }))
      if (!answer.ok) {
        failures += 1
        await $.clock.sleep(2000).catch(() => undefined)
        continue
      }
      failures = 0
      const events = Array.isArray(answer.data.events) ? (answer.data.events as Record<string, unknown>[]) : []
      for (const event of events) await handleRouterEvent($, cfg, event).catch(() => undefined)
    }
  } finally {
    isWatchingRouter = false
  }
}
```

Catatan: fungsi ini memakai `NexusConfig` (impor sudah ada) dan `untilReset` (sudah diimpor dari `./util`).

Di handler `provider-nexus` (Task 5), tambahkan baris pertama di dalam handler, supaya sesi yang `session.start`-nya berjalan sebelum link terbaca tetap mendapat watcher:

```ts
    if ((await ensureRouterLink($)) !== null) void watchRouter($, cfg).catch(() => undefined)
```

Di `session.start`, ganti baris dari Task 5:

```ts
    if ((await ensureRouterLink($)) !== null) {
      void providerStatus($).catch(() => undefined)
      void watchRouter($, cfg).catch(() => undefined)
    }
```

Kembali ke Claude — di `turn.complete`, di dalam `try` setelah blok footer (sebelum `return { ...result, text: footer }` pindahkan footer ke variabel; lalu):

```ts
      // 10. Claude's quota is back after a fallback: offered once, at the turn's end
      const view = await read($, provider)
      if (view.route !== 'claude' && claudeBackAt !== null && (await $.clock.now()) >= claudeBackAt) {
        claudeBackAt = null
        void $.ui
          .ask("Claude's quota has reset. Go back to Claude?", { header: 'Provider', options: ['Back to Claude', `Stay on ${view.route}`] })
          .then(async answer => {
            if (answer === 'Back to Claude') $.ui.toast(await useRoute($, 'claude'))
          })
          .catch(() => undefined)
      }
```

Quota guard — ubah `askQuotaMidTurn` menjadi:

```ts
async function askQuotaMidTurn($: Engine, what: string, turnId: string, switchTo?: string): Promise<void> {
  await setWaiting($, true)
  try {
    const options = switchTo === undefined ? [QUOTA_KEEP, QUOTA_STOP] : [QUOTA_KEEP, `Switch to ${switchTo} now`, QUOTA_STOP]
    const answer = await $.ui.ask(`⚠ QUOTA: ${what}. Let this turn keep going?`, { header: 'Quota', options })
    if (answer === QUOTA_STOP) {
      await $.turn.abort({ turnId })
      $.ui.toast('Turn stopped to save quota.')
    } else if (switchTo !== undefined && answer === `Switch to ${switchTo} now`) {
      $.ui.toast(await useRoute($, switchTo))
    }
  } catch {
    // nobody to ask: the turn goes on
  } finally {
    await setWaiting($, false)
  }
}
```

dan pemanggilnya di `session.measure`:

```ts
          if (current.isWorking && current.id !== null) {
            const linked = (await read($, routerLink)) !== null
            const choice = linked ? fallbackChoices(await loadProfiles($))[0]?.name : undefined
            await askQuotaMidTurn($, what, current.id, choice)
          } else {
```

- [ ] **Step 4: Jalankan tes, type-check, validasi**

Run: `claude plugin test .` → PASS
Run: `node --test bridge/` → PASS
Run: type-check → exit 0
Run: `claude plugin validate .` → `✔ Validation passed`

- [ ] **Step 5: Commit**

```bash
git add hooks/config.ts .claude-plugin/plugin.json hooks/register.tsx tests/provider.test.ts
git commit -m "Provider fallback: held plan-limit requests continue on a hub, back to Claude after reset"
```

---

### Task 8: Dokumentasi, versi 0.5.0, zip, dan uji langsung

**Files:**
- Modify: `README.md`, `.claude-plugin/plugin.json` (`"version": "0.5.0"`), `/nexus` (`statusText` sudah di Task 5)
- Rebuild: `nexus-mod.zip` (di-ignore git)

- [ ] **Step 1: README**

Tambahkan butir fitur setelah **Turn footer**:

```markdown
- **Provider router**: start Claude Code with `claude-nexus` and switch the session between your Claude subscription and your own hub (URL, API key, models for opus/sonnet/haiku) without a restart. When Claude's plan limit is hit, Nexus offers to continue the same turn on a hub, and offers Claude again once the quota resets. Plain `claude` is untouched and keeps Remote Control; a `claude-nexus` session has no Remote Control (Claude Code turns it off whenever `ANTHROPIC_BASE_URL` is set).
```

Baris tabel perintah:

```markdown
| `/provider-nexus` | Provider profiles: add, edit, test, use. Also `/provider-nexus use <name|claude>`, `/provider-nexus status`, `/provider-nexus test <name>` |
```

Baris tabel setting:

```markdown
| Provider fallback | `ask` | In a `claude-nexus` session, when Claude's plan limit is hit: `ask`, `auto` (default fallback profile) or `off` |
```

Bagian baru setelah **Use**:

```markdown
## Provider router

1. Start Claude Code through the launcher, from the Nexus folder: `C:\path\to\nexus-mod\bin\claude-nexus.cmd` (Windows) or `/path/to/nexus-mod/bin/claude-nexus` (macOS, Linux). Any `claude` arguments pass through, e.g. `claude-nexus --resume <id>`. Put that `bin` folder on your PATH to type just `claude-nexus`.
2. `/provider-nexus` → **Add profile**: name, hub URL (the base that ends in `/v1`, e.g. `https://hub.example.com/v1`), API key, then pick the models from the hub's list, the context window and whether to offer it when Claude's quota runs out. **Test** sends one short request per model.
3. **Use** (or `/provider-nexus use myhub`) switches at the next request; `/provider-nexus use claude` goes back. The HUD shows `⇄ <profile> · <model>` while a hub is in use.

The hub must speak the Anthropic Messages API (`POST <hub URL>/messages`), as OmniRoute, LiteLLM and claude-code-router do. Your claude.ai login stays the credential on the Claude route; the hub key is added by the router only on hub requests, and the login never reaches the hub. Profiles, keys included, live in Nexus's local store. Set `NEXUS_ROUTER_DEBUG=1` before `claude-nexus` to log each request's route and status to `~/.claude/nexus/router-<pid>.log`.
```

Bagian **Roadmap** di akhir README:

```markdown
## Roadmap

- **v0.5** (this version): provider router.
- **v0.6**: test-tamper guard, evidence check before "done", `/review-nexus`.
- **v0.7**: hunk-level diff review, plan annotation in the browser.
- Later: Telegram remote control, session search, worktree cockpit.
```

Baris pertama README di bawah judul: `Version 0.5.0.`

- [ ] **Step 2: Versi**

`.claude-plugin/plugin.json`: `"version": "0.5.0"`.

- [ ] **Step 3: Seluruh verifikasi otomatis**

Run: `node --test bridge/` → PASS
Run: `claude plugin test .` → PASS, 0 fail
Run: type-check → exit 0
Run: `claude plugin validate .` → `✔ Validation passed`

- [ ] **Step 4: Bangun ulang zip** (di-ignore git; tanpa `.git`, `node_modules`, `docs`)

Run (PowerShell):

```powershell
Remove-Item nexus-mod.zip -ErrorAction SilentlyContinue
Compress-Archive -Path .claude-plugin, bin, bridge, hooks, types, tests, README.md, tsconfig.json -DestinationPath nexus-mod.zip
```

Expected: `nexus-mod.zip` berisi `bin/claude-nexus.cmd`, `bridge/router.mjs`, `hooks/provider.ts`, dan `.claude-plugin/plugin.json` versi `0.5.0` (cek: `Expand-Archive` ke folder sementara lalu baca `plugin.json`).

- [ ] **Step 5: Uji langsung dengan hub pengguna** (manual, catat hasil di pesan commit)

Key dibaca dari `~/.nexus-spike-key` lewat pane (tempel sekali saat Add profile), bukan dari chat.

1. `set NEXUS_ROUTER_DEBUG=1` lalu `bin\claude-nexus.cmd`. Kirim satu prompt. Expected: jawaban normal, HUD menampilkan kuota 5h/Wk, log berisi `POST /v1/messages?beta=true -> claude 200` dan baris `unified 200 anthropic-ratelimit-unified-…` (catat nama header persisnya; bila nama status/reset/claim berbeda dari Task 1, perbaiki `planLimit` + tesnya dulu).
2. `/provider-nexus` → Add profile `myhub` (`https://hub.example.com/v1`, model `antigravity/gemini-3.8-flash-tiered`, 1000000, Yes default) → Test → ✓.
3. Use myhub; minta Claude menjalankan `echo hub-ok` lewat Bash. Expected: HUD `⇄ myhub · …`, tool berjalan, log `-> hub:myhub 200`.
4. `/provider-nexus use claude`; kirim prompt lanjutan yang merujuk hasil turn hub. Expected: Claude menjawab (bila ada penolakan tanda tangan thinking, Claude Code mengulang sendiri; tidak ada error yang sampai ke pengguna).
5. Jalankan subagent kecil di rute hub (mis. minta Explore singkat). Expected: log menunjukkan permintaan subagent juga `-> hub:myhub` (bukti `ANTHROPIC_CUSTOM_HEADERS` terkirim di permintaan subagent).
6. Dari Bash di sesi itu: `echo %NEXUS_ROUTER_TOKEN%` (Windows) → kosong.

- [ ] **Step 6: Commit**

```bash
git add README.md .claude-plugin/plugin.json
git commit -m "v0.5.0: provider router (claude-nexus, /provider-nexus, fallback on plan limits)"
```

---

## Self-review (dijalankan saat menulis rencana)

- **Cakupan spec:** §3.1 → Task 3; §3.2–3.4 → Task 1–2; §4.1 → Task 4; §4.2 → Task 6; §4.3 → Task 5; §5.1 → Task 5 (`useRoute`, compaction 80%/85%); §5.2 → Task 2 (penahanan) + Task 7; §5.3 → Task 7; §5.4 → Task 7; §5.5 → Task 8 Step 5.5; §6 → Task 1 (header), 2 (Host/token), 3 (dua token), 5 (pengosongan env); §7 → Task 2 (502/503) + Task 7 (toast); §8 → Task 1–8; §9 risiko 1–5 → Task 8 Step 5 (1: langkah 3; 2: langkah 4; 3: langkah 5; 4: langkah 3; 5: langkah 1).
- **Placeholder:** tidak ada TBD/TODO; dua catatan pelaksana (Task 5, 6) menyebut pola pengganti yang konkret bila API harness tes berbeda.
- **Konsistensi nama:** `startRouter`, `routerCall`, `ensureRouterLink`, `useRoute`, `loadProfiles`, `saveProfiles`, `fallbackChoices`, `handleRouterEvent`, `watchRouter`, header `x-nexus-router`/`x-nexus-control`, aksi keputusan `retry`/`release` dipakai sama di semua task.
