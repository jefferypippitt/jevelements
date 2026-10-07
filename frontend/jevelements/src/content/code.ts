// Finds the page's own code for canvases the capture couldn't watch: WebGL or WebGPU drawn from a Web
// Worker (OffscreenCanvas), contexts that started before the probe, and 2D canvases. Their pixels are
// only a snapshot, but the code that draws them ships in the page's scripts, so the rebuild can port
// the original instead of guessing.
//
// Two signals pick the scripts: shader code in string literals (GLSL or WGSL, often in pieces the code
// concatenates), and the exact class string of the canvas or one of its containers (bundlers keep
// className strings as written, which points at the component that renders the canvas).
//
// The component often only bridges to its shaders: they live in a lazy chunk (a dynamic import, a
// webpack chunk loaded with __webpack_require__.e) or in a worker's own chunks, which never show up in
// the page's resource log. So the chunks those scripts load are followed too, a few levels deep.
import { label } from '../shared/dom'
import { isWgsl } from '../shared/shader'
import type { Capture, CodeRef } from '../shared/types'

const MAX_SCRIPTS = 80
const MAX_FOLLOWED = 40 // chunks fetched beyond the page's own script list
const FOLLOW_DEPTH = 3
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024
const MAX_FILES = 6
const FETCH_TIMEOUT_MS = 10_000
const CONCURRENCY = 6
const EXCERPT_CHARS = 1500 // on each side of the component match
const MAX_SHADERS_PER_FILE = 24
const ANCESTORS = 4

// Words that only shader languages use; a literal with several of them is shader code, not JavaScript.
const GLSL_WORDS = /\b(vec[234]|ivec[234]|mat[234]|uniform|varying|attribute|precision|gl_FragColor|gl_Position|gl_FragCoord|smoothstep|texture2D|texture|fract|sampler2D|highp|mediump|lowp|void main)\b/g
const WGSL_WORDS = /@(?:fragment|vertex|compute|group|binding|location|builtin|workgroup_size)\b|\b(?:vec[234][fiuh]|mat[234]x[234]f|var<(?:uniform|storage|private|workgroup)|textureSample\w*|texture_2d|smoothstep|fract)\b|\bfn \w+\s*\(/g
const LITERALS = [/`(?:[^`\\]|\\[\s\S])*`/g, /"(?:[^"\\\n]|\\.){60,}"/g, /'(?:[^'\\\n]|\\.){60,}'/g]
// Code that sets up a GPU context: worth following its chunks even without the component's classes.
const GPU_SETUP = /getContext\(\s*["'`](?:webgl2?|experimental-webgl|webgpu)["'`]|transferControlToOffscreen|requestAdapter\(|createShaderModule\(|new\s+Worker\(/

function shaderWords(raw: string): number {
  return Math.max(new Set(raw.match(GLSL_WORDS) ?? []).size, new Set(raw.match(WGSL_WORDS) ?? []).size)
}

// GLSL and WGSL string literals in a script, unescaped, in source order.
export function extractShaders(text: string): string[] {
  const found: { at: number; code: string }[] = []
  for (const re of LITERALS) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const raw = m[0]
      if (raw.length < 40 || shaderWords(raw) < 3) continue
      const body = raw.slice(1, -1)
      const code = raw[0] === '`' ? body : body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["'\\])/g, '$1')
      found.push({ at: m.index, code: code.replace(/\\u00b7/g, '·').replace(/\\xb7/g, '·').trim() })
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.code)
}

// Class strings around a canvas that are specific enough to find its component by.
function anchorsFor(canvas: Element): string[] {
  const out: string[] = []
  for (let el: Element | null = canvas, depth = 0; el && depth <= ANCESTORS; el = el.parentElement, depth++) {
    const cls = el.getAttribute('class')?.trim().replace(/\s+/g, ' ')
    if (cls && cls.length >= 16 && cls.includes(' ')) out.push(cls)
  }
  return out
}

function scriptUrls(capture: Capture): string[] {
  const urls = [
    ...(capture.runtime?.workers ?? []),
    ...performance.getEntriesByType('resource').filter((e) => (e as PerformanceResourceTiming).initiatorType === 'script').map((e) => e.name),
    ...Array.from(document.scripts, (s) => s.src),
  ]
  return Array.from(new Set(urls.filter((u) => /^https?:/.test(u)))).slice(0, MAX_SCRIPTS)
}

async function fetchScript(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: 'force-cache', credentials: 'same-origin', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok || /text\/html/.test(res.headers.get('content-type') ?? '')) return null
    const text = await res.text()
    return text.length <= MAX_SCRIPT_BYTES ? text : null
  } catch {
    return null // cross-origin without CORS
  }
}

