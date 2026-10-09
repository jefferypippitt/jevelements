// The hover sweep: what a section does under the pointer's position, mapped the way a hand would test
// it. A shader that lights the side of a shape the pointer is near, a spotlight, a cursor follower,
// parallax layers, a fluid or a trail, a tilt card, a magnetic button: the pointer makes one continuous
// stroke left to right through the middle and one top to bottom, without stopping, and at every frame
// of the way the sweep reads:
// - values: for a canvas, the numbers its renderer holds (raw WebGL uniforms, three.js uniforms, camera
//   and object transforms, from the page probe); for the section, its elements' transforms, opacity,
//   background position, SVG geometry and the CSS custom properties a script writes. The ones that
//   follow the pointer are found, with how they map to its position (0–1, clip space, CSS px, clientX…);
// - pixels: a canvas read back itself, or anything cropped from a screenshot of the tab. Compared with
//   how it looks at rest, they map where it reacts and how much.
// Reading while it moves also sees what only shows while the pointer moves (a trail, a fluid, a ripple
// that fades once it stops); values that ease after the pointer are fitted against where it was a
// moment before. Components with their own pointer effect (any element the page probe saw listen for
// the pointer's position, and any whose values only changed while a stroke crossed it) get the same two
// strokes on their own. Then an enter, a jump and a leave are followed frame by frame for the easing,
// and the frames where it reacted most are kept as reference images for the rebuild.
//
// Canvases in the section, or under it from outside (a page-wide background), are always swept (they
// draw their hover in pixels, which nothing else sees). The section itself is swept when the page probe
// saw something listen for the pointer's position (probe/listeners.ts), unless a canvas fills most of
// it and no component in it listens on its own.
//
// The pointer is a virtual one: the over/enter/move/out/leave sequences a real mouse sends, on whatever
// element is under it (an overlay above the canvas gets them, as it would for a user), bubbling up to
// window, where most effects listen. While it runs, the user's own mouse moves are kept from the page
// so they can't pull the effect elsewhere. The trace shows it in green (trace.ts).
import { label } from '../shared/dom'
import { fromBase64 } from '../shared/files'
import { PROBE_CLICK_ATTR, PROBE_INTERACTIVE_ATTR, PROBE_POINTER_ATTR, PROBE_VALUES_EVENT, PROBE_VALUES_RESULT_EVENT } from '../shared/runtime'
import type { ClickSweep, HoverSweep, HoverSweepFrame } from '../shared/types'
import { allIn, blockedDestination, blockedWrites, blockWrites, containsDeep, escape, goesTo, guard, nextFrame, parentOf, visible, wait, type Destination } from './play'
import type { TraceFocus } from './trace'

const MAX_CANVASES = 3
const MAX_STYLED = 400 // elements of the section whose styles are read at every point
const MAX_LOCAL = 5 // elements swept again on their own (tilt cards, magnetic buttons)
const MIN_PART = 40 // px: smaller elements that listen for the pointer are icons, not components
const LOCAL_STROKE_MS = 1100 // one stroke across one of them
const LOCAL_INSET = 0.08
const LOCAL_WATCH_MS = 1000
const CANVAS_COVERS = 0.7 // a canvas this much of the section is the section's hover: it isn't swept twice
const MIN_W = 80 // px: smaller canvases are icons, not scenes
const MIN_H = 60
// A stroke goes at about a hand's speed, the same in both directions (a trail or a fluid reacts to
// speed), within these bounds; read in screenshots (two a second) it goes slower, for enough of them.
const STROKE_PX_PER_S = 650
const STROKE_MS = { min: 900, max: 2400, screen: 5000 }
const STROKE_INSET = 0.03 // strokes run from 3% to 97% of the way: the pointer stays over it between them
const MAX_LAG_S = 0.5 // how far an eased value may trail the moving pointer
const LAG_STEP_S = 1 / 60
const MAP_BINS = 32 // characters in each strip of the map
const BUDGET_MS = 35_000 // per canvas or section
const TOTAL_MS = 70_000
const REST_MS = 900 // after parking the pointer, before the rest reading (eased values settle back)
const NOISE_GAP_MS = 300 // between the readings at rest
const REST_FRAMES = 6 // readings at rest, for the range the canvas has by itself (1.5 s with the gaps)
const REST_SHOTS = 4 // the same with screenshots, which are slower
const HOLD_MIN_MS = 120
const HOLD_MAX_MS = 900
const HOLD_BLIND_MS = 450 // at the start of a stroke when there are no values to watch settle
const STILL_FRAMES = 3 // frames in a row without change that count as settled
const SHOT_GAP_MS = 550 // chrome.tabs.captureVisibleTab allows two calls a second
const WATCH_MS = 1500 // an enter, a jump or a leave, followed frame by frame
const TRAVEL_STEPS = 5 // moves (one per frame) between two points, so the pointer has a velocity
const SMALL = 64 // px: the longer side of the pixels that are compared
const FRAME_MAX = 960 // px: the longer side of the reference frames
const FRAMES = 3 // hover frames kept per sweep, besides the one at rest
const CHANGED = 24 // a channel difference (of 255) that counts a pixel as changed
const NEAR = 0.08 // the pointer's surroundings, as a fraction of the longer side of the pixels
const MIN_CHANGE = 0.003 // mean pixel difference below this is not a reaction
const LINEAR_R2 = 0.85
const MAX_LINES = 14

export type Shoot = (rect: { x: number; y: number; w: number; h: number }) => Promise<string | undefined>

export interface SweepOptions {
  shoot?: Shoot // a screenshot of a viewport rect (CSS px), with the inspector's marks over it hidden
  // Where the inspector's drawer starts (viewport px from the left). It stays on screen while the
  // sweeps run, so screenshots stop at its edge: what's under it is swept, but not read in pixels.
  drawerEdge?: () => number
  onProgress?: (text: string) => void
  onFocus?: (focus: TraceFocus | null) => void
  signal?: AbortSignal // the capture was stopped: end the sweep as if out of time
}

export interface SweepResult {
  swept: number // canvases and sections the pointer was swept over
  hovers: HoverSweep[] // the ones that reacted
}

type Values = Map<string, number[]>

interface Pixels {
  w: number
  h: number
  data: Uint8ClampedArray
}

interface Point {
  x: number // fractions of the swept box, from its top-left
  y: number
}

// The values, read as the pointer moves.
interface Sample extends Point {
  t: number // seconds since this sweep started
  values: Values
}

// The pixels, read as the pointer moves.
interface Hit extends Point {
  t: number
  axis: 'x' | 'y' // the stroke: left to right, or top to bottom
  score: number | null // how much the pixels changed against the rest reading, above the noise (clickScore)
  change: Change | null
  shift: number | null // how much the whole box got brighter (+) or darker (−) than at rest, 0–1
}

interface Change {
  mean: number // 0–1
  near?: number // 0–1: the mean change around the pointer, when `compare` was told where it is
  box: [number, number, number, number] | null // x0, y0, x1, y1 of the changed pixels, fractions of the box
  area: number // fraction of the pixels that changed
}

interface Reading {
  pixels: Pixels
  frame: () => string | undefined // a reference JPEG of this same moment; call it right away
}

interface Reader {
  mode: 'canvas' | 'screen'
  read(): Promise<Reading | null>
  now(): Pixels | null // without waiting: canvas read-back only, for frame-by-frame watching
  snap?: () => string | undefined // a reference JPEG of it right now: canvas read-back only
}

// The part of the box the pixels cover (screenshots only see what's on screen).
interface View {
  x0: number
  x1: number
  y0: number
  y1: number
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const pct = (f: number) => `${Math.round(f * 100)}%`
const pos = (p: Point) => `${pct(p.x)} across, ${pct(p.y)} down`
const now = () => performance.now()

function fmt(n: number): string {
  const digits = Math.abs(n) >= 100 ? 1 : Math.abs(n) >= 1 ? 2 : 3
  const f = 10 ** digits
  const r = Math.round(n * f) / f
  return Object.is(r, -0) ? '0' : String(r)
}

// ---------- reading the renderer's values (from the page probe) ----------

function readValues(canvas: HTMLCanvasElement): Values {
  let out: Values = new Map()
  const onResult = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail
    if (typeof detail !== 'string') return
    try {
      const parsed = JSON.parse(detail) as Record<string, unknown>
      out = new Map(
        Object.entries(parsed).filter((entry): entry is [string, number[]] => Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].every((n) => typeof n === 'number' && Number.isFinite(n))),
      )
    } catch {
      // not ours
    }
  }
  document.addEventListener(PROBE_VALUES_RESULT_EVENT, onResult)
  try {
    canvas.dispatchEvent(new CustomEvent(PROBE_VALUES_EVENT, { bubbles: true, composed: true }))
  } finally {
    document.removeEventListener(PROBE_VALUES_RESULT_EVENT, onResult)
  }
  return out
}

// ---------- reading the section's values (its elements' styles) ----------

const SVG_ATTRS = ['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'fx', 'fy', 'offset']

function numbers(text: string): number[] | null {
  const found = text.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)
  return found ? found.slice(0, 4).map(Number) : null
}

// What a script that follows the pointer writes: transforms (a follower, parallax, a tilt), opacity
// and background position (a spotlight), SVG geometry, any style it sets inline, and the custom
// properties set inline (`--x`, `--mouse-x`, often on <html> or the section, then used by its CSS).
// Labels are made unique, so two `div.card` are `div.card` and `div.card (2)`.
interface StyleReader {
  (): Values
  owners: Map<string, Element> // which element each value was read from
}

function styleReader(root: Element): StyleReader {
  const els = Array.from(new Set([document.documentElement, document.body, root, ...allIn(root, MAX_STYLED)])).filter((el): el is Element => !!el)
  const seen = new Map<string, number>()
  const names = els.map((el) => {
    const base = label(el)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n > 1 ? `${base} (${n})` : base
  })
  const owners = new Map<string, Element>()
  const read = () => {
    const out: Values = new Map()
    els.forEach((el, i) => {
      if (!el.isConnected) return
      const name = names[i]
      const inline = (el as HTMLElement).style as CSSStyleDeclaration | undefined
      for (let k = 0; inline && k < inline.length; k++) {
        const prop = inline[k]
        // Custom properties by name; any other style a script writes inline (left, a gradient's
        // position, a filter) by its numbers. Transforms are read decomposed below.
        if (prop === 'transform') continue
        const v = numbers(inline.getPropertyValue(prop))
        if (v) out.set(prop.startsWith('--') ? `${name} ${prop}` : `${name} style ${prop}`, v)
      }
      if (el === document.documentElement || el === document.body) return
      const cs = getComputedStyle(el)
      // Read even when `none` (as the identity): a tilt card is flat until the pointer is over it.
      try {
        const m = new DOMMatrixReadOnly(cs.transform && cs.transform !== 'none' ? cs.transform : undefined)
        out.set(`${name} transform translate (px)`, [m.m41, m.m42])
        // A 3D transform turns in tilt: its 2D rotation and scale would only be that tilt seen flat.
        out.set(`${name} transform rotate (deg)`, [m.is2D ? (Math.atan2(m.m12, m.m11) * 180) / Math.PI : 0])
        out.set(`${name} transform scale`, [m.is2D ? Math.hypot(m.m11, m.m12) : Math.hypot(m.m11, m.m12, m.m13)])
        out.set(`${name} transform tilt rotateX/rotateY (deg)`, [(Math.asin(clamp(m.m23, -1, 1)) * 180) / Math.PI, (-Math.asin(clamp(m.m13, -1, 1)) * 180) / Math.PI])
      } catch {
        // not a matrix DOMMatrix can parse
      }
      const none = { translate: [0, 0], rotate: [0], scale: [1] }
      for (const prop of ['translate', 'rotate', 'scale'] as const) {
        const v = cs[prop]
        if (v === undefined) continue
        const n = v === 'none' ? none[prop] : numbers(v)
        if (n) out.set(`${name} ${prop}`, n)
      }
      out.set(`${name} opacity`, [Number(cs.opacity)])
      if (cs.backgroundImage !== 'none') {
        const n = numbers(cs.backgroundPosition)
        if (n) out.set(`${name} background-position`, n)
      }
      if (el instanceof SVGElement) {
        for (const attr of SVG_ATTRS) {
          const v = el.getAttribute(attr)
          const n = v ? numbers(v) : null
          if (n) out.set(`${name} ${attr}`, n)
        }
      }
    })
    for (const key of out.keys()) if (!owners.has(key)) owners.set(key, els[names.findIndex((n) => key.startsWith(`${n} `))] ?? root)
    return out
  }
  return Object.assign(read, { owners })
}

// ---------- reading the pixels ----------

const small = document.createElement('canvas')

function drawSmall(source: CanvasImageSource, sw: number, sh: number): Pixels | null {
  if (!sw || !sh) return null
  const s = SMALL / Math.max(sw, sh)
  const w = Math.max(1, Math.round(sw * s))
  const h = Math.max(1, Math.round(sh * s))
  small.width = w
  small.height = h
  const g = small.getContext('2d', { willReadFrequently: true })
  if (!g) return null
  try {
    // Averaged, not sampled: a thin line or a small glow on a large canvas would fall between samples.
    g.imageSmoothingQuality = 'high'
    g.drawImage(source, 0, 0, w, h)
    return { w, h, data: g.getImageData(0, 0, w, h).data }
  } catch {
    return null // tainted by cross-origin images
  }
}

// Transparent or black everywhere is a WebGL buffer cleared after presenting, not a drawing. Another
// single color is a real one (a 2D canvas filled with its background until the pointer comes).
function blank(p: Pixels): boolean {
  const d = new Uint32Array(p.data.buffer, p.data.byteOffset, p.w * p.h)
  if (!d.every((v) => v === d[0])) return false
  const [r, g, b, a] = p.data
  return a === 0 || (r === 0 && g === 0 && b === 0)
}

// What shows behind a transparent canvas, so its frames don't come out black.
function backdrop(el: Element): string {
  for (let node: Element | null = el; node; node = parentOf(node)) {
    const bg = getComputedStyle(node).backgroundColor
    if (bg && !/rgba\(.*,\s*0\)$|transparent/.test(bg)) return bg
  }
  return '#fff'
}

function jpeg(source: CanvasImageSource, sw: number, sh: number, background: string): string | undefined {
  if (!sw || !sh) return undefined
  const s = Math.min(1, FRAME_MAX / Math.max(sw, sh))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(sw * s))
  c.height = Math.max(1, Math.round(sh * s))
  const g = c.getContext('2d')
  if (!g) return undefined
  try {
    g.fillStyle = background
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(source, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.85)
  } catch {
    return undefined
  }
}

