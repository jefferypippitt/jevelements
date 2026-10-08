// The section under both OS colour schemes, emulated inside the page (no DevTools Protocol, so Chrome
// shows no "started debugging this browser" bar): every `prefers-color-scheme` condition the page's
// CSS has (@media and @import rules, <link>/<style> media, <picture> sources) is decided for the
// emulated scheme, the probe makes matchMedia answer the page's scripts for it (probe/scheme.ts), and
// a root that declares `color-scheme: light dark` is pinned to it, so light-dark() and form controls
// follow. Cross-origin stylesheets can't be edited, so one that has such conditions is fetched again
// and stands in, as an editable copy, for the original while the check runs.
//
// The scheme is emulated light, then dark, then light again. Each pass reads the colour properties of
// every element and screenshots the visible part of the section left of the drawer (which stays on
// screen); the second light pass is the
// baseline for what moves by itself (a marquee, a canvas), so only what dark mode alone changes is
// reported. The real pointer can't be moved without the DevTools Protocol, so a hover stays the same
// in all three passes and cancels out.
import { label } from '../shared/dom'
import { fromBase64 } from '../shared/files'
import { emulateColorScheme, mentionsColorScheme, PROBE_SCHEME_ATTR, PROBE_SCHEME_EVENT } from '../shared/runtime'
import type { Asset, SchemeCheck } from '../shared/types'
import { normalizeColors, shadowRootsIn, tidyNumbers } from './extract'

const PROPS = ['filter', 'color', 'background-color', 'background-image', 'opacity', 'fill', 'stroke']
const MAX_ELEMENTS = 1500
const MAX_DIFFERENCES = 40
const SETTLE_MS = 400 // after a switch: matchMedia listeners run, classes flip, styles recompute
const TRANSITION_WAIT_MS = 1500 // theme transitions are usually 150–300ms
const IMAGE_WAIT_MS = 2000 // a <picture> that switched to its dark source loads it
const FETCH_TIMEOUT_MS = 4000
const COMPARE_WIDTH = 320 // shots are compared at this width
const PIXEL_DELTA = 24 // per channel (0–255): a smaller change is noise
const MIN_CHANGED = 0.002 // share of pixels that must change before the shots count as different

type Scheme = 'light' | 'dark'
type Rect = { x: number; y: number; w: number; h: number }
// A screenshot of a viewport rect, and where the drawer starts (shots stay left of it).
export interface Shoot {
  take: (rect: Rect) => Promise<string | undefined>
  right: () => number
}

interface Pass {
  values: string[][] // per element: PROPS, then an <img>'s currentSrc
  page: string[] // <html> class, data-theme, color-scheme
  shot?: string
}

const PAGE_FIELDS = ['`<html>` class', '`<html>` data-theme', '`<html>` color-scheme']

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- emulation ----------

// A media query that mentions the OS colour scheme, as the page wrote it, and how to change it.
interface Slot {
  original: string
  set: (media: string) => void
}

class Emulation {
  private slots: Slot[] = []
  private undo: (() => void)[] = []
  private pinned: string | null = null // the root's color-scheme while it is pinned
  unread = 0 // cross-origin sheets with colour-scheme conditions that couldn't be fetched
  scripts = false // the probe emulates the scheme for the page's scripts too

  static async start(root: Element): Promise<Emulation> {
    const emulation = new Emulation()
    await emulation.collect(root)
    emulation.pinRoot()
    return emulation
  }

  apply(scheme: Scheme) {
    for (const slot of this.slots) slot.set(emulateColorScheme(slot.original, scheme))
    if (this.pinned !== null) document.documentElement.style.setProperty('color-scheme', scheme, 'important')
    document.dispatchEvent(new CustomEvent(PROBE_SCHEME_EVENT, { detail: scheme }))
    this.scripts = document.documentElement.getAttribute(PROBE_SCHEME_ATTR) === scheme
  }

  stop() {
    document.dispatchEvent(new CustomEvent(PROBE_SCHEME_EVENT, { detail: 'off' }))
    for (const slot of this.slots) slot.set(slot.original)
    for (const undo of this.undo.reverse()) undo()
  }

  // The color-scheme the page declared, unchanged by pinning it.
  declaredScheme(): string | null {
    return this.pinned
  }

  private slot(list: MediaList) {
    const original = list.mediaText
    if (mentionsColorScheme(original)) this.slots.push({ original, set: (media) => (list.mediaText = media) })
  }

  private attributeSlot(el: Element) {
    const original = el.getAttribute('media')
    if (original !== null && mentionsColorScheme(original)) this.slots.push({ original, set: (media) => el.setAttribute('media', media) })
  }