// ---------- chunks a script loads ----------

// webpack's chunk-file function (__webpack_require__.u), e.g.
//   d.u=e=>"static/chunks/"+(({12:"three"})[e]||e)+"."+({12:"a1b2",34:"c3d4"})[e]+".js"
// read as a list of parts so a chunk id can be turned into its file name without running the code.
type UrlPart = { text: string } | { map: Record<string, string>; orId: boolean } | { id: true }
interface ChunkRuntime {
  parts: UrlPart[]
  base: string // webpack's public path, resolved
}

const OBJECT_MAP = /^\(*\{((?:\s*"?[\w$-]+"?\s*:\s*"[^"]*"\s*,?)*)\}\)*\s*\[\s*\w+\s*\]\s*\)*/

function readMap(body: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const m of body.matchAll(/"?([\w$-]+)"?\s*:\s*"([^"]*)"/g)) map[m[1]] = m[2]
  return map
}

function chunkRuntime(text: string, url: string): ChunkRuntime | null {
  const head = /\.u\s*=\s*(?:function\s*\(\s*(\w+)\s*\)\s*\{\s*return\s*|\(?\s*(\w+)\s*\)?\s*=>\s*)/.exec(text)
  if (!head) return null
  const param = head[1] ?? head[2]
  let rest = text.slice(head.index + head[0].length, head.index + head[0].length + 200_000)
  const parts: UrlPart[] = []
  for (let guard = 0; guard < 20 && rest; guard++) {
    rest = rest.replace(/^[\s(+]+/, '')
    const str = /^"([^"]*)"/.exec(rest)
    const map = OBJECT_MAP.exec(rest)
    if (str) {
      parts.push({ text: str[1] })
      rest = rest.slice(str[0].length)
      if (/\.m?js$/.test(str[1])) break
    } else if (map) {
      rest = rest.slice(map[0].length)
      const orId = new RegExp(`^\\s*\\|\\|\\s*${param}\\b\\)*`).exec(rest)
      if (orId) rest = rest.slice(orId[0].length)
      parts.push({ map: readMap(map[1]), orId: !!orId })
    } else if (new RegExp(`^${param}\\b`).test(rest)) {
      parts.push({ id: true })
      rest = rest.slice(param.length)
    } else break
  }
  const last = parts[parts.length - 1]
  if (!last || !('text' in last) || !/\.m?js$/.test(last.text) || !parts.some((p) => 'id' in p || 'map' in p)) return null
  const publicPath = /\.p\s*=\s*"([^"]*)"/.exec(text)?.[1]
  let base: string
  if (publicPath) base = new URL(publicPath, location.href).href
  else {
    // "auto" public path: the folder above the chunk folder the runtime script itself sits in.
    const first = parts[0]
    const dir = 'text' in first ? first.text.replace(/[^/]*$/, '') : ''
    const at = dir ? url.indexOf(dir) : -1
    base = at > 0 ? url.slice(0, at) : url.replace(/[^/]*$/, '')
  }
  return { parts, base }
}

function chunkFile(rt: ChunkRuntime, id: string): string | null {
  let out = ''
  for (const p of rt.parts) {
    if ('text' in p) out += p.text
    else if ('id' in p) out += id
    else if (p.map[id] !== undefined) out += p.map[id]
    else if (p.orId) out += id
    else return null // a chunk this runtime doesn't know
  }
  try {
    return new URL(out, rt.base).href
  } catch {
    return null
  }
}