// The canvas's own pixels, read inside the frame right after the page drew it, which works even when
// WebGL clears its buffer after presenting (preserveDrawingBuffer: false). `dark`: black or empty is a
// real look too (a trail that fades to black once the pointer stops), not a cleared buffer.
function canvasReader(canvas: HTMLCanvasElement, dark = false): Reader {
  const background = backdrop(canvas)
  const now = () => {
    const p = drawSmall(canvas, canvas.width, canvas.height)
    return p && (dark || !blank(p)) ? p : null
  }
  return {
    mode: 'canvas',
    now,
    snap: () => jpeg(canvas, canvas.width, canvas.height, background),
    async read() {
      // A page that only draws when something changes may leave the buffer empty on some frames.
      for (let tries = 0; tries < 3; tries++) {
        await nextFrame()
        const pixels = now()
        if (pixels) return { pixels, frame: () => jpeg(canvas, canvas.width, canvas.height, background) }
      }
      return null
    },
  }
}

// Decoded by hand: fetch(dataUrl) is blocked on pages whose CSP leaves data: out of connect-src.
function dataUrlBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png'
  return new Blob([fromBase64(dataUrl.slice(comma + 1))], { type: mime })
}

// The part of r inside the viewport, and left of `right` (the drawer's edge, for screenshots).
function onScreen(r: DOMRect, right = window.innerWidth): { x: number; y: number; w: number; h: number } | null {
  const x = Math.max(0, r.left)
  const y = Math.max(0, r.top)
  const w = Math.min(window.innerWidth, right, r.right) - x
  const h = Math.min(window.innerHeight, r.bottom) - y
  return w > 4 && h > 4 ? { x, y, w, h } : null
}

// The box cropped from screenshots of the tab: slow (two a second), but it sees whatever is on screen.
function screenReader(el: Element, shoot: Shoot, right: number): Reader {
  let last = 0
  return {
    mode: 'screen',
    now: () => null,
    async read() {
      const gap = SHOT_GAP_MS - (now() - last)
      if (gap > 0) await wait(gap)
      const rect = onScreen(el.getBoundingClientRect(), right)
      if (!rect) return null
      last = now()
      const url = await shoot(rect)
      if (!url) return null
      try {
        const bitmap = await createImageBitmap(dataUrlBlob(url))
        const pixels = drawSmall(bitmap, bitmap.width, bitmap.height)
        return pixels ? { pixels, frame: () => jpeg(bitmap, bitmap.width, bitmap.height, '#000') } : null
      } catch {
        return null
      }
    },
  }
}

async function pickReader(el: Element, shoot: Shoot | undefined, right: number): Promise<Reader | null> {
  if (el instanceof HTMLCanvasElement) {
    const own = canvasReader(el)
    if (await own.read()) return own
  }
  if (shoot) {
    const screen = screenReader(el, shoot, right)
    if (await screen.read()) return screen
  }
  // Black or empty in every frame, with no screenshot to tell: read it back anyway (a 2D canvas that
  // is black until the pointer draws on it; a cleared WebGL buffer just reads as no reaction).
  if (el instanceof HTMLCanvasElement) {
    const dark = canvasReader(el, true)
    if (await dark.read()) return dark
  }
  return null
}

// How much `b` differs from `a`, how much of it changed, and where the strongest change is (the pixels
// that changed at least half as much as the most changed one: the side of a shape that lit up, not
// the faint glow everywhere else). With `at` (the pointer, in fractions of the box), also how much
// changed around it.
function compare(a: Pixels, b: Pixels, view: View, at?: Point): Change | null {
  if (a.w !== b.w || a.h !== b.h) return null
  const n = a.w * a.h
  const diffs = new Uint8Array(n)
  let sum = 0
  let changed = 0
  let peak = 0
  for (let p = 0; p < n; p++) {
    const i = p * 4
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]))
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])
    diffs[p] = d
    if (d >= CHANGED) changed++
    peak = Math.max(peak, d)
  }
  let box: Change['box'] = null
  if (changed) {
    const strong = Math.max(CHANGED, peak / 2)
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let p = 0; p < n; p++) {
      if (diffs[p] < strong) continue
      const x = p % a.w
      const y = Math.floor(p / a.w)
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x + 1)
      y1 = Math.max(y1, y + 1)
    }
    const fx = (px: number) => view.x0 + (px / a.w) * (view.x1 - view.x0)
    const fy = (px: number) => view.y0 + (px / a.h) * (view.y1 - view.y0)
    box = [fx(x0), fy(y0), fx(x1), fy(y1)]
  }
  let near: number | undefined
  if (at) {
    const cx = Math.round(((at.x - view.x0) / (view.x1 - view.x0)) * a.w)
    const cy = Math.round(((at.y - view.y0) / (view.y1 - view.y0)) * a.h)
    const r = Math.max(2, Math.round(NEAR * Math.max(a.w, a.h)))
    let total = 0
    let count = 0
    for (let y = Math.max(0, cy - r); y < Math.min(a.h, cy + r + 1); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(a.w, cx + r + 1); x++) {
        total += diffs[y * a.w + x]
        count++
      }
    }
    near = count ? total / (count * 255) : 0
  }
  return { mean: sum / (n * 3 * 255), area: changed / n, box, near }
}

// How much the pointer or a click changed the pixels: their mean change, or the share of them that
// changed clearly, over four (a glow around the pointer, a thin ring or a small burst changes few
// pixels a lot, which the mean over a large canvas hides).
const clickScore = (c: Change | null) => (c ? Math.max(c.mean, c.area / 4) : 0)

// The same, with what changed around the pointer too: a trail, a glow or a burst at the click on a
// page-wide canvas is a few pixels of a large one.
const nearScore = (c: Change | null) => (c ? Math.max(clickScore(c), (c.near ?? 0) / 2) : 0)

// Each pixel's range over the readings at rest: what the canvas does by itself.
interface Range {
  w: number
  h: number
  lo: Uint8ClampedArray
  hi: Uint8ClampedArray
}

function range(reads: Pixels[]): Range | null {
  const first = reads[0]
  if (!first) return null
  const lo = new Uint8ClampedArray(first.data)
  const hi = new Uint8ClampedArray(first.data)
  for (const p of reads.slice(1)) {
    if (p.w !== first.w || p.h !== first.h) continue
    for (let i = 0; i < p.data.length; i++) {
      lo[i] = Math.min(lo[i], p.data[i])
      hi[i] = Math.max(hi[i], p.data[i])
    }
  }
  return { w: first.w, h: first.h, lo, hi }
}

// `compare` against the rest range: only how far each pixel went beyond what it does by itself. A
// shift of the whole canvas (a slow shimmer, a fade longer than the readings at rest) is taken out
// first, as the median shift of each channel, so what's left is what the pointer changed locally;
// the shift itself is returned for the caller to judge.
function outside(r: Range, p: Pixels, view: View, at?: Point): (Change & { shift: number }) | null {
  if (r.w !== p.w || r.h !== p.h) return null
  const n = p.w * p.h
  const offsets = [0, 1, 2].map((c) => {
    const deltas = new Float32Array(n)
    for (let k = 0; k < n; k++) deltas[k] = p.data[k * 4 + c] - (r.lo[k * 4 + c] + r.hi[k * 4 + c]) / 2
    deltas.sort()
    return deltas[Math.floor(n / 2)]
  })
  const beyond = new Uint8ClampedArray(p.data.length)
  for (let i = 0; i < p.data.length; i++) {
    const c = i & 3
    if (c === 3) continue // alpha
    const v = p.data[i] - offsets[c]
    beyond[i] = v > r.hi[i] ? v - r.hi[i] : v < r.lo[i] ? r.lo[i] - v : 0
  }
  const change = compare({ w: p.w, h: p.h, data: new Uint8ClampedArray(p.data.length) }, { w: p.w, h: p.h, data: beyond }, view, at)
  return change && { ...change, shift: (offsets[0] + offsets[1] + offsets[2]) / (3 * 255) }
}

// ---------- the virtual pointer ----------

// The deepest element under a point, inside open shadow roots too, skipping the inspector's overlay.
function hitAt(x: number, y: number): Element | null {
  let root: Document | ShadowRoot = document
  let hit: Element | null = null
  for (let depth = 0; depth < 8; depth++) {
    const next: Element | undefined = root.elementsFromPoint(x, y).find((el) => el.tagName !== 'JEV-INSPECTOR')
    if (!next || next === hit) break
    hit = next
    if (!next.shadowRoot) break
    root = next.shadowRoot
  }
  return hit
}

function chain(el: Element | null): Element[] {
  const out: Element[] = []
  for (let node = el; node; node = parentOf(node)) out.push(node)
  return out
}

class VirtualPointer {
  private over: Element | null = null
  private pressed: Element | null = null // where the button went down, while it is down
  private x = -1
  private y = -1
  private readonly onMove: (x: number, y: number) => void

  constructor(onMove: (x: number, y: number) => void) {
    this.onMove = onMove
  }

  private fire(target: EventTarget, type: string, related: Element | null, bubbles = true, buttons = 0) {
    const init = {
      bubbles,
      cancelable: true,
      composed: true,
      view: window,
      clientX: this.x,
      clientY: this.y,
      screenX: window.screenX + this.x,
      screenY: window.screenY + this.y,
      button: 0,
      buttons,
      detail: type === 'click' || type.endsWith('down') || type.endsWith('up') ? 1 : 0,
      relatedTarget: related,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }
    target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init))
  }

  // Out of the old element and into the new one, the order a real mouse sends them in.
  private cross(to: Element | null) {
    const from = this.over
    if (from === to) return
    const fromChain = chain(from)
    const toChain = chain(to)
    if (from?.isConnected) {
      this.fire(from, 'pointerout', to)
      for (const el of fromChain.filter((el) => !toChain.includes(el))) this.fire(el, 'pointerleave', to, false)
      this.fire(from, 'mouseout', to)
      for (const el of fromChain.filter((el) => !toChain.includes(el))) this.fire(el, 'mouseleave', to, false)
    }
    if (to) {
      const entered = toChain.filter((el) => !fromChain.includes(el)).reverse()
      this.fire(to, 'pointerover', from)
      for (const el of entered) this.fire(el, 'pointerenter', from, false)
      this.fire(to, 'mouseover', from)
      for (const el of entered) this.fire(el, 'mouseenter', from, false)
    }
    this.over = to
  }

  move(x: number, y: number) {
    const movementX = this.x < 0 ? 0 : x - this.x
    const movementY = this.y < 0 ? 0 : y - this.y
    this.x = x
    this.y = y
    const hit = hitAt(x, y)
    this.cross(hit)
    // While pressed, an element that captured the pointer (drag code does) gets its moves wherever it is.
    const captured = this.pressed?.isConnected && this.pressed.hasPointerCapture?.(1) ? this.pressed : null
    const target = captured ?? hit ?? document.documentElement
    const buttons = this.pressed ? 1 : 0
    for (const type of ['pointermove', 'mousemove']) {
      const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y, movementX, movementY, button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true }
      target.dispatchEvent(type === 'pointermove' ? new PointerEvent(type, init) : new MouseEvent(type, init))
    }
    this.onMove(x, y)
  }

  // Moves across several frames, so handlers that measure velocity or interpolate see a real path.
  async travel(x: number, y: number, steps = TRAVEL_STEPS) {
    const fromX = this.x < 0 ? x : this.x
    const fromY = this.y < 0 ? y : this.y
    for (let i = 1; i <= steps; i++) {
      this.move(fromX + ((x - fromX) * i) / steps, fromY + ((y - fromY) * i) / steps)
      await nextFrame()
    }
  }

  // The button down on whatever is under the pointer.
  down() {
    const target = hitAt(this.x, this.y) ?? document.documentElement
    this.pressed = target
    this.fire(target, 'pointerdown', null, true, 1)
    this.fire(target, 'mousedown', null, true, 1)
  }

  // The button up where the pointer is now, and the click on what that and where it went down share,
  // as a browser sends it (after a drag too).
  up() {
    const from = this.pressed
    const captured = from?.isConnected && from.hasPointerCapture?.(1) ? from : null
    const target = captured ?? hitAt(this.x, this.y) ?? document.documentElement
    this.pressed = null
    this.fire(target, 'pointerup', null)
    this.fire(target, 'mouseup', null)
    const under = chain(target)
    const common = from ? chain(from).find((el) => under.includes(el)) : target
    if (common) this.fire(common, 'click', null)
  }

  // A click where the pointer is, held as long as a finger holds a mouse button.
  async press() {
    this.down()
    await wait(PRESS_MS)
    this.up()
  }

  // Off the page entirely, as when the mouse leaves the window.
  leaveWindow() {
    this.cross(null)
    this.x = -1
    this.y = -1
  }
}

// Somewhere just outside the box that is still on the page, to park the pointer at rest. Null when
// the box fills the window: then the pointer leaves the window instead.
function parkingSpot(el: Element, r: DOMRect): { x: number; y: number } | null {
  const spots = [
    { x: r.left + r.width / 2, y: r.top - 14 },
    { x: r.left + r.width / 2, y: r.bottom + 14 },
    { x: r.left - 14, y: r.top + r.height / 2 },
    { x: r.right + 14, y: r.top + r.height / 2 },
  ]
  for (const s of spots) {
    if (s.x < 4 || s.y < 4 || s.x > window.innerWidth - 4 || s.y > window.innerHeight - 4) continue
    const hit = hitAt(s.x, s.y)
    if (hit && hit !== el && !el.contains(hit)) return s
  }
  return null
}

// Just outside the edge nearest to `p`, still on the page; else the next nearest edge.
function exitSpot(el: Element, r: DOMRect, p: Point): { x: number; y: number } | null {
  const x = r.left + p.x * r.width
  const y = r.top + p.y * r.height
  const spots = [
    { d: y - r.top, x, y: r.top - 14 },
    { d: r.bottom - y, x, y: r.bottom + 14 },
    { d: x - r.left, x: r.left - 14, y },
    { d: r.right - x, x: r.right + 14, y },
  ].sort((a, b) => a.d - b.d)
  for (const s of spots) {
    if (s.x < 4 || s.y < 4 || s.x > window.innerWidth - 4 || s.y > window.innerHeight - 4) continue
    const hit = hitAt(s.x, s.y)
    if (hit && hit !== el && !el.contains(hit)) return s
  }
  return null
}