  private walk(rules: CSSRuleList, imports: string[]) {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSImportRule) {
        this.slot(rule.media)
        const sheet = rule.styleSheet
        if (!sheet) continue
        let inner: CSSRuleList | null = null
        try {
          inner = sheet.cssRules
        } catch {
          if (sheet.href) imports.push(sheet.href)
        }
        if (inner) this.walk(inner, imports)
      } else if (rule instanceof CSSMediaRule) {
        this.slot(rule.media)
        this.walk(rule.cssRules, imports)
      } else if ('cssRules' in rule) {
        this.walk((rule as CSSGroupingRule).cssRules, imports) // @supports, @layer, @container, nesting
      }
    }
  }

  private async collect(root: Element) {
    const scopes: (Document | ShadowRoot)[] = [document, ...shadowRootsIn(root)]
    const imports: string[] = []
    const copies: Promise<void>[] = []
    for (const scope of scopes) {
      for (const sheet of Array.from(scope.styleSheets)) {
        if (sheet.disabled) continue
        if (sheet.ownerNode instanceof Element) this.attributeSlot(sheet.ownerNode)
        let rules: CSSRuleList | null = null
        try {
          rules = sheet.cssRules
        } catch {
          if (sheet.href) copies.push(this.standIn(scope, sheet, sheet.href))
        }
        if (rules) this.walk(rules, imports)
      }
      for (const sheet of scope.adoptedStyleSheets) this.walk(sheet.cssRules, imports)
    }
    root.querySelectorAll('picture > source[media]').forEach((source) => this.attributeSlot(source))
    await Promise.all(copies)
    // A cross-origin @import can't be swapped for a copy in its place: it's only counted when it has
    // conditions the emulation misses.
    const missed = await Promise.all(imports.map(async (href) => mentionsColorScheme((await fetchCss(href)) ?? '')))
    this.unread += missed.filter(Boolean).length
  }

  // A cross-origin sheet with colour-scheme conditions: disabled while an editable copy (fetched again,
  // urls resolved against the original) takes its place, after the scope's other sheets.
  private async standIn(scope: Document | ShadowRoot, sheet: CSSStyleSheet, href: string) {
    const text = await fetchCss(href)
    if (text === null) {
      this.unread++
      return
    }
    if (!mentionsColorScheme(text)) return
    const copy = new CSSStyleSheet({ baseURL: href })
    try {
      copy.replaceSync(text)
    } catch {
      this.unread++
      return
    }
    this.walk(copy.cssRules, [])
    sheet.disabled = true
    scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, copy]
    this.undo.push(() => {
      sheet.disabled = false
      scope.adoptedStyleSheets = scope.adoptedStyleSheets.filter((s) => s !== copy)
    })
  }

  // `color-scheme: light dark` (or the color-scheme <meta>) lets the OS pick the used scheme for
  // light-dark(), system colours and form controls: pinned to the emulated one for each pass.
  private pinRoot() {
    const html = document.documentElement
    const declared = getComputedStyle(html).colorScheme
    const meta = document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? ''
    const both = (value: string) => /\blight\b/.test(value) && /\bdark\b/.test(value)
    if (!both(declared) && !(declared === 'normal' && both(meta))) return
    this.pinned = declared
    const value = html.style.getPropertyValue('color-scheme')
    const priority = html.style.getPropertyPriority('color-scheme')
    this.undo.push(() => (value ? html.style.setProperty('color-scheme', value, priority) : html.style.removeProperty('color-scheme')))
  }
}

