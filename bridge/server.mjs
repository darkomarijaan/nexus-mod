// claude-nexus webview bridge: serves preview pages from one folder on
// 127.0.0.1 and relays a pick made in the browser back to the session by
// printing one line on stdout, which the mod reads.
//   NEXUS_PORT <port>          once listening
//   NEXUS_SELECT <json>        per pick
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

const root = normalize(process.argv[2] ?? '.')
const parent = process.ppid
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname === '/select') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 65536) break
    }
    try {
      const data = JSON.parse(body)
      process.stdout.write(`NEXUS_SELECT ${JSON.stringify({ set: String(data.set), option: String(data.option) })}\n`)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    } catch {
      res.writeHead(400).end('bad request')
    }
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/p/')) {
    const file = normalize(join(root, decodeURIComponent(url.pathname.slice(3))))
    if (!file.startsWith(root + sep)) {
      res.writeHead(403).end('forbidden')
      return
    }
    try {
      const data = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(data)
    } catch {
      res.writeHead(404).end('not found')
    }
    return
  }
  res.writeHead(404).end('not found')
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`NEXUS_PORT ${typeof address === 'object' && address ? address.port : 0}\n`)
})

// Leave with the session: stop once the process that started us is gone.
setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    process.exit(0)
  }
}, 5000).unref()