// The user's own mouse moves would reach the page too, and pull a shader that follows the pointer.
function blockRealPointer(): () => void {
  const types = ['pointermove', 'mousemove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'pointerrawupdate']
  const stop = (e: Event) => {
    if (e.isTrusted) e.stopImmediatePropagation()
  }
  for (const type of types) window.addEventListener(type, stop, true)
  return () => {
    for (const type of types) window.removeEventListener(type, stop, true)
  }
}

// ---------- fitting values to the pointer ----------

// Least squares fit of `v` on the feature rows (each starts with 1), and its R².
function fit(rows: number[][], v: number[]): { coef: number[]; r2: number } {
  const k = rows[0]?.length ?? 0
  const a = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0))
  rows.forEach((f, n) => {
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) a[i][j] += f[i] * f[j]
      a[i][k] += f[i] * v[n]
    }
  })
  for (let i = 0; i < k; i++) a[i][i] += 1e-9
  for (let c = 0; c < k; c++) {
    let p = c
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r
    ;[a[c], a[p]] = [a[p], a[c]]
    if (Math.abs(a[c][c]) < 1e-12) continue
    for (let r = 0; r < k; r++) {
      if (r === c) continue
      const f = a[r][c] / a[c][c]
      for (let j = c; j <= k; j++) a[r][j] -= f * a[c][j]
    }
  }
  const coef = a.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[k] / row[i]))
  const mean = v.reduce((s, x) => s + x, 0) / v.length
  let ssTot = 0
  let ssRes = 0
  rows.forEach((f, n) => {
    const predicted = f.reduce((s, x, i) => s + x * coef[i], 0)
    ssTot += (v[n] - mean) ** 2
    ssRes += (v[n] - predicted) ** 2
  })
  return { coef, r2: ssTot < 1e-18 ? 1 : 1 - ssRes / ssTot }
}

interface Context {
  box: DOMRect
  canvas?: HTMLCanvasElement // the drawing buffer gives more units a shader may use
  noun: string // "canvas" or "section", for the sentences
  scrollY: number
}

// What a linear value range across the box means: 0–1 of it, clip space, CSS px, clientX…
function meaning(axis: 'x' | 'y', v0: number, v1: number, { box, canvas, noun, scrollY }: Context): string | null {
  const dpr = window.devicePixelRatio || 1
  const candidates: [number, number, string][] =
    axis === 'x'
      ? [
          [0, 1, `the pointer x as 0–1 across the ${noun}`],
          [1, 0, 'the pointer x as 0–1, mirrored (1 at the left)'],
          [-1, 1, 'the pointer x in clip space (−1 at the left edge, 1 at the right)'],
          [-0.5, 0.5, `the pointer x as −0.5…0.5 from the ${noun} center`],
          [0, box.width, `the pointer x in CSS px from the ${noun}'s left edge`],
          [-box.width / 2, box.width / 2, `the pointer x in CSS px from the ${noun} center`],
          [0, box.width * dpr, `the pointer x in device px from the left edge (CSS px × devicePixelRatio ${fmt(dpr)})`],
          [0, canvas?.width ?? 0, 'the pointer x in drawing-buffer px (canvas.width) from the left edge'],
          [box.left, box.right, 'event.clientX (window px)'],
          [box.left / window.innerWidth, box.right / window.innerWidth, 'clientX / innerWidth'],
          [(2 * box.left) / window.innerWidth - 1, (2 * box.right) / window.innerWidth - 1, 'clientX mapped to −1…1 across the window'],
        ]
      : [
          [0, 1, `the pointer y as 0–1 down the ${noun} (0 at the top)`],
          [1, 0, `the pointer y as 0–1 up the ${noun} (y up, as in WebGL: 1 at the top)`],
          [1, -1, 'the pointer y in clip space, y up (1 at the top edge, −1 at the bottom)'],
          [-1, 1, `the pointer y as −1…1 down the ${noun}`],
          [0.5, -0.5, `the pointer y as 0.5…−0.5 from the ${noun} center, y up`],
          [-0.5, 0.5, `the pointer y as −0.5…0.5 from the ${noun} center, y down`],
          [0, box.height, `the pointer y in CSS px from the ${noun}'s top edge`],
          [box.height, 0, `the pointer y in CSS px from the ${noun}'s bottom edge (y up, like gl_FragCoord)`],
          [0, box.height * dpr, `the pointer y in device px from the top edge (CSS px × devicePixelRatio ${fmt(dpr)})`],
          [box.height * dpr, 0, 'the pointer y in device px from the bottom edge (y up, like gl_FragCoord)'],
          [0, canvas?.height ?? 0, 'the pointer y in drawing-buffer px (canvas.height) from the top edge'],
          [canvas?.height ?? 0, 0, 'the pointer y in drawing-buffer px from the bottom edge (y up, like gl_FragCoord)'],
          [box.top, box.bottom, 'event.clientY (window px)'],
          [box.top + scrollY, box.bottom + scrollY, 'event.pageY (document px)'],
          [box.top / window.innerHeight, box.bottom / window.innerHeight, 'clientY / innerHeight'],
          [1 - box.top / window.innerHeight, 1 - box.bottom / window.innerHeight, '1 − clientY / innerHeight (y up)'],
          [1 - (2 * box.top) / window.innerHeight, 1 - (2 * box.bottom) / window.innerHeight, 'clientY mapped to 1…−1 down the window (y up)'],
          [(2 * box.top) / window.innerHeight - 1, (2 * box.bottom) / window.innerHeight - 1, 'clientY mapped to −1…1 down the window'],
        ]
  let best: { label: string; err: number } | null = null
  for (const [c0, c1, text] of candidates) {
    const span = Math.abs(c1 - c0)
    if (span < 1e-9) continue
    const err = (Math.abs(v0 - c0) + Math.abs(v1 - c1)) / span
    if (err < 0.12 && (!best || err < best.err)) best = { label: text, err }
  }
  return best?.label ?? null
}

interface PointerValue {
  key: string
  index: number
  name: string
  kind: 'linear' | 'flag' | 'steps' | 'curve'
  axis?: 'x' | 'y' | 'xy'
  r2: number
  rest: number
  line: number // its line in `pointer`
}

function componentName(key: string, index: number, length: number): string {
  return length === 1 ? key : `${key}.${'xyzw'[index] ?? `[${index}]`}`
}

function region(points: Point[]): string {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const span = (lo: number, hi: number) => (Math.round(lo * 100) === Math.round(hi * 100) ? pct(lo) : `${pct(lo)}–${pct(hi)}`)
  return `${span(Math.min(...xs), Math.max(...xs))} across, ${span(Math.min(...ys), Math.max(...ys))} down`
}

function analyzeValues(samples: Sample[], restA: Values, restB: Values, restGap: number, ctx: Context, where: (t: number) => Point): { pointer: string[]; idle: string[]; found: PointerValue[] } {
  const pointer: string[] = []
  const idle: string[] = []
  const found: PointerValue[] = []
  if (samples.length < 4) return { pointer, idle, found }
  // Every value read at rest, and the ones that only exist once the pointer is over it (a custom
  // property a script sets on the first move): NaN at rest.
  const keys = new Set([...restB.keys(), ...(samples[0]?.values.keys() ?? [])])
  for (const key of keys) {
    const series = samples.map((s) => s.values.get(key))
    const length = series[0]?.length ?? 0
    if (!length || series.some((v) => !v || v.length !== length)) continue
    const rest = restB.get(key)?.length === length ? restB.get(key)! : new Array<number>(length).fill(NaN)
    for (let index = 0; index < length; index++) {
      const name = componentName(key, index, length)
      const v = series.map((s) => s![index])
      const restV = rest[index]
      const unset = Number.isNaN(restV)
      const scale = Math.max(1, ...v.map(Math.abs), unset ? 0 : Math.abs(restV))
      const tol = Math.max(1e-4, 1e-5 * scale) // float noise in a matrix is not a change
      const before = restA.get(key)?.[index] ?? restV
      const drifting = !unset && Math.abs(restV - before) > tol
      const lo = Math.min(...v)
      const hi = Math.max(...v)
      const mean = v.reduce((s, x) => s + x, 0) / v.length

      if (drifting) {
        // Changes by itself (time, an idle animation). It still counts as following the pointer when
        // the pointer explains it much better than the clock does.
        const full = fit(samples.map((s) => [1, s.x, s.y, s.t]), v)
        const time = fit(samples.map((s) => [1, s.t]), v)
        if (full.r2 >= 0.9 && full.r2 - time.r2 >= 0.25 && pointer.length < MAX_LINES) {
          const [a, b, c] = full.coef
          pointer.push(`${linearText(name, a, b, c, ctx)}, plus a drift of ${fmt(full.coef[3])}/s`)
          found.push({ key, index, name, kind: 'linear', axis: axisOf(b, c), r2: full.r2, rest: restV, line: pointer.length - 1 })
        } else if (idle.length < MAX_LINES) {
          const rate = (restV - before) / restGap
          idle.push(`${name} (${rate > 0 ? '+' : ''}${fmt(rate)}/s)`)
        }
        continue
      }

      if (hi - lo <= tol) {
        // The same everywhere over the box, but not at rest: a hover on/off value.
        if ((unset || Math.abs(mean - restV) > tol * 10) && pointer.length < MAX_LINES) {
          pointer.push(`${name}: ${unset ? 'not set' : fmt(restV)} with the pointer off the ${ctx.noun}, ${fmt(mean)} anywhere over it (a hover on/off value)`)
          found.push({ key, index, name, kind: 'flag', r2: 1, rest: restV, line: pointer.length - 1 })
        }
        continue
      }
      if (pointer.length >= MAX_LINES) continue

      const linear = lagFit(samples, v, where)
      if (linear.r2 >= LINEAR_R2) {
        const [a, b, c] = linear.coef
        pointer.push(linearText(name, a, b, c, ctx) + restText(restV, a + b / 2 + c / 2, ctx.noun))
        found.push({ key, index, name, kind: 'linear', axis: axisOf(b, c), r2: linear.r2, rest: restV, line: pointer.length - 1 })
        continue
      }

      // Depends on where the pointer is, but not linearly: a few distinct values (which side of a
      // shape the pointer is nearest), or a curve (distance to something).
      const rounded = v.map((x) => Number(x.toPrecision(4)))
      const distinct = Array.from(new Set(rounded))
      if (distinct.length >= 2 && distinct.length <= 6) {
        const parts = distinct
          .sort((p, q) => p - q)
          .map((d) => `${fmt(d)} with the pointer at ${region(samples.filter((_, i) => rounded[i] === d))}`)
        pointer.push(`${name} takes ${distinct.length} values depending on where the pointer is: ${parts.join('; ')}${restText(restV, NaN, ctx.noun)}`)
        found.push({ key, index, name, kind: 'steps', r2: linear.r2, rest: restV, line: pointer.length - 1 })
      } else {
        const iMax = v.indexOf(hi)
        const iMin = v.indexOf(lo)
        pointer.push(`${name} changes with the pointer position, not linearly: from ${fmt(lo)} (pointer at ${pos(samples[iMin])}) to ${fmt(hi)} (pointer at ${pos(samples[iMax])})${restText(restV, NaN, ctx.noun)}`)
        found.push({ key, index, name, kind: 'curve', r2: linear.r2, rest: restV, line: pointer.length - 1 })
      }
    }
  }
  return { pointer, idle, found }
}

function axisOf(b: number, c: number): 'x' | 'y' | 'xy' {
  if (Math.abs(c) <= 0.15 * Math.abs(b)) return 'x'
  if (Math.abs(b) <= 0.15 * Math.abs(c)) return 'y'
  return 'xy'
}

function restText(rest: number, center: number, noun: string): string {
  if (Number.isNaN(rest)) return `; not set with the pointer off the ${noun} (the first move sets it)`
  if (Number.isFinite(center) && Math.abs(rest - center) <= 1e-3 * Math.max(1, Math.abs(center))) return ''
  return `; ${fmt(rest)} with the pointer off the ${noun}`
}

// For values in CSS px (a transform, a position): moving with the pointer 1:1, a fraction of it
// (parallax), or against it.
const px = (name: string) => /translate|\(px\)|--|position/.test(name) && !/rotate|scale|opacity|deg/.test(name)

function follows(span: number, size: number): string {
  const ratio = span / size
  if (Math.abs(ratio - 1) < 0.08) return ': moves with the pointer 1:1, in CSS px'
  if (Math.abs(ratio) >= 0.02 && Math.abs(ratio) <= 3) return `: linear, about ${fmt(Math.abs(ratio))}× the pointer's movement if it is in CSS px${ratio < 0 ? ', against it' : ''} (parallax)`
  return ' (linear)'
}

function linearText(name: string, a: number, b: number, c: number, ctx: Context): string {
  const axis = axisOf(b, c)
  if (axis === 'x') {
    const v0 = a + c / 2
    const v1 = a + b + c / 2
    const means = meaning('x', v0, v1, ctx)
    return `${name}: ${fmt(v0)} with the pointer at the left edge → ${fmt(v1)} at the right edge${means ? `: ${means}` : px(name) ? follows(v1 - v0, ctx.box.width) : ' (linear)'}`
  }
  if (axis === 'y') {
    const v0 = a + b / 2
    const v1 = a + c + b / 2
    const means = meaning('y', v0, v1, ctx)
    return `${name}: ${fmt(v0)} with the pointer at the top edge → ${fmt(v1)} at the bottom edge${means ? `: ${means}` : px(name) ? follows(v1 - v0, ctx.box.height) : ' (linear)'}`
  }
  const term = (k: number, v: string) => `${k < 0 ? '−' : '+'} ${fmt(Math.abs(k))}·${v}`
  return `${name} ≈ ${fmt(a)} ${term(b, 'x')} ${term(c, 'y')} (x, y: the pointer as 0–1 of the ${ctx.noun} width and height, from its top-left)`
}

// ---------- easing ----------

interface Tick {
  t: number // ms since the move
  values: Values
  pixels: Pixels | null
}