async function fetchCss(href: string): Promise<string | null> {
  try {
    const res = await fetch(href, { credentials: 'omit', cache: 'force-cache', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

// ---------- passes ----------

function show(value: string): string {
  const v = tidyNumbers(normalizeColors(value)).replace(/\s+/g, ' ').trim()
  return v.length > 90 ? `${v.slice(0, 89)}…` : v || '(none)'
}

function read(el: Element): string[] {
  const cs = getComputedStyle(el)
  const values = PROPS.map((p) => cs.getPropertyValue(p))
  if (el instanceof HTMLImageElement) values.push(el.currentSrc || el.src)
  return values
}

function pageState(declaredScheme: string | null): string[] {
  const html = document.documentElement
  return [html.getAttribute('class') ?? '', html.getAttribute('data-theme') ?? '', declaredScheme ?? getComputedStyle(html).colorScheme]
}

// Waits for the switch to land: a frame, the page's own listeners, then any CSS transition it started
// and any image a <picture> switched to.
async function settle(root: Element) {
  await nextFrame()
  await nextFrame()
  await wait(SETTLE_MS)
  const until = performance.now() + TRANSITION_WAIT_MS
  while (performance.now() < until && root.getAnimations({ subtree: true }).some((a) => a instanceof CSSTransition && a.playState === 'running')) {
    await wait(50)
  }
  const images = Array.from(root.querySelectorAll('img')).filter((img) => !img.complete)
  const loaded = (img: HTMLImageElement) =>
    new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
    })
  if (images.length) await Promise.race([Promise.all(images.map(loaded)), wait(IMAGE_WAIT_MS)])
}

// The part of the section inside the viewport and left of the drawer (the screenshot sees only that).
function visibleRect(root: Element, right = window.innerWidth): Rect | null {
  const r = root.getBoundingClientRect()
  const x = Math.max(0, r.left)
  const y = Math.max(0, r.top)
  const w = Math.min(right, r.right) - x
  const h = Math.min(window.innerHeight, r.bottom) - y
  return w >= 1 && h >= 1 ? { x, y, w, h } : null
}

async function pass(emulation: Emulation, scheme: Scheme, root: Element, elements: Element[], shoot: Shoot): Promise<Pass> {
  const focused = document.activeElement
  if (focused && focused !== document.body && 'blur' in focused) (focused as HTMLElement).blur()
  emulation.apply(scheme)
  await settle(root)
  const values = elements.map(read)
  const rect = visibleRect(root, shoot.right())
  const shot = rect ? await shoot.take(rect) : undefined
  return { values, page: pageState(emulation.declaredScheme()), shot }
}

async function pixels(dataUrl: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const comma = dataUrl.indexOf(',')
  const bitmap = await createImageBitmap(new Blob([fromBase64(dataUrl.slice(comma + 1))], { type: 'image/png' }))
  const w = Math.min(COMPARE_WIDTH, bitmap.width)
  const h = Math.max(1, Math.round((bitmap.height * w) / bitmap.width))
  const canvas = new OffscreenCanvas(w, h)
  const g = canvas.getContext('2d', { willReadFrequently: true })!
  g.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return { data: g.getImageData(0, 0, w, h).data, w, h }
}

// Share of pixels that changed between two shots (1 when their sizes differ: the layout moved).
async function changed(a: string, b: string): Promise<number> {
  const [pa, pb] = await Promise.all([pixels(a), pixels(b)])
  if (pa.w !== pb.w || pa.h !== pb.h) return 1
  let count = 0
  for (let i = 0; i < pa.data.length; i += 4) {
    const delta = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]), Math.abs(pa.data[i + 3] - pb.data[i + 3]))
    if (delta > PIXEL_DELTA) count++
  }
  return count / (pa.w * pa.h)
}

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`

// What the in-page emulation couldn't reach, for the prompt.
function partialNote(emulation: Emulation): string | undefined {
  const notes: string[] = []
  if (emulation.unread) notes.push(`${emulation.unread} cross-origin stylesheet(s) with \`prefers-color-scheme\` rules couldn't be read, so those rules kept following the real OS`)
  if (!emulation.scripts) notes.push("the page's scripts weren't told about the emulated scheme (reload the page and capture again)")
  return notes.length ? notes.join('; ') : undefined
}

export async function compareSchemes(root: Element, shoot: Shoot): Promise<SchemeCheck> {
  const [startX, startY] = [window.scrollX, window.scrollY]
  if (!visibleRect(root)) root.scrollIntoView({ block: 'nearest' })
  let emulation: Emulation | null = null
  try {
    emulation = await Emulation.start(root)
    const elements = [root, ...Array.from(root.querySelectorAll('*'))].filter((el) => el.getClientRects().length).slice(0, MAX_ELEMENTS)
    const light = await pass(emulation, 'light', root, elements, shoot)
    const dark = await pass(emulation, 'dark', root, elements, shoot)
    const again = await pass(emulation, 'light', root, elements, shoot)

    // What dark mode alone changes: different in dark, the same in both light passes.
    const differences: string[] = []
    const media: Asset[] = []
    PAGE_FIELDS.forEach((field, i) => {
      if (light.page[i] !== dark.page[i] && light.page[i] === again.page[i]) differences.push(`${field}: ${show(light.page[i])} → ${show(dark.page[i])}`)
    })
    elements.forEach((el, j) => {
      const [l, d, l2] = [light.values[j], dark.values[j], again.values[j]]
      l.forEach((value, k) => {
        if (value === d[k] || value !== l2[k] || differences.length >= MAX_DIFFERENCES) return
        const prop = PROPS[k] ?? 'src'
        if (prop === 'src') {
          differences.push(`\`${label(el)}\` shows another file: ${d[k]} (light: ${value})`)
          const box = el.getBoundingClientRect()
          media.push({ kind: 'image', src: d[k], target: label(el), width: Math.round(box.width), height: Math.round(box.height), when: 'in OS dark mode' })
        } else differences.push(`\`${label(el)}\` ${prop}: ${show(value)} → ${show(d[k])}`)
      })
    })

    let pixelsNote: string | undefined
    let pixelsDiffer = false
    if (light.shot && dark.shot && again.shot) {
      const [schemeShare, baseShare] = await Promise.all([changed(light.shot, dark.shot), changed(light.shot, again.shot)])
      pixelsDiffer = schemeShare > MIN_CHANGED && schemeShare > baseShare * 3 + MIN_CHANGED
      pixelsNote = `${percent(schemeShare)} of the section's on-screen pixels changed between the light and dark shots, and ${percent(baseShare)} between two light shots, which is what moves by itself`
    }
    const differs = differences.length > 0 || pixelsDiffer
    return {
      differs,
      differences,
      pixels: pixelsNote,
      partial: partialNote(emulation),
      shots: differs && light.shot && dark.shot ? { light: light.shot, dark: dark.shot } : undefined,
      media: media.length ? media : undefined,
    }
  } catch (err) {
    return { differs: false, differences: [], error: err instanceof Error ? err.message : String(err) }
  } finally {
    emulation?.stop()
    window.scrollTo(startX, startY)
  }
}
