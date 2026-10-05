// Serves the extension folder so test/runtime.html can load dist/probe.js: node test/serve.mjs
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([\\/])+/, '')
  try {
    const body = await readFile(join(root, path || 'test/runtime.html'))
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(body)
  } catch {
    res.writeHead(404).end()
  }
}).listen(5178, '127.0.0.1', () => console.log('http://127.0.0.1:5178/test/runtime.html'))