// How a value gets from `from` to where it ends up: at once, a per-frame lerp, a spring, or a tween.
function easeText(from: number, ticks: { t: number; v: number }[]): string | null {
  const last = ticks.at(-1)
  if (!last) return null
  if (!Number.isFinite(from)) return null
  const end = last.v
  const span = from - end
  if (Math.abs(span) <= 1e-6 * Math.max(1, Math.abs(end))) return null
  const rem = ticks.map((k) => ({ t: k.t, r: (k.v - end) / span }))
  const t90 = rem.find((k) => Math.abs(k.r) <= 0.1)?.t
  if (t90 === undefined) return `still moving ${WATCH_MS} ms later`
  if (t90 <= 40) return 'at once (no easing)'
  const overshoot = Math.max(0, ...rem.map((k) => -k.r))
  if (overshoot > 0.05) return `like a spring: overshoots by ${pct(overshoot)} of the move, 90% settled after ${Math.round(t90)} ms`
  // Per frame, as pages write it (`v += (target - v) * k` in requestAnimationFrame), at the rate the
  // frames came in here.
  const ks: number[] = []
  const dts: number[] = []
  for (let i = 0; i + 1 < rem.length; i++) {
    const a = rem[i]
    const b = rem[i + 1]
    if (a.r < 0.03 || a.r > 0.95 || b.r <= 0 || b.t <= a.t) continue
    ks.push(1 - b.r / a.r)
    dts.push(b.t - a.t)
  }
  const median = (list: number[]) => [...list].sort((p, q) => p - q)[Math.floor(list.length / 2)]
  const k = median(ks)
  const sorted = [...ks].sort((p, q) => p - q)
  const spread = ks.length ? (sorted[Math.floor(ks.length * 0.75)] - sorted[Math.floor(ks.length * 0.25)]) / 2 : Infinity
  if (ks.length >= 4 && k > 0 && spread < 0.3 * k) {
    const fps = Math.round(1000 / median(dts))
    const rate = Math.abs(fps - 60) > 8 ? `; measured at ${fps} fps, so at 60 fps that is ${fmt(1 - (1 - k) ** (fps / 60))} per frame if the page scales it by time` : ''
    return `eases out: each frame it covers about ${pct(k)} of the remaining distance (\`v += (target - v) * ${fmt(k)}\` per animation frame${rate}), 90% there after ${Math.round(t90)} ms`
  }
  return `in about ${Math.round(t90)} ms (a tween or time-based ease, not a fixed per-frame lerp)`
}

function pixelSettle(before: Pixels | null, ticks: Tick[], view: View, noise: number): number | null | 'never' {
  const end = ticks.at(-1)?.pixels
  if (!before || !end) return null
  const total = compare(before, end, view)?.mean ?? 0
  if (total <= Math.max(MIN_CHANGE, noise * 2)) return null
  for (const k of ticks) {
    if (!k.pixels) continue
    const left = compare(k.pixels, end, view)?.mean ?? Infinity
    if (left <= Math.max(noise * 1.5, total * 0.1)) return k.t
  }
  return 'never'
}

// ---------- one sweep: a canvas or the section ----------

// Where the pointer was, from every move it made.
interface Mark {
  t: number // seconds since this sweep started
  x: number // viewport px
  y: number
}