// Chunk ids this script loads (__webpack_require__.e(id), or .u(id) for a worker's own file), and the
// files it imports directly (ES modules, Vite's preload lists, workers, importScripts).
function references(text: string, url: string): { ids: string[]; urls: string[] } {
  const ids = new Set<string>()
  for (const m of text.matchAll(/\.[eu]\(\s*(?:(\d+)|"([\w$/.-]+)")\s*\)/g)) ids.add(m[1] ?? m[2])
  const urls = new Set<string>()
  const add = (spec: string) => {
    try {
      const resolved = new URL(spec, spec.startsWith('.') ? url : document.baseURI).href
      if (/^https?:/.test(resolved)) urls.add(resolved)
    } catch {
      // not a path
    }
  }
  const PATTERNS = [
    /\bimport\s*\(\s*["'`]([^"'`]+\.m?js)(?:\?[^"'`]*)?["'`]\s*\)/g,
    /\b(?:from|import)\s*["'`]([^"'`]+\.m?js)["'`]/g,
    /\bnew\s+URL\(\s*["'`]([^"'`]+\.m?js)["'`]\s*,\s*import\.meta\.url/g,
    /\bnew\s+(?:Shared)?Worker\(\s*["'`]([^"'`]+\.m?js)["'`]/g,
    /\bimportScripts\(\s*["'`]([^"'`]+\.m?js)["'`]/g,
  ]
  for (const re of PATTERNS) for (const m of text.matchAll(re)) add(m[1])
  // Vite: __vite__mapDeps lists the chunks each dynamic import preloads, relative to the site's base.
  for (const m of text.matchAll(/__vite__mapDeps\.viteFileDeps\s*=\s*\[([^\]]*)\]|\bm\.f\s*\|\|\s*\(\s*m\.f\s*=\s*\[([^\]]*)\]/g)) {
    for (const s of (m[1] ?? m[2]).matchAll(/"([^"]+\.m?js)"/g)) add(s[1])
  }
  return { ids: Array.from(ids), urls: Array.from(urls) }
}

function samePath(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname === y.pathname
  } catch {
    return a === b
  }
}

function shortName(url: string): string {
  try {
    return new URL(url).pathname.split('/').pop() || url
  } catch {
    return url
  }
}

// ---------- the search ----------

interface Script {
  url: string
  text: string
  shaders: string[]
  hits: { canvas: string; cls: string; at: number }[]
  runtime: ChunkRuntime | null
  from?: string // the script that loads it, once chunks are followed
  depth: number
}

export async function findCanvasCode(root: Element, capture: Capture): Promise<CodeRef[]> {
  const rt = capture.runtime
  const read = new Set([...(rt?.three ?? []), ...(rt?.webgl.filter((g) => g.programs.length || g.wgsl?.length) ?? [])].map((g) => g.target))
  const canvases = [root, ...Array.from(root.querySelectorAll('canvas'))].filter((el): el is HTMLCanvasElement => el instanceof HTMLCanvasElement && !read.has(label(el)))
  if (!canvases.length) return []
  const anchors = canvases.map((c) => ({ canvas: label(c), classes: anchorsFor(c) }))
  const workers = new Set(rt?.workers ?? [])

  const scripts: Script[] = []
  const failed = new Map<string, string>() // chunk URL → the script that loads it
  const seen = new Set<string>()
  const queue: { url: string; from?: string; depth: number }[] = scriptUrls(capture).map((url) => ({ url, depth: 0 }))
  queue.forEach((q) => seen.add(q.url))

  const load = async ({ url, from, depth }: { url: string; from?: string; depth: number }) => {
    const text = await fetchScript(url)
    if (!text) {
      if (from) failed.set(url, from)
      return
    }
    const hits: Script['hits'] = []
    for (const { canvas, classes } of anchors) {
      const cls = classes.find((c) => text.includes(`"${c}"`) || text.includes(`'${c}'`) || text.includes(`\`${c}\``))
      if (cls) hits.push({ canvas, cls, at: text.indexOf(cls) })
    }
    scripts.push({ url, text, shaders: extractShaders(text).slice(0, MAX_SHADERS_PER_FILE), hits, runtime: chunkRuntime(text, url), from, depth })
  }
  const drain = async () => {
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await load(next)
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  }
  await drain()

  // Follow what the interesting scripts load: the component's script, worker scripts, chunks already
  // followed, and code that sets up a GPU context. A chunk id resolves through the runtime in the same
  // file first (a worker bundles its own), then through any runtime on the page that knows the id.
  let followed = 0
  for (let depth = 0; depth < FOLLOW_DEPTH; depth++) {
    const runtimes = scripts.flatMap((s) => (s.runtime ? [s.runtime] : []))
    // The component's scripts and workers spend the fetch budget first; a big library bundle last.
    const priority = (x: Script) => (x.hits.length ? 0 : workers.has(x.url) ? 1 : x.from ? 2 : 3)
    for (const s of scripts.filter((x) => x.depth === depth).sort((a, b) => priority(a) - priority(b))) {
      if (priority(s) === 3 && !GPU_SETUP.test(s.text)) continue
      const refs = references(s.text, s.url)
      const targets = [...refs.urls]
      for (const id of refs.ids) {
        const file = (s.runtime && chunkFile(s.runtime, id)) ?? runtimes.map((r) => chunkFile(r, id)).find((f): f is string => !!f)
        if (file) targets.push(file)
      }
      for (const url of targets) {
        if (samePath(url, s.url)) continue
        const known = scripts.find((x) => samePath(x.url, url))
        if (known) {
          // Already on the page's list (the bug this fixes: it was found, then dropped as unrelated).
          if (!known.from && !known.hits.length) known.from = s.url
          continue
        }
        if (seen.has(url) || followed >= MAX_FOLLOWED) continue
        seen.add(url)
        followed++
        queue.push({ url, from: s.url, depth: depth + 1 })
      }
    }
    if (!queue.length) break
    await drain()
  }

  // Which scripts are this section's: the ones holding its canvases' classes, and the chunks they (or
  // the page's workers) load that hold shaders or set up the context. When nothing ties shader code to
  // the section, every script with shaders, the most first, since one of them draws these canvases.
  const byUrl = new Map(scripts.map((s) => [s.url, s]))
  const anchored = new Set(scripts.filter((s) => s.hits.length).map((s) => s.url))
  const tied = (s: Script): boolean => {
    for (let at: Script | undefined = s, i = 0; at && i < 8; at = at.from ? byUrl.get(at.from) : undefined, i++) {
      if (anchored.has(at.url) || workers.has(at.url)) return true
    }
    return false
  }
  const drawsGpu = (s: Script) => s.shaders.length > 0 || GPU_SETUP.test(s.text)
  const shaderChars = (s: Script) => s.shaders.reduce((n, c) => n + c.length, 0)
  let picked = scripts.filter((s) => anchored.has(s.url) || (tied(s) && drawsGpu(s)))
  if (!picked.some((s) => s.shaders.length)) picked = [...picked, ...scripts.filter((s) => s.shaders.length && !picked.includes(s))]
  const rank = (s: Script) => (s.shaders.length && tied(s) ? 0 : anchored.has(s.url) ? 1 : s.shaders.length ? 2 : 3)
  picked = picked.sort((a, b) => rank(a) - rank(b) || shaderChars(b) - shaderChars(a)).slice(0, MAX_FILES)

  return picked.map((s) => {
    const reasons: string[] = s.hits.map((h) => `renders \`${h.canvas}\` (holds the exact class string of its container: \`${h.cls}\`)`)
    if (workers.has(s.url)) reasons.push('a Web Worker script the page started')
    if (s.from) reasons.push(`a chunk loaded by \`${shortName(s.from)}\`${anchored.has(s.from) ? ' (the component that renders the canvas)' : ''}`)
    if (s.shaders.length) {
      const wgsl = s.shaders.filter(isWgsl).length
      const glsl = s.shaders.length - wgsl
      const kinds = [glsl ? `${glsl} GLSL` : '', wgsl ? `${wgsl} WGSL` : ''].filter(Boolean).join(' and ')
      reasons.push(`${kinds} shader piece${s.shaders.length === 1 ? '' : 's'}`)
    } else if (GPU_SETUP.test(s.text)) reasons.push('sets up the GPU context')
    if (anchored.size && !tied(s)) reasons.push('not linked to the component that renders the canvas, so it may belong to another canvas on the page')
    const hit = s.hits[0]
    const excerpt = hit ? s.text.slice(Math.max(0, hit.at - EXCERPT_CHARS), hit.at + hit.cls.length + EXCERPT_CHARS) : undefined
    const unreachable = Array.from(failed).filter(([, from]) => from === s.url).map(([url]) => url)
    return { url: s.url, reasons, shaders: s.shaders, excerpt, size: s.text.length, text: s.text, unreachable: unreachable.length ? unreachable : undefined }
  })
}
