// Finds the page's own code for canvases the capture couldn't watch: WebGL drawn from a Web Worker
// (OffscreenCanvas), WebGL that started before the probe, and 2D canvases. Their pixels are only a
// snapshot, but the code that draws them ships in the page's scripts, so the rebuild can port the
// original instead of guessing.
//
// Two signals pick the scripts: GLSL in string literals (the shaders, often in pieces the code
// concatenates), and the exact class string of the canvas or one of its containers (bundlers keep
// className strings as written, which points at the component that renders the canvas).
import { label } from '../shared/dom'
import type { Capture, CodeRef } from '../shared/types'

const MAX_SCRIPTS = 80
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024
const MAX_FILES = 4
const FETCH_TIMEOUT_MS = 10_000
const CONCURRENCY = 6
const EXCERPT_CHARS = 1500 // on each side of the component match
const MAX_SHADERS_PER_FILE = 24
const ANCESTORS = 4

// Words that only GLSL uses; a literal with several of them is shader code, not JavaScript.
const GLSL_WORDS = /\b(vec[234]|ivec[234]|mat[234]|uniform|varying|attribute|precision|gl_FragColor|gl_Position|gl_FragCoord|smoothstep|texture2D|texture|fract|sampler2D|highp|mediump|lowp|void main)\b/g
const LITERALS = [/`(?:[^`\\]|\\[\s\S])*`/g, /"(?:[^"\\\n]|\\.){60,}"/g, /'(?:[^'\\\n]|\\.){60,}'/g]

// GLSL string literals in a script, unescaped, in source order.
export function extractShaders(text: string): string[] {
  const found: { at: number; code: string }[] = []
  for (const re of LITERALS) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const raw = m[0]
      const words = new Set(raw.match(GLSL_WORDS) ?? [])
      if (raw.length < 40 || words.size < 3) continue
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

export async function findCanvasCode(root: Element, capture: Capture): Promise<CodeRef[]> {
  const rt = capture.runtime
  const read = new Set([...(rt?.three ?? []), ...(rt?.webgl.filter((g) => g.programs.length) ?? [])].map((g) => g.target))
  const canvases = [root, ...Array.from(root.querySelectorAll('canvas'))].filter((el): el is HTMLCanvasElement => el instanceof HTMLCanvasElement && !read.has(label(el)))
  if (!canvases.length) return []
  const anchors = canvases.map((c) => ({ canvas: label(c), classes: anchorsFor(c) }))

  const found: CodeRef[] = []
  const queue = scriptUrls(capture)
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const text = await fetchScript(url)
      if (!text) continue
      const shaders = extractShaders(text).slice(0, MAX_SHADERS_PER_FILE)
      const reasons: string[] = []
      let match: { at: number; length: number } | undefined
      for (const { canvas, classes } of anchors) {
        const hit = classes.find((cls) => text.includes(`"${cls}"`) || text.includes(`'${cls}'`) || text.includes(`\`${cls}\``))
        if (!hit) continue
        reasons.push(`renders \`${canvas}\` (holds the exact class string of its container: \`${hit}\`)`)
        const at = text.indexOf(hit)
        if (!match) match = { at, length: hit.length }
      }
      if (shaders.length) reasons.push(`${shaders.length} GLSL shader piece${shaders.length === 1 ? '' : 's'}`)
      if (!reasons.length) continue
      const excerpt = match ? text.slice(Math.max(0, match.at - EXCERPT_CHARS), match.at + match.length + EXCERPT_CHARS) : undefined
      found.push({ url, reasons, shaders, excerpt, size: text.length, text })
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  // When the component was found, only the scripts that render this section's canvases (shaders
  // elsewhere on the page belong to other canvases). Otherwise every script with shaders, the most first.
  const anchored = found.filter((f) => f.excerpt)
  const shaderChars = (f: CodeRef) => f.shaders.reduce((n, s) => n + s.length, 0)
  const picked = anchored.length ? anchored : found
  return picked.sort((a, b) => shaderChars(b) - shaderChars(a)).slice(0, MAX_FILES)
}