// The last move at or before `t`.
function pathAt(path: Mark[], t: number): Mark | undefined {
  if (!path.length || t < path[0].t) return path[0]
  let lo = 0
  let hi = path.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (path[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return path[lo]
}

// A value that eases toward the pointer trails it while the pointer moves: it is fitted against where
// the pointer was a moment earlier, with the delay that explains it best.
function lagFit(samples: Sample[], v: number[], where: (t: number) => Point): { coef: number[]; r2: number; lag: number } {
  let best = { ...fit(samples.map((s) => [1, s.x, s.y]), v), lag: 0 }
  for (let lag = LAG_STEP_S; lag <= MAX_LAG_S; lag += LAG_STEP_S) {
    const f = fit(
      samples.map((s) => {
        const p = where(s.t - lag)
        return [1, p.x, p.y]
      }),
      v,
    )
    if (f.r2 > best.r2 + 1e-3) best = { ...f, lag }
  }
  return best
}

type Rect = { x: number; y: number; w: number; h: number }

function overlap(a: Rect, b: DOMRect): Rect | null {
  const x = Math.max(a.x, b.left)
  const y = Math.max(a.y, b.top)
  const w = Math.min(a.x + a.w, b.right) - x
  const h = Math.min(a.y + a.h, b.bottom) - y
  return w > 4 && h > 4 ? { x, y, w, h } : null
}

const WHOLE: View = { x0: 0, x1: 1, y0: 0, y1: 1 }

// Brings `el` on screen (the section, for a canvas outside it that lies under it) and returns its box,
// the part of it the pointer goes over (`view`: on screen, and under the section for a canvas outside
// it) and the part a screenshot of it sees (`seen`), as fractions of the box.
// Where it is on screen, scrolled into view first. `view` is the part the pointer sweeps; `seen` is
// the part screenshots read, which stops at `right` (the drawer's edge).
async function place(el: Element, root: Element, right = window.innerWidth): Promise<{ box: DOMRect; view: View; seen: View; outsider: boolean } | null> {
  const outsider = el !== root && !containsDeep(root, el)
  const anchor = outsider ? root : el
  const r = anchor.getBoundingClientRect()
  if ((Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top)) / Math.min(r.height, window.innerHeight) < 0.9) {
    anchor.scrollIntoView({ block: r.height > window.innerHeight ? 'start' : 'center', inline: 'nearest', behavior: 'instant' })
    await nextFrame()
    await wait(250)
  }
  const box = el.getBoundingClientRect()
  const screenRect = onScreen(box)
  const sweptRect = screenRect && outsider ? overlap(screenRect, root.getBoundingClientRect()) : screenRect
  if (!screenRect || !sweptRect || (!outsider && sweptRect.w * sweptRect.h < 0.25 * box.width * box.height)) return null
  const fractions = (f: Rect): View => ({ x0: (f.x - box.left) / box.width, x1: (f.x + f.w - box.left) / box.width, y0: (f.y - box.top) / box.height, y1: (f.y + f.h - box.top) / box.height })
  return { box, view: fractions(sweptRect), seen: fractions(onScreen(box, right) ?? screenRect), outsider }
}

async function sweepOne(el: Element, root: Element, { shoot, onProgress, onFocus, drawerEdge, signal }: SweepOptions, deadline: number, step: string): Promise<HoverSweep | null> {
  const kind = el instanceof HTMLCanvasElement ? 'canvas' : 'section'
  const canvas = el instanceof HTMLCanvasElement ? el : undefined
  const name = label(el)
  // A canvas outside the section (a page-wide background behind it) is swept where the section is.
  const right = drawerEdge?.() ?? window.innerWidth
  const placed = await place(el, root, right)
  if (!placed) return null
  const { box, view, seen, outsider } = placed
  const ctx: Context = { box, canvas, noun: kind, scrollY: window.scrollY }
  const started = now()
  const notes: string[] = []

  const at = (p: Point) => ({ x: box.left + p.x * box.width, y: box.top + p.y * box.height })
  const path: Mark[] = []
  const pointer = new VirtualPointer((x, y) => {
    path.push({ t: (now() - started) / 1000, x, y })
    onFocus?.({ el, action: 'sweep', area: root, point: { x, y } })
  })
  const inBox = (t: number): Point => {
    const m = pathAt(path, t)
    return m ? { x: (m.x - box.left) / box.width, y: (m.y - box.top) / box.height } : { x: 0.5, y: 0.5 }
  }
  const read = canvas ? () => readValues(canvas) : styleReader(el)
  const owners = 'owners' in read ? (read as StyleReader).owners : null
  const hasValues = read().size > 0
  const values = () => (hasValues ? read() : new Map<string, number[]>())

  const park = async () => {
    const spot = parkingSpot(el, box)
    if (spot) await pointer.travel(spot.x, spot.y)
    else pointer.leaveWindow()
    onFocus?.({ el, action: 'sweep', area: root })
  }

  // ---- rest ----
  onProgress?.(`${step}: reading it at rest`)
  await park()
  await wait(REST_MS)
  const reader = await pickReader(el, shoot, right)
  // A canvas read back covers all of it; a screenshot only the part on screen.
  const pixView = reader?.mode === 'screen' ? seen : WHOLE
  // Several frames at rest: a canvas or section that animates by itself (a shimmer, a marquee) only
  // counts as reacting where the pointer takes a pixel outside the range it has at rest.
  const restA = values()
  const restStart = now()
  const restReads: Pixels[] = []
  let restFrame: string | undefined
  for (let i = 0; i < (reader?.mode === 'screen' ? REST_SHOTS : REST_FRAMES); i++) {
    if (i) await wait(NOISE_GAP_MS)
    const read = reader ? await reader.read() : null
    if (!read) continue
    if (!restFrame) restFrame = read.frame()
    restReads.push(read.pixels)
  }
  if (!reader) await wait(NOISE_GAP_MS)
  const restB = values()
  const restGap = Math.max(0.05, (now() - restStart) / 1000)
  const restRange = range(restReads)
  const noise = restReads.length > 1 ? (compare(restReads[0], restReads[restReads.length - 1], pixView)?.mean ?? 0) : 0
  const threshold = MIN_CHANGE
  if (!reader && !hasValues) {
    pointer.leaveWindow()
    return null // nothing to measure it by
  }

  const ignore = new Set(Array.from(restB.keys()).filter((k) => restA.get(k)?.join() !== restB.get(k)?.join()))
  // Settled: each value moved less this frame than 1.5% of how far it has come since the hold started
  // (an ease is ~90% of the way there), or not at all. A per-frame lerp never fully stops.
  const settled = (start: Values, a: Values, b: Values) => {
    for (const [k, v] of b) {
      if (ignore.has(k)) continue
      const u = a.get(k)
      const s = start.get(k)
      if (!u || !s) return false
      for (let i = 0; i < v.length; i++) {
        const step = Math.abs(v[i] - u[i])
        if (step > 1e-6 * Math.max(1, Math.abs(v[i])) && step > 0.015 * Math.abs(v[i] - s[i])) return false
      }
    }
    return true
  }
  // Until the values and the pixels stop changing for a few frames in a row (its own animation
  // aside). Screenshots are too slow to watch, so without values that is a fixed wait.
  const pixelsWatched = reader?.mode === 'canvas'
  const frameNoise = await (async () => {
    const a = reader?.now()
    await nextFrame()
    const b = reader?.now()
    return a && b ? (compare(a, b, pixView)?.mean ?? 0) : 0
  })()
  const pixelStill = Math.max(0.001, frameNoise * 2)
  const hold = async () => {
    if (!hasValues && !pixelsWatched) return wait(HOLD_BLIND_MS)
    const start = now()
    const first = values()
    let prev = first
    let prevPixels = pixelsWatched ? (reader?.now() ?? null) : null
    let still = 0
    while (now() - start < HOLD_MAX_MS) {
      await nextFrame()
      const cur = values()
      const curPixels = pixelsWatched ? (reader?.now() ?? null) : null
      const pixelsSettled = !pixelsWatched || (!!prevPixels && !!curPixels && (compare(prevPixels, curPixels, pixView)?.mean ?? 1) <= pixelStill)
      still = settled(first, prev, cur) && pixelsSettled ? still + 1 : 0
      prev = cur
      prevPixels = curPixels
      if (still >= STILL_FRAMES && now() - start >= HOLD_MIN_MS) return
    }
  }
  const watch = async (ms = WATCH_MS): Promise<Tick[]> => {
    const ticks: Tick[] = []
    const start = now()
    while (now() - start < ms) {
      await nextFrame()
      ticks.push({ t: now() - start, values: values(), pixels: reader?.now() ?? null })
    }
    return ticks
  }

  // One continuous move from `a` to `b` (viewport px), a step every frame, as a hand drags the mouse
  // across: `frame` reads what it did after each step. The pointer only waits at the start, so what
  // eases toward it has caught up before it goes.
  const stroke = async (a: { x: number; y: number }, b: { x: number; y: number }, ms: number, frame: (t: number) => void) => {
    await pointer.travel(a.x, a.y)
    await hold()
    const start = now()
    for (let f = 0; f < 1; ) {
      f = Math.min(1, (now() - start) / ms)
      pointer.move(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f)
      await nextFrame()
      frame((now() - started) / 1000)
    }
  }

  // What the strokes read: the values every frame, the pixels every frame from a canvas or in
  // screenshots as fast as they come, and the frames worth keeping as references.
  const samples: Sample[] = []
  const hits: Hit[] = []
  const shots = { pending: null as Promise<void> | null }
  const candidates: { p: Point; axis: 'x' | 'y'; score: number; dataUrl: string }[] = []
  const keep = (h: Hit, frame: (() => string | undefined) | undefined) => {
    const score = h.score ?? 0
    if (!frame || score <= threshold) return
    const near = candidates.findIndex((c) => Math.hypot(c.p.x - h.x, c.p.y - h.y) < 0.15)
    if (near >= 0 && score <= candidates[near].score * 1.1) return
    const weakest = candidates.reduce((w, c, i) => (c.score < candidates[w].score ? i : w), 0)
    if (near < 0 && candidates.length >= FRAMES && candidates[weakest].score >= score) return
    const dataUrl = frame()
    if (!dataUrl) return
    if (near >= 0) candidates.splice(near, 1)
    else if (candidates.length >= FRAMES) candidates.splice(weakest, 1)
    candidates.push({ p: { x: h.x, y: h.y }, axis: h.axis, score, dataUrl })
  }
  const hit = (p: Point, t: number, axis: 'x' | 'y', pixels: Pixels, frame?: () => string | undefined) => {
    if (!restRange) return
    const change = outside(restRange, pixels, pixView, p)
    const h: Hit = { ...p, t, axis, change, score: change ? nearScore(change) : null, shift: change?.shift ?? null }
    hits.push(h)
    keep(h, frame)
  }
  const reading = (axis: 'x' | 'y') => (t: number) => {
    const p = inBox(t)
    if (hasValues) samples.push({ ...p, t, values: values() })
    if (reader?.mode === 'canvas') {
      const pixels = reader.now()
      if (pixels) hit(p, t, axis, pixels, reader.snap)
    } else if (reader && !shots.pending) {
      shots.pending = reader
        .read()
        .then((r) => {
          if (r) hit(p, t, axis, r.pixels, r.frame)
        })
        .finally(() => {
          shots.pending = null
        })
    }
  }

  // ---- enter: from outside to the center ----
  const mid = (lo: number, hi: number, f: number) => lo + (hi - lo) * f
  const center: Point = { x: mid(view.x0, view.x1, 0.5), y: mid(view.y0, view.y1, 0.5) }
  {
    const c = at(center)
    await pointer.travel(c.x, c.y, TRAVEL_STEPS * 2)
  }
  const enterTicks = await watch()

  // ---- the strokes: left to right through the middle, then top to bottom ----
  const strokes: ['x' | 'y', Point, Point, string][] = [
    ['x', { x: mid(view.x0, view.x1, STROKE_INSET), y: center.y }, { x: mid(view.x0, view.x1, 1 - STROKE_INSET), y: center.y }, 'left to right'],
    ['y', { x: center.x, y: mid(view.y0, view.y1, STROKE_INSET) }, { x: center.x, y: mid(view.y0, view.y1, 1 - STROKE_INSET) }, 'top to bottom'],
  ]
  let outOfTime = false
  for (const [axis, a, b, dir] of strokes) {
    if (now() > deadline || !!signal?.aborted) {
      outOfTime = true
      break
    }
    onProgress?.(`${step}: ${dir}`)
    const from = at(a)
    const to = at(b)
    const ms = reader?.mode === 'screen' ? STROKE_MS.screen : clamp((Math.hypot(to.x - from.x, to.y - from.y) / STROKE_PX_PER_S) * 1000, STROKE_MS.min, STROKE_MS.max)
    await stroke(from, to, ms, reading(axis))
    await shots.pending
  }

  // ---- values that follow the pointer ----
  const { pointer: pointerLines, idle, found } = analyzeValues(samples, restA, restB, restGap, ctx, inBox)
  const motion: string[] = []

  // ---- effects of one element: a tilt card, a magnetic button, a spotlight on a card ----
  // The same two strokes over the element alone, its values fitted to the pointer's position across
  // it, then a move and a leave watched for the easing.
  const sweepElement = async (owner: Element, list: PointerValue[]): Promise<{ lines: [PointerValue, string][]; motion: string[] }> => {
    const r = owner.getBoundingClientRect()
    const where = (lx: number, ly: number) => ({ x: r.left + lx * r.width, y: r.top + ly * r.height })
    const toLocal = (t: number): Point => {
      const m = pathAt(path, t)
      return m ? { x: (m.x - r.left) / r.width, y: (m.y - r.top) / r.height } : { x: 0.5, y: 0.5 }
    }
    const points: Sample[] = []
    const take = (t: number) => {
      points.push({ ...toLocal(t), t, values: values() })
    }
    await stroke(where(LOCAL_INSET, 0.5), where(1 - LOCAL_INSET, 0.5), LOCAL_STROKE_MS, take)
    await stroke(where(0.5, LOCAL_INSET), where(0.5, 1 - LOCAL_INSET), LOCAL_STROKE_MS, take)
    const name = label(owner)
    const own: Context = { box: r, noun: `\`${name}\``, scrollY: window.scrollY }
    const lines: [PointerValue, string][] = []
    let best: { f: PointerValue; axis: 'x' | 'y' | 'xy'; r2: number } | null = null
    // Every value of this element and those inside it, not only those the section's strokes caught:
    // a tilt's rotateX is 0 all along the card's middle row. A new one gets its own line (-1 until
    // it's added).
    const all = [...list]
    for (const [key, v] of points[0]?.values ?? []) {
      const from = owners?.get(key)
      if (!from || !containsDeep(owner, from) || ignore.has(key)) continue
      v.forEach((_, index) => {
        if (all.some((f) => f.key === key && f.index === index)) return
        // Already described from the section's strokes (an eased value seen as they left it): replaced.
        const known = found.find((f) => f.key === key && f.index === index)
        all.push(known ?? { key, index, name: componentName(key, index, v.length), kind: 'linear', r2: 0, rest: restB.get(key)?.[index] ?? NaN, line: -1 })
      })
    }
    for (const f of all) {
      const v = points.map((p) => p.values.get(f.key)?.[f.index])
      if (v.some((x) => x === undefined)) continue
      const nums = v as number[]
      const span = Math.max(...nums) - Math.min(...nums)
      if (span <= Math.max(1e-4, 1e-5 * Math.max(...nums.map(Math.abs)))) continue // doesn't move over it
      const linear = lagFit(points, nums, toLocal)
      const rest = Number.isNaN(f.rest) ? 'not set' : fmt(f.rest)
      if (linear.r2 >= LINEAR_R2) {
        const [a, b, c] = linear.coef
        lines.push([f, `${linearText(f.name, a, b, c, own)} (only while the pointer is over \`${name}\`; ${rest} otherwise)`])
        if (!best || linear.r2 > best.r2) best = { f, axis: axisOf(b, c), r2: linear.r2 }
      } else {
        const lo = Math.min(...nums)
        const hi = Math.max(...nums)
        const at = (k: number) => `${pct(points[k].x)} across, ${pct(points[k].y)} down \`${name}\``
        lines.push([f, `${f.name} changes while the pointer is over \`${name}\`, not linearly: from ${fmt(lo)} (at ${at(nums.indexOf(lo))}) to ${fmt(hi)} (at ${at(nums.indexOf(hi))}); ${rest} otherwise`])
      }
    }
    // A move across it, then out through the nearest edge.
    const motion: string[] = []
    if (!lines.length) return { lines, motion }
    const vertical = best?.axis === 'y'
    const a = vertical ? where(0.5, 0.25) : where(0.25, 0.5)
    const b = vertical ? where(0.5, 0.75) : where(0.75, 0.5)
    await pointer.travel(a.x, a.y)
    await hold()
    const before = values()
    pointer.move(b.x, b.y)
    const moveTicks = await watch(LOCAL_WATCH_MS)
    const left = values()
    const exit = exitSpot(owner, r, vertical ? { x: 0.5, y: 0.75 } : { x: 0.75, y: 0.5 })
    if (exit) await pointer.travel(exit.x, exit.y, 2)
    const leaveTicks = await watch(LOCAL_WATCH_MS)
    const series = (ticks: Tick[], f: PointerValue) => ticks.map((k) => ({ t: k.t, v: k.values.get(f.key)?.[f.index] ?? NaN })).filter((k) => Number.isFinite(k.v))
    for (const [f] of lines.slice(0, 4)) {
      const from = before.get(f.key)?.[f.index]
      const move = from === undefined ? null : easeText(from, series(moveTicks, f))
      if (move) motion.push(`${f.name} after the pointer moves over \`${name}\`: ${move}`)
      const was = left.get(f.key)?.[f.index]
      const after = series(leaveTicks, f)
      const end = after.at(-1)?.v
      if (was === undefined || end === undefined) continue
      const back = Number.isNaN(f.rest) ? false : Math.abs(end - f.rest) <= Math.max(1e-6, 0.1 * Math.abs(was - f.rest))
      const ease = easeText(was, after)
      motion.push(`${f.name} when the pointer leaves \`${name}\`: ${back ? `goes back to ${fmt(f.rest)}${ease ? `, ${ease}` : ''}` : `stays at ${fmt(end)}`}`)
    }
    return { lines, motion }
  }

  // A value that only changed while the strokes crossed one element, and every element the page
  // probe saw listen for the pointer's position itself, wherever it is in the section (the strokes
  // through the middle may pass it by).
  const local = new Set<PointerValue>()
  const parts: Element[] = []
  if (owners) {
    const byOwner = new Map<Element, PointerValue[]>()
    for (const f of found) {
      const owner = owners.get(f.key)
      if (!owner || owner === el || owner === document.documentElement || owner === document.body || !owner.isConnected) continue
      const r = owner.getBoundingClientRect()
      if (r.width < 20 || r.height < 20 || r.width * r.height > 0.5 * box.width * box.height) continue
      const inside = (p: Point) => {
        const q = at(p)
        return q.x >= r.left && q.x <= r.right && q.y >= r.top && q.y <= r.bottom
      }
      const tol = 1e-4 * Math.max(1, Math.abs(f.rest))
      const moved = samples.filter((p) => {
        const v = p.values.get(f.key)?.[f.index]
        return v !== undefined && !(Math.abs(v - f.rest) <= tol)
      })
      // Mostly while over it: an eased value is still on its way back just after the pointer leaves.
      if (moved.length && moved.filter(inside).length >= moved.length * 0.7) byOwner.set(owner, [...(byOwner.get(owner) ?? []), f])
    }
    for (const m of movers(el, box)) {
      if (!Array.from(byOwner.keys()).some((o) => containsDeep(o, m) || containsDeep(m, o))) byOwner.set(m, [])
    }
    for (const [owner, list] of Array.from(byOwner).slice(0, MAX_LOCAL)) {
      if (now() > deadline || !!signal?.aborted) {
        outOfTime = true
        break
      }
      onProgress?.(`${step}: sweeping ${label(owner)}`)
      const closer = await sweepElement(owner, list)
      if (closer.lines.length) parts.push(owner)
      for (const [f, line] of closer.lines) {
        if (f.line < 0) {
          f.line = pointerLines.push(line) - 1
          found.push(f)
        } else pointerLines[f.line] = line
        local.add(f)
      }
      motion.push(...closer.motion)
    }
  }

  // ---- a jump and a leave, frame by frame ----
  onProgress?.(`${step}: timing the easing`)
  const primary = found.filter((f) => f.kind === 'linear' && !local.has(f)).sort((a, b) => b.r2 - a.r2)[0]
  const vertical = primary?.axis === 'y'
  const A: Point = vertical ? { x: center.x, y: mid(view.y0, view.y1, 0.3) } : { x: mid(view.x0, view.x1, 0.3), y: center.y }
  const B: Point = vertical ? { x: center.x, y: mid(view.y0, view.y1, 0.7) } : { x: mid(view.x0, view.x1, 0.7), y: center.y }
  let jumpTicks: Tick[] = []
  let leaveTicks: Tick[] = []
  let beforeJump: Values = new Map()
  let beforeJumpPixels: Pixels | null = null
  let beforeLeave: Values = new Map()
  let beforeLeavePixels: Pixels | null = null
  // Only for what reacted: nothing to time otherwise.
  const reacted = found.some((f) => !local.has(f)) || hits.some((s) => (s.score ?? 0) > threshold)
  if (reacted && now() < deadline + 5000 && !signal?.aborted) {
    const a = at(A)
    await pointer.travel(a.x, a.y)
    await hold()
    beforeJump = values()
    beforeJumpPixels = reader?.now() ?? null
    const b = at(B)
    pointer.move(b.x, b.y) // one quick flick
    jumpTicks = await watch()
    beforeLeave = values()
    beforeLeavePixels = reader?.now() ?? null
    // Straight out through the nearest edge, so what a value keeps on leave is told apart from rest.
    const exit = exitSpot(el, box, B)
    if (exit) await pointer.travel(exit.x, exit.y, 2)
    else pointer.leaveWindow()
    leaveTicks = await watch()
  }
  await park()
  pointer.leaveWindow()

  const series = (ticks: Tick[], f: PointerValue) => ticks.map((k) => ({ t: k.t, v: k.values.get(f.key)?.[f.index] ?? NaN })).filter((k) => Number.isFinite(k.v))
  for (const f of found.filter((f) => !local.has(f)).slice(0, 6)) {
    if (motion.length >= MAX_LINES) break
    const restV = f.rest
    if (f.kind === 'flag') {
      const on = easeText(restV, series(enterTicks, f))
      if (on) motion.push(`${f.name} on enter: ${on}`)
    } else {
      const from = beforeJump.get(f.key)?.[f.index]
      const move = from === undefined ? null : easeText(from, series(jumpTicks, f))
      if (move) motion.push(`${f.name} after the pointer moves: ${move}`)
    }
    const left = beforeLeave.get(f.key)?.[f.index]
    const after = series(leaveTicks, f)
    const end = after.at(-1)?.v
    if (left === undefined || end === undefined) continue
    if (Number.isNaN(restV)) {
      const moved = Math.abs(end - left) > 1e-4 * Math.max(1, Math.abs(left))
      motion.push(`${f.name} when the pointer leaves: ${moved ? `set to ${fmt(end)}${easeText(left, after) === 'at once (no easing)' ? ' at once' : ''}` : 'keeps the last value the pointer gave it'}`)
      continue
    }
    const span = Math.abs(left - restV)
    if (span <= 1e-4 * Math.max(1, Math.abs(restV))) continue // it was at its rest value anyway
    if (Math.abs(end - restV) <= 0.1 * span) {
      const back = easeText(left, after)
      motion.push(`${f.name} when the pointer leaves: goes back to ${fmt(restV)}${back ? `, ${back}` : ''}`)
    } else {
      // It keeps the last position the pointer had over the box: where it was, or the edge it
      // crossed on its way out.
      motion.push(`${f.name} when the pointer leaves: doesn't go back to ${fmt(restV)}; it keeps the last value the pointer gave it over the ${kind} (here ${fmt(end)})`)
    }
  }
  // Values that only move while the pointer does (velocity, trails): the same at rest and wherever the
  // pointer stops, but not during the jump.
  const known = new Set(found.map((f) => `${f.key}|${f.index}`))
  for (const [key, rest] of restB) {
    if (ignore.has(key) || motion.length >= MAX_LINES) continue
    rest.forEach((restV, index) => {
      if (known.has(`${key}|${index}`)) return
      const during = jumpTicks.map((k) => k.values.get(key)?.[index]).filter((v): v is number => v !== undefined)
      const peak = during.reduce((m, v) => (Math.abs(v - restV) > Math.abs(m - restV) ? v : m), restV)
      if (Math.abs(peak - restV) <= 1e-4 * Math.max(1, Math.abs(restV))) return
      const end = during.at(-1) ?? restV
      if (Math.abs(end - restV) > 0.1 * Math.abs(peak - restV)) return
      const backAt = jumpTicks.find((k, i) => i > during.indexOf(peak) && Math.abs((k.values.get(key)?.[index] ?? restV) - restV) <= 0.1 * Math.abs(peak - restV))?.t
      motion.push(`${componentName(key, index, rest.length)} only moves while the pointer moves (velocity): ${fmt(restV)} when still, up to ${fmt(peak)} right after a quick move${backAt ? `, back after ${Math.round(backAt)} ms` : ''}`)
    })
  }
  // The pixels' timing, when no value told it (its own animation blurs it).
  if (reader?.mode === 'canvas' && !found.length) {
    const move = pixelSettle(beforeJumpPixels, jumpTicks, pixView, frameNoise)
    if (move === 'never') motion.push(`the pixels: still changing ${WATCH_MS} ms after the pointer stopped`)
    else if (move !== null) motion.push(move <= 40 ? 'the pixels: follow the pointer within a frame' : `the pixels: settle about ${Math.round(move)} ms after the pointer stops`)
    const end = leaveTicks.at(-1)?.pixels
    const moved = beforeLeavePixels && end ? (compare(beforeLeavePixels, end, pixView)?.mean ?? 0) : 0
    if (end && restRange && moved > threshold) {
      const back = (outside(restRange, end, pixView)?.mean ?? Infinity) <= threshold
      const t = pixelSettle(beforeLeavePixels, leaveTicks, pixView, frameNoise)
      motion.push(back ? `the pixels: back to the rest look ${typeof t === 'number' ? `about ${Math.round(t)} ms ` : ''}after the pointer leaves` : `the pixels: not back to the rest look ${WATCH_MS} ms after the pointer leaves (it keeps the last state, or animates on)`)
    }
  }

  // ---- where it reacts ----
  const withScore = hits.filter((s) => s.score !== null)
  const maxScore = Math.max(0, ...withScore.map((s) => s.score ?? 0))
  const strength = (s: number) => (s >= maxScore * 0.66 ? 'strong' : s >= maxScore * 0.33 ? 'medium' : 'weak')
  const dirOf = (axis: 'x' | 'y') => (axis === 'x' ? 'going left to right' : 'going top to bottom')
  const hotspots: string[] = []
  const picked: Hit[] = []
  for (const s of [...withScore].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if ((s.score ?? 0) <= threshold || hotspots.length >= 6) break
    if (picked.some((p) => Math.hypot(p.x - s.x, p.y - s.y) < 0.12)) continue
    picked.push(s)
    const c = s.change
    let where = ''
    if (c && c.area > 0.6) where = `, across most of the ${kind}`
    else if (c?.box) {
      const [x0, y0, x1, y1] = c.box
      const under = s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1
      where = `, strongest at ${pct(x0)}–${pct(x1)} across, ${pct(y0)}–${pct(y1)} down (${under ? 'around the pointer' : 'away from the pointer'})`
    }
    hotspots.push(`pointer at ${pos(s)}, ${dirOf(s.axis)}: ${strength(s.score ?? 0)} change (${fmt((s.score ?? 0) * 100)} of 100 against the look at rest${(c?.area ?? 0) >= 0.01 ? `; ${pct(c?.area ?? 0)} of the pixels changed` : ''})${where}`)
  }

  // How much the pixels changed along each stroke, as a strip: one character per stretch of it.
  let map: string[] | undefined
  if (maxScore > threshold) {
    const shades = ['░', '▒', '▓', '█']
    const strip = (axis: 'x' | 'y') => {
      const lo = axis === 'x' ? view.x0 : view.y0
      const hi = axis === 'x' ? view.x1 : view.y1
      const bins = new Array<number | null>(MAP_BINS).fill(null)
      for (const h of withScore) {
        if (h.axis !== axis) continue
        const i = clamp(Math.floor(((h[axis] - lo) / (hi - lo)) * MAP_BINS), 0, MAP_BINS - 1)
        bins[i] = Math.max(bins[i] ?? 0, h.score ?? 0)
      }
      return bins.map((s) => (s === null ? '·' : s <= threshold ? ' ' : shades[Math.min(3, Math.floor((s / maxScore) * 4))])).join('')
    }
    map = [`left → right │${strip('x')}│`, `top → bottom │${strip('y')}│`]
  }

  // The whole box getting brighter or darker with the pointer over it: the same shift wherever the
  // pointer is (a slow animation of its own drifts instead, so it doesn't pass).
  const shifts = hits.map((s) => s.shift).filter((s): s is number => s !== null)
  if (shifts.length >= 4) {
    const mean = shifts.reduce((a, b) => a + b, 0) / shifts.length
    const sd = Math.sqrt(shifts.reduce((a, b) => a + (b - mean) ** 2, 0) / shifts.length)
    if (Math.abs(mean) > MIN_CHANGE * 2 && sd < Math.abs(mean) * 0.3) {
      hotspots.unshift(`anywhere over it: the whole ${kind} gets ${mean > 0 ? 'brighter' : 'darker'} by about ${fmt(Math.abs(mean) * 100)}% than at rest`)
    }
  }

  if (!pointerLines.length && !hotspots.length) return null

  // ---- frames ----
  const frames: HoverSweepFrame[] = []
  if (restFrame) frames.push({ caption: `pointer off the ${kind} (at rest)`, dataUrl: restFrame })
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) frames.push({ caption: `pointer at ${pos(c.p)}, ${dirOf(c.axis)}`, dataUrl: c.dataUrl })

  if (outsider) notes.push(`It is not inside the section but lies under it (a page-wide background), so it was swept where the section is.`)
  if (reader?.mode === 'screen' && seen.x1 < view.x1 - 0.01) notes.push(`Its right part (${pct(seen.x1)}–${pct(view.x1)} across) was under the JevElements panel, so it was swept but its pixels there weren't read: match that part from its values and the screenshot.`)
  if (!reader) notes.push(`Its pixels couldn't be read (${canvas ? "the canvas can't be read back, and " : ''}no screenshot was available), so only its values were measured.`)
  if (!hasValues && canvas) notes.push("The page probe couldn't see the values its renderer uses (it draws in a Web Worker, started before JevElements loaded, or isn't WebGL), so only its pixels were measured. Find the pointer input in **Canvas source code**.")
  if (noise > MIN_CHANGE) notes.push(`It animates by itself (its frames at rest differ by ${fmt(noise * 100)}%), so only pixels the pointer took outside the range they have at rest count as hover.`)
  if (outOfTime) notes.push('The sweep ran out of time before every stroke was made.')

  const partial = view.y0 > 0.01 || view.y1 < 0.99 || view.x0 > 0.01 || view.x1 < 0.99
  const over = partial ? ` over the part ${outsider ? 'under the section' : 'on screen'} (${pct(view.x0)}–${pct(view.x1)} across, ${pct(view.y0)}–${pct(view.y1)} down)` : ` over the whole ${kind}`
  const how = reader?.mode === 'canvas' ? 'values and pixels read every frame as it moved' : reader ? 'values read every frame and screenshots taken as it moved' : 'values read every frame as it moved'
  const alone = parts.length ? `; then ${parts.map((p) => `\`${label(p)}\``).join(', ')} swept the same way on ${parts.length === 1 ? 'its' : 'their'} own` : ''
  return {
    target: name,
    box: { w: Math.round(box.width), h: Math.round(box.height) },
    kind,
    values: canvas ? "the canvas's renderer (WebGL and three.js uniforms, camera and objects)" : "its elements' styles (transforms, opacity, background position, SVG geometry, inline CSS custom properties)",
    measured: reader?.mode === 'canvas' ? 'read back from the canvas itself' : reader?.mode === 'screen' ? `cropped from screenshots of the tab${canvas ? ' (the canvas itself could not be read back)' : ''}` : 'not read (only its values were)',
    swept: `one continuous stroke left to right through the middle and one top to bottom${over}, ${how}${alone}`,
    pointer: pointerLines,
    idle,
    motion,
    map,
    hotspots,
    frames,
    notes,
  }
}

// ---------- what gets swept ----------

// Elements that listen for the pointer's position themselves (a tilt card, a magnetic button), as the
// page probe marked them: swept on their own, wherever they are in the section. The outermost ones.
function movers(root: Element, box: DOMRect): Element[] {
  const found = allIn(root, 6000).filter((el) => {
    if (!(el.getAttribute(PROBE_INTERACTIVE_ATTR) ?? '').split(' ').includes('move') || !visible(el)) return false
    const r = el.getBoundingClientRect()
    return r.width >= MIN_PART && r.height >= MIN_PART && r.width * r.height <= 0.5 * box.width * box.height && !!onScreen(r)
  })
  return found.filter((el) => !found.some((o) => o !== el && containsDeep(o, el)))
}

// A canvas outside the section that lies under it: a page-wide WebGL background, fixed behind the
// content, follows the pointer over this section too.
function canvasesUnder(root: Element): HTMLCanvasElement[] {
  if (root instanceof HTMLCanvasElement) return []
  const box = root.getBoundingClientRect()
  const area = box.width * Math.min(box.height, window.innerHeight)
  return Array.from(document.querySelectorAll('canvas'))
    .filter((c) => !containsDeep(root, c) && visible(c))
    .filter((c) => {
      const r = c.getBoundingClientRect()
      if (r.width < MIN_W || r.height < MIN_H) return false
      if (getComputedStyle(c).position === 'fixed' && r.width * r.height >= 0.5 * window.innerWidth * window.innerHeight) return true
      const w = Math.min(r.right, box.right) - Math.max(r.left, box.left)
      const h = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)
      return w > 0 && h > 0 && w * h >= 0.5 * area
    })
    .slice(0, 1)
}

function canvasesIn(root: Element): HTMLCanvasElement[] {
  return [root, ...allIn(root, 6000)]
    .filter((el): el is HTMLCanvasElement => el instanceof HTMLCanvasElement && visible(el))
    .map((canvas) => ({ canvas, r: canvas.getBoundingClientRect() }))
    .filter(({ r }) => r.width >= MIN_W && r.height >= MIN_H)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)
    .slice(0, MAX_CANVASES)
    .map(({ canvas }) => canvas)
}

// Every canvas in the section or under it, and the section itself when something listens for the
// pointer's position (the probe sets PROBE_POINTER_ATTR while it inspects the section), unless a
// canvas already fills most of it and no component in it listens on its own.
function targets(root: Element): Element[] {
  const canvases = canvasesIn(root)
  const under = canvasesUnder(root)
  const box = root.getBoundingClientRect()
  const area = box.width * box.height
  const covered = canvases.some((c) => {
    const r = c.getBoundingClientRect()
    return area > 0 && (r.width * r.height) / area >= CANVAS_COVERS
  })
  const follows = !!document.documentElement.getAttribute(PROBE_POINTER_ATTR)
  const section = follows && !(root instanceof HTMLCanvasElement) && box.width >= MIN_W && box.height >= MIN_H && (!covered || movers(root, box).length > 0)
  return section ? [...canvases, ...under, root] : [...canvases, ...under]
}

export function hasSweepTargets(root: Element): boolean {
  return targets(root).length > 0
}

// Nothing to sweep: drops the probe's mark, which the sweep would have removed when done.
export function endSweep() {
  document.documentElement.removeAttribute(PROBE_POINTER_ATTR)
}

export async function sweepHover(root: Element, options: SweepOptions = {}): Promise<SweepResult> {
  const result: SweepResult = { swept: 0, hovers: [] }
  const list = targets(root)
  if (!list.length) return result
  const startX = window.scrollX
  const startY = window.scrollY
  const until = now() + TOTAL_MS
  const unblock = blockRealPointer()
  try {
    for (const [i, el] of list.entries()) {
      if (options.signal?.aborted) break
      if (now() > until || !el.isConnected) continue
      const step = `Sweeping the pointer over ${label(el)}${list.length > 1 ? ` (${i + 1}/${list.length})` : ''}`
      const hover = await sweepOne(el, root, options, Math.min(until, now() + BUDGET_MS), step)
      result.swept++
      // A section whose only reaction is pixels, swept after canvases: those pixels are the canvases'.
      const canvasPixels = hover?.kind === 'section' && !hover.pointer.length && result.hovers.some((h) => h.kind === 'canvas')
      if (hover && !canvasPixels) result.hovers.push(hover)
    }
  } finally {
    unblock()
    options.onFocus?.(null)
    document.documentElement.removeAttribute(PROBE_POINTER_ATTR)
    window.scrollTo({ left: startX, top: startY, behavior: 'instant' })
  }
  return result
}

// ---------- the click sweep ----------
// Clicks where nothing is a control: over a canvas (a ripple, a burst of particles, picking a 3D
// object, a shape that links somewhere), or over the section's own background (click anywhere to
// change the color or the shape). First the pointer visits a fine grid and reads the cursor at each
// point: a canvas that turns it into a pointer over a shape it draws marks where clicking does
// something, and each such region is clicked first, inside the shape. Then a grid of points. Each
// click is a real press (down, a short hold, up, click), and a canvas is also dragged across its
// middle (rotate, pan, fling), once without the button and once with it. Points over links, buttons,
// form fields, anything with `cursor: pointer` or a click handler of its own are left out: the click
// pass plays those. Navigation and server writes are blocked while it runs (probe/guard.ts,
// probe/writes.ts): a click that tries to leave the page is recorded with where it goes, and the sweep
// goes on. Each click is followed frame by frame: the values it changes, the elements it adds (a
// ripple span), and the pixels. A click whose effect stays is clicked again, to tell a toggle from a
// one-way change. The trace shows it in amber.

const CLICK_COLS = 4
const CLICK_ROWS = 3
const CURSOR_COLS = 14
const CURSOR_ROWS = 9
const CURSOR_FRAMES = 2 // frames to wait at each point: a canvas often picks the shape under the pointer in its next frame
const MAX_CURSOR_REGIONS = 4
const CLICK_WATCH_MS = 1200
const CLICK_BUDGET_MS = 25_000 // per canvas or section
const CLICK_TOTAL_MS = 50_000
const CLICK_QUIET_AFTER = 6 // clicks in a row without a reaction before it stops
const PRESS_MS = 90 // between the button going down and up, as a finger clicks
const DRAG_MS = 900 // a drag across the middle of a canvas
const CONTROL =
  'a[href], button, input, select, textarea, label, summary, option, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="menuitem"], [contenteditable="true"], [aria-expanded], [aria-haspopup], [aria-controls]'

export interface ClickSweepResult {
  swept: number
  clicks: ClickSweep[]
  skipped: string[]
}

// A click here lands on nothing that is a control, inside the section (an overlay above a canvas is
// fine: the click reaches the page's listeners through it, as a user's would).
function freeAt(x: number, y: number, root: Element, el: Element): boolean {
  const hit = hitAt(x, y)
  if (!hit || !(hit === root || containsDeep(root, hit))) return false
  if (hit.closest(CONTROL)) return false
  if (hit !== el && getComputedStyle(hit).cursor === 'pointer') return false
  for (let node: Element | null = hit; node && node !== el && node !== root; node = parentOf(node)) {
    if ((node.getAttribute(PROBE_INTERACTIVE_ATTR) ?? '').includes('click')) return false
  }
  return true
}

// Every canvas when something could hear a click on it (a listener of its own, or one on the page or a
// wrapper), a canvas under the section from outside it when the page listens (only that hears a click
// on the section), and the section itself when a listener above it or on it could.
function clickTargets(root: Element): Element[] {
  const where = document.documentElement.getAttribute(PROBE_CLICK_ATTR)
  const canvases = [...canvasesIn(root).filter((c) => !!where || (c.getAttribute(PROBE_INTERACTIVE_ATTR) ?? '').includes('click')), ...(where === 'page' ? canvasesUnder(root) : [])]
  const box = root.getBoundingClientRect()
  const area = box.width * box.height
  const covered = canvases.some((c) => {
    const r = c.getBoundingClientRect()
    return area > 0 && (r.width * r.height) / area >= CANVAS_COVERS
  })
  const section = !!where && !covered && !(root instanceof HTMLCanvasElement) && box.width >= MIN_W && box.height >= MIN_H
  return section ? [...canvases, root] : canvases
}

export function hasClickTargets(root: Element): boolean {
  return clickTargets(root).length > 0
}

// Done with clicking: drops the probe's marks, which the click pass left for the sweeps.
export function endClickSweep(root: Element) {
  document.documentElement.removeAttribute(PROBE_CLICK_ATTR)
  root.querySelectorAll(`[${PROBE_INTERACTIVE_ATTR}]`).forEach((el) => el.removeAttribute(PROBE_INTERACTIVE_ATTR))
  root.removeAttribute(PROBE_INTERACTIVE_ATTR)
}

interface ClickTick {
  t: number // ms after the click
  values: Values
  change: number // mean pixel change from just before the click, 0–1
}

interface ClickRecord extends Point {
  before: Values
  ticks: ClickTick[]
  peak: number // the most the pixels changed (clickScore)
  peakBox: Change['box']
  lasted: number // ms the pixels stayed changed
  added: { name: string; at: number; gone?: number }[]
  toggle?: boolean // its effect stayed, and a second click undid it
}

const differs = (a: number, b: number) => Math.abs(a - b) > 1e-4 * Math.max(1, Math.abs(a))

// A part of the box where the cursor differs from the rest (a pointer over a triangle a canvas draws).
interface CursorRegion {
  cursor: string
  cells: number // grid points in it
  box: [number, number, number, number] // x0, y0, x1, y1 as fractions of the box
  inside: Point // a grid point in it, the one nearest its middle: inside the shape, not just its bounds
}

interface CursorRead {
  rest: string // the cursor over most of it
  regions: CursorRegion[]
  map: string[]
  at: (p: Point) => string | null // the cursor read at the grid point nearest p (null: not read there)
}

// Visits a fine grid and reads the cursor at each point after the page has had a frame or two to
// react to the pointer (a three.js raycast in its render loop sets `cursor` on the canvas or the body).
// The cursor is read from the swept element itself, which also inherits one set on <body>: a child's
// own `cursor: pointer` is a control the click pass plays, and those points are skipped like clicks.
async function readCursor(el: Element, root: Element, view: View, at: (p: Point) => { x: number; y: number }, pointer: VirtualPointer): Promise<CursorRead | null> {
  const cols = CURSOR_COLS
  const rows = CURSOR_ROWS
  const cw = (view.x1 - view.x0) / cols
  const ch = (view.y1 - view.y0) / rows
  const grid: (string | null)[][] = Array.from({ length: rows }, () => Array<string | null>(cols).fill(null))
  for (let j = 0; j < rows; j++) {
    for (let n = 0; n < cols; n++) {
      const i = j % 2 ? cols - 1 - n : n
      const q = at({ x: view.x0 + (i + 0.5) * cw, y: view.y0 + (j + 0.5) * ch })
      if (!freeAt(q.x, q.y, root, el)) continue
      pointer.move(q.x, q.y)
      for (let f = 0; f < CURSOR_FRAMES; f++) await nextFrame()
      grid[j][i] = getComputedStyle(el).cursor
    }
  }
  const counts = new Map<string, number>()
  for (const row of grid) for (const c of row) if (c) counts.set(c, (counts.get(c) ?? 0) + 1)
  if (!counts.size) return null
  const rest = Array.from(counts).sort((a, b) => b[1] - a[1])[0][0]
  const cellAt = (p: Point) => {
    const i = Math.min(cols - 1, Math.max(0, Math.floor((p.x - view.x0) / cw)))
    const j = Math.min(rows - 1, Math.max(0, Math.floor((p.y - view.y0) / ch)))
    return grid[j][i]
  }
  if (counts.size === 1) return { rest, regions: [], map: [], at: cellAt }

  // Connected parts with the same cursor, other than the usual one.
  const regions: CursorRegion[] = []
  const done = new Set<string>()
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cursor = grid[j][i]
      if (!cursor || cursor === rest || done.has(`${i},${j}`)) continue
      const cells: [number, number][] = []
      const stack: [number, number][] = [[i, j]]
      done.add(`${i},${j}`)
      while (stack.length) {
        const [a, b] = stack.pop()!
        cells.push([a, b])
        for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const x = a + da
          const y = b + db
          if (x < 0 || y < 0 || x >= cols || y >= rows || done.has(`${x},${y}`) || grid[y][x] !== cursor) continue
          done.add(`${x},${y}`)
          stack.push([x, y])
        }
      }
      const xs = cells.map(([a]) => a)
      const ys = cells.map(([, b]) => b)
      const mx = xs.reduce((s, v) => s + v, 0) / cells.length
      const my = ys.reduce((s, v) => s + v, 0) / cells.length
      const [ci, cj] = cells.reduce((best, c) => (Math.hypot(c[0] - mx, c[1] - my) < Math.hypot(best[0] - mx, best[1] - my) ? c : best))
      regions.push({
        cursor,
        cells: cells.length,
        box: [view.x0 + Math.min(...xs) * cw, view.y0 + Math.min(...ys) * ch, view.x0 + (Math.max(...xs) + 1) * cw, view.y0 + (Math.max(...ys) + 1) * ch],
        inside: { x: view.x0 + (ci + 0.5) * cw, y: view.y0 + (cj + 0.5) * ch },
      })
    }
  }
  regions.sort((a, b) => b.cells - a.cells)
  const map = grid.map((row, j) => `${pct(view.y0 + (j + 0.5) * ch).padStart(4)} │${row.map((c) => (c === null ? '×' : c === rest ? '·' : c === 'pointer' ? '█' : '▒')).join('')}│`)
  return { rest, regions: regions.slice(0, MAX_CURSOR_REGIONS), map, at: cellAt }
}

async function clickOne(el: Element, root: Element, { shoot, onProgress, onFocus, drawerEdge, signal }: SweepOptions, deadline: number, step: string): Promise<ClickSweep | null> {
  const kind = el instanceof HTMLCanvasElement ? 'canvas' : 'section'
  const canvas = el instanceof HTMLCanvasElement ? el : undefined
  const name = label(el)
  const right = drawerEdge?.() ?? window.innerWidth
  const placed = await place(el, root, right)
  if (!placed) return null
  const { box, view, seen, outsider } = placed
  const ctx: Context = { box, canvas, noun: kind, scrollY: window.scrollY }
  const at = (p: Point) => ({ x: box.left + p.x * box.width, y: box.top + p.y * box.height })
  const mid = (lo: number, hi: number, f: number) => lo + (hi - lo) * f
  const pointer = new VirtualPointer((x, y) => onFocus?.({ el, action: 'sweep-click', area: root, point: { x, y } }))
  const read = canvas ? () => readValues(canvas) : styleReader(el)
  const hasValues = read().size > 0
  const values = () => (hasValues ? read() : new Map<string, number[]>())
  const notes: string[] = []

  onProgress?.(`${step}: reading it before clicking`)
  const reader = await pickReader(el, shoot, right)
  const pixView = reader?.mode === 'screen' ? seen : WHOLE // what the pixels cover
  const restA = values()
  const first = reader ? await reader.read() : null
  await wait(NOISE_GAP_MS)
  const restB = values()
  const second = reader ? await reader.read() : null
  const noise = first && second ? clickScore(compare(first.pixels, second.pixels, pixView)) : 0
  const threshold = Math.max(MIN_CHANGE, noise * 2.5)
  const ignore = new Set(Array.from(restB.keys()).filter((k) => restA.get(k)?.join() !== restB.get(k)?.join()))
  const moved = (a: Values, b: Values) => Array.from(b).some(([k, v]) => !ignore.has(k) && a.get(k)?.some((x, i) => differs(x, v[i])))
  const frames: HoverSweepFrame[] = []
  const beforeFrame = second?.frame() ?? first?.frame()
  if (beforeFrame) frames.push({ caption: 'before any click', dataUrl: beforeFrame })
  const peaks: { score: number; p: Point; dataUrl: string }[] = []
  const background = canvas ? backdrop(canvas) : '#000'

  // Follows one click: values every frame, pixels every frame from a canvas, or two screenshots. The
  // button goes up PRESS_MS after it went down, while the watching goes on.
  const follow = async (p: Point, beforePixels: Pixels | null) => {
    const added: ClickRecord['added'] = []
    const nodes = new Map<Node, ClickRecord['added'][number]>()
    const start = now()
    const observer = new MutationObserver((records) => {
      const t = Math.round(now() - start)
      for (const rec of records) {
        rec.addedNodes.forEach((node) => {
          if (!(node instanceof Element) || node.closest('jev-inspector')) return
          const entry = { name: label(node), at: t }
          added.push(entry)
          nodes.set(node, entry)
        })
        rec.removedNodes.forEach((node) => {
          const entry = nodes.get(node)
          if (entry && entry.gone === undefined) entry.gone = t
        })
      }
    })
    observer.observe(root, { childList: true, subtree: true })
    observer.observe(document.body, { childList: true })
    const ticks: ClickTick[] = []
    let peak = 0
    let peakBox: Change['box'] = null
    let lasted = 0
    let peakFrame: string | undefined
    pointer.down()
    let down = true
    const shots: Promise<Reading | null>[] = reader?.mode === 'screen' ? [reader.read()] : []
    while (now() - start < CLICK_WATCH_MS) {
      await nextFrame()
      const t = now() - start
      if (down && t >= PRESS_MS) {
        pointer.up()
        down = false
      }
      const pixels = reader?.mode === 'canvas' ? reader.now() : null
      const change = pixels && beforePixels ? compare(beforePixels, pixels, pixView, p) : null
      const mean = nearScore(change)
      ticks.push({ t, values: values(), change: mean })
      if (mean > threshold) lasted = t
      if (mean > peak) {
        peak = mean
        peakBox = change?.box ?? null
        if (canvas && mean > threshold) peakFrame = jpeg(canvas, canvas.width, canvas.height, background)
      }
    }
    if (reader?.mode === 'screen') shots.push(reader.read())
    for (const [i, shot] of (await Promise.all(shots)).entries()) {
      if (!shot || !beforePixels) continue
      const change = compare(beforePixels, shot.pixels, pixView, p)
      if (!change) continue
      const score = nearScore(change)
      if (score > threshold) lasted = Math.max(lasted, i === 0 ? SHOT_GAP_MS : CLICK_WATCH_MS)
      if (score > peak) {
        peak = score
        peakBox = change.box
        peakFrame = shot.frame()
      }
    }
    observer.disconnect()
    if (peakFrame && peak > threshold) peaks.push({ score: peak, p, dataUrl: peakFrame })
    return { ticks, peak, peakBox, lasted, added }
  }

  // ---- the cursor: where it changes over it marks what a click can do there ----
  onProgress?.(`${step}: reading the cursor over it`)
  const cursorRead = await readCursor(el, root, view, at, pointer)
  const regions = cursorRead?.regions ?? []
  const regionOf = (p: Point) => regions.find((r) => p.x >= r.box[0] && p.x <= r.box[2] && p.y >= r.box[1] && p.y <= r.box[3] && cursorRead?.at(p) === r.cursor)

  const cols = CLICK_COLS
  const rows = CLICK_ROWS
  const cellW = (view.x1 - view.x0) / cols
  const cellH = (view.y1 - view.y0) / rows
  // Inside each region where the cursor changes first, then the grid, row by row back and forth.
  const points: { p: Point; cell?: string }[] = regions.map((r) => ({ p: r.inside }))
  for (let j = 0; j < rows; j++) {
    for (let n = 0; n < cols; n++) {
      const i = j % 2 ? cols - 1 - n : n
      points.push({ p: { x: view.x0 + (i + 0.5) * cellW, y: view.y0 + (j + 0.5) * cellH }, cell: `${i},${j}` })
    }
  }
  const records: ClickRecord[] = []
  const navigations: { p: Point; to: Destination }[] = []
  const scores = new Map<string, number | 'left out' | 'navigates'>()
  let quietRun = 0
  let reacted = false
  let leftOut = 0
  let stoppedBy: 'time' | 'quiet' | null = null
  for (const { p, cell } of points) {
    if (now() > deadline || !!signal?.aborted) {
      stoppedBy = 'time'
      break
    }
    const q = at(p)
    if (!freeAt(q.x, q.y, root, el)) {
      if (cell) scores.set(cell, 'left out')
      leftOut++
      continue
    }
    onProgress?.(`${step}: click ${records.length + navigations.length + 1}`)
    await pointer.travel(q.x, q.y)
    await wait(250) // what the pointer's arrival does settles first: the click is measured alone
    guard(true) // restarts the probe's safety timers, and clears what the last click tried to open
    blockWrites(true)
    const before = values()
    const beforePixels = reader ? ((await reader.read())?.pixels ?? null) : null
    const followed = await follow(p, beforePixels)
    // It tried to leave the page: the guard cancelled it. Where it goes is what this click does, so
    // it's recorded, and the sweep goes on to the next point.
    const to = blockedDestination()
    if (to) {
      navigations.push({ p, to })
      if (cell) scores.set(cell, 'navigates')
      escape()
      reacted = true
      quietRun = 0
      continue
    }
    const record: ClickRecord = { ...p, before, ...followed }
    // Its effect stayed: click again at the same point, to see whether that undoes it.
    const end = followed.ticks.at(-1)?.values ?? before
    const stayed = moved(before, end)
    if (stayed) {
      await pointer.press()
      await wait(CLICK_WATCH_MS)
      record.toggle = !moved(before, values())
    }
    records.push(record)
    const did = followed.peak > threshold || followed.added.length > 0 || stayed || followed.ticks.some((k) => moved(before, k.values))
    if (cell) scores.set(cell, followed.peak)
    reacted ||= did
    quietRun = did ? 0 : quietRun + 1
    if (!reacted && !regions.length && quietRun >= CLICK_QUIET_AFTER) {
      stoppedBy = 'quiet'
      break
    }
  }

  // ---- a drag across it (a canvas): pressed, moved left to right through the middle, released ----
  // Made twice, without the button and with it, so what the press adds (it rotates, pans or draws,
  // flings on with inertia, springs back) is told apart from what the pointer's position does anyway.
  const drag: string[] = []
  let dragged = false
  if (canvas && now() < deadline + 5000 && !signal?.aborted) {
    const y = mid(view.y0, view.y1, 0.5)
    const a = at({ x: mid(view.x0, view.x1, 0.25), y })
    const b = at({ x: mid(view.x0, view.x1, 0.75), y })
    if (freeAt(a.x, a.y, root, el) && freeAt(b.x, b.y, root, el)) {
      onProgress?.(`${step}: dragging across it`)
      const glide = async (pressed: boolean) => {
        await pointer.travel(a.x, a.y)
        await wait(300)
        guard(true)
        blockWrites(true)
        const before = values()
        if (pressed) pointer.down()
        const start = now()
        for (let f = 0; f < 1; ) {
          f = Math.min(1, (now() - start) / DRAG_MS)
          pointer.move(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f)
          await nextFrame()
        }
        const released = values()
        if (pressed) pointer.up()
        const ticks: { t: number; values: Values }[] = []
        const t0 = now()
        while (now() - t0 < CLICK_WATCH_MS) {
          await nextFrame()
          ticks.push({ t: now() - t0, values: values() })
        }
        return { before, released, ticks, after: reader ? await reader.read() : null }
      }
      const plain = await glide(false)
      const held = await glide(true)
      if (blockedDestination()) escape() // the release counted as a click on a shape that links somewhere
      dragged = true
      const span = b.x - a.x
      for (const [key, v] of held.released) {
        if (ignore.has(key)) continue
        v.forEach((rel, i) => {
          const from = held.before.get(key)?.[i]
          if (from === undefined || !differs(from, rel) || drag.length >= MAX_LINES) return
          const moved = rel - from
          const p0 = plain.before.get(key)?.[i]
          const p1 = plain.released.get(key)?.[i]
          const alone = p0 !== undefined && p1 !== undefined ? p1 - p0 : 0
          if (Math.abs(moved - alone) <= 0.2 * Math.abs(moved)) return // the pointer's position alone does that
          const series = held.ticks.map((k) => ({ t: k.t, v: k.values.get(key)?.[i] ?? NaN })).filter((k) => Number.isFinite(k.v))
          const end = series.at(-1)?.v ?? rel
          const ease = easeText(rel, series)
          const after =
            Math.abs(end - from) <= 0.1 * Math.abs(moved)
              ? `springs back to ${fmt(from)} after release${ease ? `, ${ease}` : ''}`
              : Math.abs(end - rel) > 0.1 * Math.abs(moved)
                ? `${Math.sign(end - rel) === Math.sign(moved) ? 'keeps going after release (inertia)' : 'eases partway back after release'}: ${fmt(end)} ${CLICK_WATCH_MS} ms later${ease ? `, ${ease}` : ''}`
                : 'stays where the drag left it'
          drag.push(`${componentName(key, i, v.length)}: ${fmt(from)} → ${fmt(rel)} over a ${Math.round(span)} px drag left to right (${fmt(moved / span)} per px dragged${differs(0, alone) ? `; ${fmt(alone)} with the same move without the button` : ''}); ${after}`)
        })
      }
      // The look after the drag against the look after the same move without the button.
      if (held.after && plain.after && clickScore(compare(plain.after.pixels, held.after.pixels, pixView)) > threshold) {
        if (!drag.length) drag.push('the pixels: dragging across it changes its look beyond what moving the pointer over it does (it rotates, pans or draws: compare the frames)')
        const dataUrl = held.after.frame()
        if (dataUrl) frames.push({ caption: 'just after a drag left to right across its middle', dataUrl })
      }
    }
  }
  pointer.leaveWindow()
  if (!reacted && !drag.length && !regions.length) return null

  // ---- what the values do on a click ----
  const reactions: string[] = []
  const median = (list: number[]) => [...list].sort((p, q) => p - q)[Math.floor(list.length / 2)]
  // Every value read before a click, including those the first click created (a custom property).
  const keys = new Map<string, number>()
  for (const r of [{ before: restB }, ...records]) for (const [k, v] of r.before) if (!keys.has(k)) keys.set(k, v.length)
  for (const [key, length] of keys) {
    if (ignore.has(key)) continue
    Array.from({ length }).forEach((_, index) => {
      if (reactions.length >= MAX_LINES) return
      const cname = componentName(key, index, length)
      const per = records
        .map((r) => {
          const b = r.before.get(key)?.[index]
          if (b === undefined) return null
          const series = r.ticks.map((k) => ({ t: k.t, v: k.values.get(key)?.[index] ?? b }))
          const top = series.reduce((m, s) => (Math.abs(s.v - b) > Math.abs(m.v - b) ? s : m), { t: 0, v: b })
          const end = series.at(-1)?.v ?? b
          const back = series.find((s) => s.t > top.t && Math.abs(s.v - b) <= 0.1 * Math.abs(top.v - b))?.t
          return { r, b, peak: top.v, peakT: top.t, end, back }
        })
        .filter((x): x is NonNullable<typeof x> => !!x && differs(x.b, x.peak))
      if (!per.length) return
      const pulses = per.filter((x) => Math.abs(x.end - x.b) <= 0.1 * Math.abs(x.peak - x.b))
      if (pulses.length >= per.length / 2) {
        const backs = pulses.map((x) => x.back).filter((t): t is number => t !== undefined)
        reactions.push(
          `${cname}: jumps from ${fmt(median(pulses.map((x) => x.b)))} to ${fmt(median(pulses.map((x) => x.peak)))} on each click (${Math.round(median(pulses.map((x) => x.peakT)))} ms after it), back ${backs.length ? `after about ${Math.round(median(backs))} ms` : `within ${CLICK_WATCH_MS} ms`} (a pulse)`,
        )
        return
      }
      const stays = per.filter((x) => !pulses.includes(x))
      const toggles = stays.filter((x) => x.r.toggle).length
      if (toggles >= stays.length / 2) {
        reactions.push(`${cname}: toggles on each click (${fmt(stays[0].b)} ↔ ${fmt(stays[0].end)}; a second click undoes it)`)
        return
      }
      // The same step every time (a counter, the next color): checked before the click's position,
      // since the clicks go across the grid in order and a counter would fit that too.
      const deltas = stays.map((x) => x.end - x.b)
      const step = median(deltas)
      const regular = deltas.filter((d) => Math.abs(d - step) <= 0.05 * Math.abs(step)).length
      if (stays.length > 1 && regular >= stays.length * 0.6) {
        const odd = regular < stays.length ? `; ${stays.length - regular} of ${stays.length} clicks jumped otherwise (it wraps around or resets)` : ''
        reactions.push(`${cname}: ${step > 0 ? '+' : ''}${fmt(step)} with each click, and it stays (a counter or a next step${odd})`)
        return
      }
      if (stays.length >= 4) {
        const ends = stays.map((x) => x.end)
        const linear = fit(stays.map((x) => [1, x.r.x, x.r.y]), ends)
        const order = fit(stays.map((_, k) => [1, k]), ends)
        const [a, b, c] = linear.coef
        if (linear.r2 >= LINEAR_R2 && linear.r2 - order.r2 >= 0.15 && Math.abs(b) + Math.abs(c) > 1e-3 * Math.max(1, Math.abs(a))) {
          reactions.push(`${cname} is set to where the click lands: ${linearText(cname, a, b, c, ctx).replace(`${cname}: `, '')}`)
          return
        }
      }
      reactions.push(`${cname}: changes on a click and stays (from ${fmt(stays[0].b)} to ${fmt(stays[0].end)} on the first one)`)
    })
  }

  // ---- what a click adds ----
  const added: string[] = []
  const byName = new Map<string, { n: number; lifetimes: number[]; kept: number }>()
  for (const r of records) {
    for (const a of r.added) {
      const entry = byName.get(a.name) ?? { n: 0, lifetimes: [], kept: 0 }
      entry.n++
      if (a.gone !== undefined) entry.lifetimes.push(a.gone - a.at)
      else entry.kept++
      byName.set(a.name, entry)
    }
  }
  for (const [what, { n, lifetimes, kept }] of Array.from(byName).slice(0, 8)) {
    const parts = [`added ${n} time${n === 1 ? '' : 's'} over ${records.length} clicks`]
    if (lifetimes.length) parts.push(`removed again after about ${Math.round(median(lifetimes))} ms`)
    if (kept) parts.push(`${kept} still there ${CLICK_WATCH_MS} ms later`)
    added.push(`\`${what}\`: ${parts.join(', ')}`)
  }

  // ---- where the pixels react ----
  const maxScore = Math.max(0, ...records.map((r) => r.peak))
  const hotspots: string[] = []
  for (const r of [...records].sort((a, b) => b.peak - a.peak).slice(0, 4)) {
    if (r.peak <= threshold) break
    let where = ''
    if (r.peakBox) {
      const [x0, y0, x1, y1] = r.peakBox
      const under = r.x >= x0 && r.x <= x1 && r.y >= y0 && r.y <= y1
      where = (x1 - x0) * (y1 - y0) > 0.6 ? `, across most of the ${kind}` : `, strongest at ${pct(x0)}–${pct(x1)} across, ${pct(y0)}–${pct(y1)} down (${under ? 'around the click' : 'away from the click'})`
    }
    if (!r.peakBox) where = `, a faint change spread over the ${kind}`
    hotspots.push(`click at ${pos(r)}: pixel change ${fmt(r.peak * 100)} (of 100) at its peak${where}${r.lasted ? `, changed for about ${Math.round(r.lasted)} ms` : ''}`)
  }
  let map: string[] | undefined
  if (maxScore > threshold || navigations.length) {
    const shades = ['░', '▒', '▓', '█']
    map = []
    for (let j = 0; j < rows; j++) {
      let line = ''
      for (let i = 0; i < cols; i++) {
        const s = scores.get(`${i},${j}`)
        if (s === undefined) line += '  '
        else if (s === 'left out') line += '××'
        else if (s === 'navigates') line += '↗↗'
        else if (s <= threshold) line += '··'
        else line += shades[Math.min(3, Math.floor((s / maxScore) * 4))].repeat(2)
      }
      map.push(`${pct(view.y0 + (j + 0.5) * cellH).padStart(4)} │${line}│`)
    }
  }
  for (const c of peaks.sort((a, b) => b.score - a.score).slice(0, 2)) frames.push({ caption: `at the peak of a click at ${pos(c.p)}`, dataUrl: c.dataUrl })

  // ---- the cursor, and where clicks go ----
  const cursor = regions.map((r) => {
    const [x0, y0, x1, y1] = r.box
    return `\`${r.cursor}\` over ${pct(x0)}–${pct(x1)} across, ${pct(y0)}–${pct(y1)} down (${r.cells} of the ${CURSOR_COLS * CURSOR_ROWS} points read; \`${cursorRead?.rest}\` everywhere else)`
  })
  const navigates: string[] = []
  const byDestination = new Map<string, { to: Destination; at: Point[] }>()
  for (const n of navigations) {
    const key = `${n.to.target} ${n.to.url}`
    const group = byDestination.get(key) ?? { to: n.to, at: [] }
    group.at.push(n.p)
    byDestination.set(key, group)
  }
  for (const { to, at: clicked } of byDestination.values()) {
    const region = clicked.every((p) => regionOf(p)) ? regionOf(clicked[0]) : undefined
    const where = region
      ? `where the cursor is \`${region.cursor}\` (${pct(region.box[0])}–${pct(region.box[2])} across, ${pct(region.box[1])}–${pct(region.box[3])} down)`
      : `at ${clicked.map(pos).join('; ')}`
    const stayed = records.length ? `; the other ${records.length} click${records.length === 1 ? '' : 's'} stayed on the page` : ''
    navigates.push(`a click ${where} ${goesTo(to)}${stayed}`)
  }

  if (!reactions.length && !added.length && !hotspots.length && !drag.length && !navigates.length && !cursor.length) return null
  if (stoppedBy === 'time') notes.push('The click sweep ran out of time before every point was clicked.')
  if (!hasValues && canvas) notes.push("The page probe couldn't see the values its renderer uses, so only its pixels were measured; take the click handling from **Canvas source code**.")
  if (outsider) notes.push('It is not inside the section but lies under it (a page-wide background), so it was clicked where the section is.')
  if (reader?.mode === 'screen' && seen.x1 < view.x1 - 0.01) notes.push(`Its right part (${pct(seen.x1)}–${pct(view.x1)} across) was under the JevElements panel, so it was clicked but its pixels there weren't read: match that part from its values and the screenshot.`)
  const writes = blockedWrites()
  if (writes.length) notes.push(`Clicks tried to write to the server, which was blocked: ${writes.join(', ')}.`)
  return {
    kind,
    target: name,
    box: { w: Math.round(box.width), h: Math.round(box.height) },
    values: canvas ? "the canvas's renderer (WebGL and three.js uniforms, camera and objects)" : "its elements' styles (transforms, opacity, background position, SVG geometry, inline styles and CSS custom properties)",
    measured: reader?.mode === 'canvas' ? 'read back from the canvas itself, every frame' : reader?.mode === 'screen' ? 'cropped from screenshots of the tab, twice per click' : 'not read (only its values were)',
    swept: `${records.length} click${records.length === 1 ? '' : 's'} on a ${cols}×${rows} grid${leftOut ? `; ${leftOut} point${leftOut === 1 ? '' : 's'} over links, buttons and other controls left out (××)` : ''}${stoppedBy === 'quiet' ? '; it stopped early: nothing reacted' : ''}, each followed for ${CLICK_WATCH_MS} ms${regions.length ? `; before them the cursor was read at ${CURSOR_COLS}×${CURSOR_ROWS} points, and each part where it changes was clicked inside first` : ''}${dragged ? '; then one drag left to right across its middle, pressed and released, against the same move without the button' : ''}`,
    reactions,
    drag,
    added,
    cursor: cursor.length ? cursor : undefined,
    cursorMap: cursor.length ? cursorRead?.map : undefined,
    navigates: navigates.length ? navigates : undefined,
    map,
    hotspots,
    frames,
    notes,
  }
}

export async function sweepClicks(root: Element, options: SweepOptions = {}): Promise<ClickSweepResult> {
  const result: ClickSweepResult = { swept: 0, clicks: [], skipped: [] }
  const list = clickTargets(root)
  if (!list.length) {
    endClickSweep(root)
    return result
  }
  const startX = window.scrollX
  const startY = window.scrollY
  const startHref = location.href
  const until = now() + CLICK_TOTAL_MS
  if (!guard(true) || !blockWrites(true)) {
    guard(false)
    blockWrites(false)
    endClickSweep(root)
    result.skipped.push('the click sweep (the page probe that blocks navigation and server writes was not available)')
    return result
  }
  const unblock = blockRealPointer()
  try {
    for (const [i, el] of list.entries()) {
      if (options.signal?.aborted) break
      if (now() > until || !el.isConnected) continue
      const step = `Click sweep over ${label(el)}${list.length > 1 ? ` (${i + 1}/${list.length})` : ''}`
      const click = await clickOne(el, root, options, Math.min(until, now() + CLICK_BUDGET_MS), step)
      result.swept++
      if (click) result.clicks.push(click)
      if (location.href !== startHref) break // it left the page despite the guard: stop clicking
    }
  } finally {
    unblock()
    guard(false)
    blockWrites(false)
    options.onFocus?.(null)
    endClickSweep(root)
    window.scrollTo({ left: startX, top: startY, behavior: 'instant' })
  }
  return result
}
