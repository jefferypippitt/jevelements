// Walks a DOM subtree and turns it into a Capture: everything needed to clone the section 1:1 —
// structure, exact computed styles, interaction states, responsive rules, fonts, assets, complete
// SVGs, animations (CSS, Web Animations, and JS-driven motion), and canvas/WebGL/embeds.
import type {
  Asset,
  Box,
  Capture,
  CapturedNode,
  Embed,
  FontInfo,
  InteractionReport,
  PseudoElement,
  ResponsiveRule,
  ScriptAnimation,
  ScrollStory,
  StateRule,
} from '../shared/types'
import { label, stableClasses } from '../shared/dom'
import { PROBE_ROOT_ATTR } from '../shared/runtime'
import type { HoverRule } from './hover'
import { recordInteractions, type InteractionOptions } from './interactions'
import { recordScrollMotion, type ScrollOptions } from './scroll'
import { recordSimulation, TextLog } from './timeline'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BASE', 'HEAD', 'TITLE'])

// Inherited properties are only reported where they differ from the parent.
const INHERITED = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-feature-settings',
  'font-variation-settings',
  'font-optical-sizing',
  'font-variant-numeric',
  'font-variant-caps',
  'font-variant-ligatures',
  'font-kerning',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-indent',
  'text-transform',
  'text-wrap',
  'text-rendering',
  '-webkit-font-smoothing',
  'white-space',
  'word-break',
  'overflow-wrap',
  'hyphens',
  'writing-mode',
  'direction',
  'list-style-type',
  'list-style-position',
  'cursor',
  'visibility',
  'caret-color',
  'accent-color',
  '-webkit-text-fill-color',
  '-webkit-text-stroke-width',
  '-webkit-text-stroke-color',
]

// On the captured root, inherited properties are listed only when they differ from the browser
// default, except these, which the clone always needs.
const ROOT_ALWAYS = new Set(['color', 'font-family', 'font-size', 'font-weight', 'line-height'])

// Non-inherited properties are reported where they differ from the browser default for the tag.
const OWN = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'float',
  'clear',
  'box-sizing',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-content',
  'align-self',
  'justify-self',
  'justify-items',
  'row-gap',
  'column-gap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'order',
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-flow',
  'grid-auto-rows',
  'grid-auto-columns',
  'grid-column',
  'grid-row',
  'column-count',
  'container-type',
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'background-clip',
  'background-origin',
  'background-attachment',
  'background-blend-mode',
  'border-image-source',
  'border-image-slice',
  'border-image-width',
  'border-image-outset',
  'border-image-repeat',
  'box-shadow',
  'opacity',
  'overflow-x',
  'overflow-y',
  'transform',
  'transform-origin',
  'transform-style',
  'translate',
  'rotate',
  'scale',
  'perspective',
  'perspective-origin',
  'backface-visibility',
  'transition',
  'animation',
  'animation-timeline',
  'animation-range',
  'view-timeline-name',
  'view-transition-name',
  'scroll-timeline-name',
  'filter',
  'backdrop-filter',
  'mix-blend-mode',
  'isolation',
  'clip-path',
  'mask-image',
  'mask-size',
  'mask-position',
  'mask-repeat',
  'mask-mode',
  'mask-composite',
  'shape-outside',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-color',
  'text-decoration-thickness',
  'text-underline-offset',
  'text-shadow',
  'text-overflow',
  '-webkit-line-clamp',
  'object-fit',
  'object-position',
  'aspect-ratio',
  'outline-style',
  'outline-width',
  'outline-color',
  'outline-offset',
  'vertical-align',
  'pointer-events',
  'user-select',
  'scroll-snap-type',
  'scroll-snap-align',
  'appearance',
  'list-style-image',
  'table-layout',
  'border-collapse',
  'border-spacing',
]

// Used when the computed `animation` shorthand can't express the value (e.g. with a scroll timeline).
const ANIMATION_LONGHANDS = [
  'animation-name',
  'animation-duration',
  'animation-timing-function',
  'animation-delay',
  'animation-iteration-count',
  'animation-direction',
  'animation-fill-mode',
  'animation-play-state',
]

const SIDES = ['top', 'right', 'bottom', 'left'] as const
const OFFSETS: readonly string[] = SIDES
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const

const BOX_LONGHANDS = [
  ...SIDES.map((s) => `margin-${s}`),
  ...SIDES.map((s) => `padding-${s}`),
  ...SIDES.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  ...CORNERS.map((c) => `border-${c}-radius`),
]

const LAYOUT_ONLY_FLEX_GRID = new Set([
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-content',
  'justify-items',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-flow',
  'grid-auto-rows',
  'grid-auto-columns',
])

// SVG paint properties, baked into the markup so SVGs keep their look without the site's CSS classes.
const SVG_INHERITED = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'paint-order',
  'visibility',
]
const SVG_OWN: Record<string, string> = {
  opacity: '1',
  'stop-color': 'rgb(0, 0, 0)',
  'stop-opacity': '1',
  filter: 'none',
  'clip-path': 'none',
  mask: 'none',
  'mix-blend-mode': 'normal',
  'vector-effect': 'none',
}
// Always stated on the SVG root: in the clone it sits in a different parent, so nothing may be inherited.
const SVG_ROOT_ALWAYS = new Set(['fill', 'stroke'])
const SVG_TEXT_PROPS = new Set(['font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor', 'dominant-baseline'])

const CAPTURED_ATTRS = [
  'href',
  'src',
  'srcset',
  'sizes',
  'alt',
  'title',
  'type',
  'placeholder',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-expanded',
  'aria-controls',
  'aria-current',
  'aria-selected',
  'aria-pressed',
  'data-state',
  'open',
  'target',
  'rel',
  'name',
  'value',
  'for',
  'disabled',
  'checked',
  'selected',
  'required',
  'min',
  'max',
  'step',
  'loading',
  'poster',
  'controls',
  'preload',
  'colspan',
  'rowspan',
  'datetime',
  'tabindex',
  'download',
  'data-src',
  'data-srcset',
  'data-bg',
]

const STATE_RE = /:(hover|focus-visible|focus-within|focus|active)\b/g
const PSEUDO_ELEMENT_RE = /::?(before|after|placeholder|marker|selection|first-line|first-letter|backdrop|-webkit-[\w-]+|-moz-[\w-]+)(\([^)]*\))?/g
const MAX_NODES = 1200
const MAX_HIDDEN_NODES = 300 // of MAX_NODES, for display:none content (tabs, menus, accordions)
const MAX_SIMILAR_SIBLINGS = 4
const MAX_TEXT = 4000
const MAX_SVG_ELEMENTS = 5000 // styles are baked per element; beyond this the markup is kept as-is
const MAX_RESPONSIVE_RULES = 120
const MAX_STATES_PER_NODE = 8
const MAX_AUTHORED_PER_NODE = 6
const MAX_SCRIPT_ANIMATIONS = 40
const FETCH_TIMEOUT_MS = 4000

// ---------- helpers ----------

function colorToHex(match: string, inner: string): string {
  const parts = inner.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return match
  // Computed styles always serialize as rgb(r, g, b) / rgba(r, g, b, a) with plain numbers.
  const nums = parts.map(Number)
  if (nums.some(Number.isNaN)) return match
  const [r, g, b, a = 1] = nums
  if (a === 0) return 'transparent'
  const hex = '#' + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')
  return a < 1 ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex
}

export function normalizeColors(value: string): string {
  return value.replace(/rgba?\(([^)]+)\)/g, colorToHex)
}

function collapse(values: string[]): string {
  const [t, r, b, l] = values
  if (t === r && r === b && b === l) return t
  if (t === b && r === l) return `${t} ${r}`
  if (r === l) return `${t} ${r} ${b}`
  return values.join(' ')
}

function primaryFamily(fontFamily: string): string {
  return fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')
}

function splitSelectors(selectorText: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of selectorText) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

function toMatchable(selector: string): string {
  let sel = selector.replace(PSEUDO_ELEMENT_RE, '').replace(STATE_RE, '').trim()
  if (!sel || /[>+~]$/.test(sel)) sel += '*'
  return sel
}

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector)
  } catch {
    return false
  }
}

function subtreeMatches(root: Element, selector: string): boolean {
  try {
    return root.matches(selector) || root.querySelector(selector) !== null
  } catch {
    return false
  }
}

function cssPath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur !== document.documentElement && parts.length < 5) {
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      parts.unshift(`#${cur.id}`)
      break
    }
    let part = cur.tagName.toLowerCase()
    const cls = stableClasses(cur).slice(0, 2)
    if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.')
    const parent: Element | null = cur.parentElement
    if (parent) {
      const tag = cur.tagName
      const same = Array.from(parent.children).filter((c) => c.tagName === tag)
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`
    }
    parts.unshift(part)
    cur = parent
  }
  return parts.join(' > ')
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

export function absolute(url: string, base = document.baseURI): string {
  try {
    return new URL(url, base).href
  } catch {
    return url
  }
}

// Text of the element itself. When text and inline elements are mixed ("Hello <b>world</b>"),
// the inline elements are kept as simple tags so word order survives.
function ownText(el: Element): string | undefined {
  let hasOwnText = false
  let out = ''
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent?.trim()) hasOwnText = true
      out += node.textContent ?? ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element
      if (SKIP_TAGS.has(child.tagName)) continue
      const tag = child.tagName.toLowerCase()
      out += tag === 'br' ? '\n' : `<${tag}>${child.textContent ?? ''}</${tag}>`
    }
  }
  if (!hasOwnText) return undefined
  return truncate(out.replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(), MAX_TEXT)
}

export function cssUrls(value: string): string[] {
  return Array.from(value.matchAll(/url\(["']?([^"')]+)["']?\)/g), (m) => m[1])
}

function roundBox(rect: DOMRect, originX: number, originY: number): Box {
  return {
    x: Math.round(rect.left - originX),
    y: Math.round(rect.top - originY),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  }
}

const NO_BOX: Box = { x: 0, y: 0, w: 0, h: 0 }

// Children as rendered: through open and closed shadow roots, and into slotted content.
export function childrenOf(el: Element): Element[] {
  if (el instanceof HTMLSlotElement) {
    const assigned = el.assignedElements({ flatten: true })
    return assigned.length ? assigned : Array.from(el.children)
  }
  const shadow = el instanceof HTMLElement ? (chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot) : null
  return Array.from((shadow ?? el).children)
}

function shadowRootsIn(root: Element): ShadowRoot[] {
  const out: ShadowRoot[] = []
  const visit = (el: Element) => {
    const shadow = el instanceof HTMLElement ? (chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot) : null
    if (shadow) {
      out.push(shadow)
      Array.from(shadow.children).forEach(visit)
    }
    Array.from(el.children).forEach(visit)
  }
  visit(root)
  return out
}

// ---------- browser defaults (per tag, from a clean iframe) ----------

class DefaultStyles {
  private frame: HTMLIFrameElement | null = null
  private cache = new Map<string, Record<string, string>>()

  get(tag: string): Record<string, string> {
    const cached = this.cache.get(tag)
    if (cached) return cached
    if (!this.frame) {
      this.frame = document.createElement('iframe')
      this.frame.setAttribute('aria-hidden', 'true')
      this.frame.style.cssText =
        'position:fixed;left:-10000px;top:0;width:1000px;height:1000px;visibility:hidden;pointer-events:none;border:0'
      document.documentElement.appendChild(this.frame)
    }
    const doc = this.frame.contentDocument
    const win = this.frame.contentWindow
    const result: Record<string, string> = {}
    if (doc?.body && win) {
      const probe = tag === 'svg' ? doc.createElementNS('http://www.w3.org/2000/svg', 'svg') : doc.createElement(tag)
      if (tag === 'a') probe.setAttribute('href', '#') // links only get link styles with an href
      doc.body.appendChild(probe)
      const cs = win.getComputedStyle(probe)
      for (const p of [...OWN, ...INHERITED, ...BOX_LONGHANDS, ...SVG_INHERITED]) result[p] = cs.getPropertyValue(p)
      probe.remove()
    }
    this.cache.set(tag, result)
    return result
  }

  dispose() {
    this.frame?.remove()
    this.frame = null
  }
}

// ---------- stylesheet scan ----------

interface StateSelector {
  matchable: string
  selector: string
  media: string | null
  state: string
  declarations: string
}

interface MediaStyleRule {
  media: string
  selectors: string[]
  selectorText: string
  declarations: string
}

// Rules whose authored values matter for animations: they use var(), animate, or transition.
interface AuthoredRule {
  matchable: string[]
  cssText: string
}

// Which offsets (top/right/bottom/left) a ::before/::after rule sets. Computed styles turn `auto`
// into pixels for positioned boxes, which would pin a clone to the wrong side.
interface PseudoRule {
  matchable: string
  which: '::before' | '::after'
  offsets: Set<string>
}

interface SheetScan {
  stateSelectors: StateSelector[]
  pseudoRules: PseudoRule[]
  mediaRules: MediaStyleRule[]
  authoredRules: AuthoredRule[]
  fontFaces: { family: string; cssText: string; files: string[] }[]
  keyframes: Map<string, string>
  properties: Map<string, string> // @property rules by name
  unreadable: number
}

// Reads a sheet's rules. Cross-origin sheets (CDNs) throw on cssRules unless served with CORS for
// this page, so they're fetched again and parsed into a constructable copy when the server allows it.
async function readRules(sheet: CSSStyleSheet): Promise<{ rules: CSSRuleList; base: string } | null> {
  try {
    return { rules: sheet.cssRules, base: sheet.href ?? document.baseURI }
  } catch {
    if (!sheet.href) return null
  }
  try {
    const res = await fetch(sheet.href, { credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const copy = new CSSStyleSheet({ baseURL: sheet.href })
    copy.replaceSync(await res.text())
    return { rules: copy.cssRules, base: sheet.href }
  } catch {
    return null
  }
}

async function scanStylesheets(root: Element): Promise<SheetScan> {
  const scan: SheetScan = {
    stateSelectors: [],
    pseudoRules: [],
    mediaRules: [],
    authoredRules: [],
    fontFaces: [],
    keyframes: new Map(),
    properties: new Map(),
    unreadable: 0,
  }

  const walk = (rules: CSSRuleList, media: string | null, base: string) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const declarations = normalizeColors(rule.style.cssText)
        if (!declarations) continue
        const selectors = splitSelectors(rule.selectorText)
        const offsets = new Set(OFFSETS.filter((p) => rule.style.getPropertyValue(p)))
        for (const sel of selectors) {
          const states = sel.match(STATE_RE)
          if (states) scan.stateSelectors.push({ matchable: toMatchable(sel), selector: sel, media, state: states.join(''), declarations })
          const which = /::?before\b/.test(sel) ? '::before' : /::?after\b/.test(sel) ? '::after' : null
          if (which) scan.pseudoRules.push({ matchable: toMatchable(sel), which, offsets })
        }
        if (media) scan.mediaRules.push({ media, selectors: selectors.map(toMatchable), selectorText: rule.selectorText, declarations })
        if (/var\(--|animation|@property/.test(declarations)) {
          scan.authoredRules.push({ matchable: selectors.map(toMatchable), cssText: `${rule.selectorText} { ${declarations} }` })
        }
      } else if (rule instanceof CSSMediaRule) {
        const cond = rule.conditionText
        if (/\bprint\b/.test(cond) && !/\bscreen\b/.test(cond)) continue
        const responsive = /width|height|orientation|hover|pointer|prefers/.test(cond)
        walk(rule.cssRules, responsive ? (media ? `${media} and ${cond}` : `@media ${cond}`) : media, base)
      } else if (rule instanceof CSSFontFaceRule) {
        const family = rule.style.getPropertyValue('font-family').replace(/^["']|["']$/g, '')
        const files = cssUrls(rule.style.getPropertyValue('src')).map((u) => absolute(u, base))
        const cssText = rule.cssText.replace(/url\(["']?([^"')]+)["']?\)/g, (_, u: string) => `url("${absolute(u, base)}")`)
        scan.fontFaces.push({ family, cssText, files })
      } else if (rule instanceof CSSKeyframesRule) {
        scan.keyframes.set(rule.name, rule.cssText)
      } else if (typeof CSSPropertyRule !== 'undefined' && rule instanceof CSSPropertyRule) {
        scan.properties.set(rule.name, rule.cssText)
      } else if (rule instanceof CSSImportRule) {
        try {
          if (rule.styleSheet) walk(rule.styleSheet.cssRules, media, rule.styleSheet.href ?? base)
        } catch {
          scan.unreadable++
        }
      } else if ('cssRules' in rule) {
        // @supports, @layer, @container, …
        const cond = (rule as CSSRule & { conditionText?: string }).conditionText
        const isContainer = typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule
        const next = isContainer && cond ? `@container ${cond}` : media
        walk((rule as CSSGroupingRule).cssRules, next, base)
      }
    }
  }

  // The document's sheets plus those inside shadow roots in the section (web components).
  const sheets: CSSStyleSheet[] = [...Array.from(document.styleSheets), ...document.adoptedStyleSheets]
  for (const shadow of shadowRootsIn(root)) sheets.push(...Array.from(shadow.styleSheets), ...shadow.adoptedStyleSheets)

  const read = await Promise.all(sheets.map(readRules))
  read.forEach((result, i) => {
    if (!result) return void scan.unreadable++
    const sheetMedia = sheets[i].media?.mediaText
    const media = sheetMedia && sheetMedia !== 'all' && /width|height|orientation/.test(sheetMedia) ? `@media ${sheetMedia}` : null
    walk(result.rules, media, result.base)
  })
  return scan
}

// ---------- main walk ----------

interface FontUsage {
  weights: Set<string>
  styles: Set<string>
}

interface WalkContext {
  root: Element
  originX: number
  originY: number
  count: number
  hiddenCount: number
  truncated: boolean
  defaults: DefaultStyles
  scan: SheetScan
  sprites: Map<string, Document>
  assets: Asset[]
  embeds: Embed[]
  embedHosts: WeakSet<Element>
  streams: Map<HTMLVideoElement, string>
  svgCount: number
  families: Map<string, FontUsage>
  animationNames: Set<string>
  visible: [Element, CapturedNode][] // for motion sampling
}

// Offsets that are `auto` (or a no-op 0px on a relative box) and shouldn't be listed.
function unsetOffsets(el: Element, cs: CSSStyleDeclaration, ctx: WalkContext, which?: '::before' | '::after'): Set<string> {
  const unset = new Set<string>()
  if (cs.position === 'static') return unset
  if (!which) {
    // Typed OM keeps `auto` where getComputedStyle reports the resolved pixel position.
    const map = 'computedStyleMap' in el ? (el as HTMLElement).computedStyleMap() : null
    for (const p of OFFSETS) if (map?.get(p)?.toString() === 'auto') unset.add(p)
  } else {
    const rules = ctx.scan.pseudoRules.filter((r) => r.which === which && safeMatches(el, r.matchable))
    if (rules.length) for (const p of OFFSETS) if (!rules.some((r) => r.offsets.has(p))) unset.add(p)
  }
  if (cs.position === 'relative') for (const p of OFFSETS) if (cs.getPropertyValue(p) === '0px') unset.add(p)
  return unset
}

function diffStyles(
  el: Element,
  cs: CSSStyleDeclaration,
  parentCs: CSSStyleDeclaration | null,
  defaults: Record<string, string>,
  unset: Set<string> = new Set(),
) {
  const out: Record<string, string> = {}
  const isFlexOrGrid = /flex|grid/.test(cs.display)

  for (const p of OWN) {
    const v = cs.getPropertyValue(p)
    if (!v || v === defaults[p] || unset.has(p)) continue
    if (!isFlexOrGrid && LAYOUT_ONLY_FLEX_GRID.has(p)) continue
    if (cs.position === 'static' && ['top', 'right', 'bottom', 'left', 'z-index'].includes(p)) continue
    out[p] = v
  }
  // A scroll-driven animation can't be written as the `animation` shorthand, so list its parts.
  if (cs.animationName && cs.animationName !== 'none' && !out['animation']) {
    for (const p of ANIMATION_LONGHANDS) out[p] = cs.getPropertyValue(p)
  }

  for (const p of INHERITED) {
    const v = cs.getPropertyValue(p)
    if (!v) continue
    const differs = parentCs ? v !== parentCs.getPropertyValue(p) : v !== defaults[p] || ROOT_ALWAYS.has(p)
    if (differs) out[p] = v
  }

  const sides = (fmt: (s: string) => string) => SIDES.map((s) => cs.getPropertyValue(fmt(s)))
  const margin = sides((s) => `margin-${s}`)
  if (margin.some((v, i) => v !== defaults[`margin-${SIDES[i]}`])) out['margin'] = collapse(margin)
  const padding = sides((s) => `padding-${s}`)
  if (padding.some((v, i) => v !== defaults[`padding-${SIDES[i]}`])) out['padding'] = collapse(padding)

  const borders = SIDES.map((s) => {
    const style = cs.getPropertyValue(`border-${s}-style`)
    const width = cs.getPropertyValue(`border-${s}-width`)
    if (style === 'none' || width === '0px') return 'none'
    return `${width} ${style} ${cs.getPropertyValue(`border-${s}-color`)}`
  })
  if (borders.some((b) => b !== 'none')) {
    if (borders.every((b) => b === borders[0])) out['border'] = borders[0]
    else SIDES.forEach((s, i) => borders[i] !== 'none' && (out[`border-${s}`] = borders[i]))
  }

  const radii = CORNERS.map((c) => cs.getPropertyValue(`border-${c}-radius`))
  if (radii.some((r) => r !== '0px')) out['border-radius'] = collapse(radii)

  removeComputedNoise(el, cs, out)
  for (const k of Object.keys(out)) out[k] = tidyNumbers(normalizeColors(out[k]))
  return out
}

// Computed styles report values that were never authored (resolved origins, currentColor
// derivatives, flex-item min sizes). Drop those so the spec only lists meaningful styles.
function removeComputedNoise(el: Element, cs: CSSStyleDeclaration, out: Record<string, string>) {
  if (cs.transform === 'none' && cs.rotate === 'none' && cs.scale === 'none') delete out['transform-origin']
  if (cs.perspective === 'none') delete out['perspective-origin']
  if (cs.textDecorationLine === 'none') {
    delete out['text-decoration-color']
    delete out['text-decoration-thickness']
    delete out['text-decoration-style']
  } else if (out['text-decoration-color'] === cs.color) delete out['text-decoration-color']
  if (cs.outlineStyle === 'none') {
    delete out['outline-color']
    delete out['outline-width']
    delete out['outline-offset']
  }
  if (cs.borderImageSource === 'none') {
    for (const p of ['border-image-slice', 'border-image-width', 'border-image-outset', 'border-image-repeat']) delete out[p]
  }
  if (cs.maskImage === 'none') {
    for (const p of ['mask-size', 'mask-position', 'mask-repeat', 'mask-mode', 'mask-composite']) delete out[p]
  }
  if (out['-webkit-text-fill-color'] === cs.color) delete out['-webkit-text-fill-color']
  if (out['-webkit-text-stroke-color'] === cs.color) delete out['-webkit-text-stroke-color']
  if (out['caret-color'] === cs.color) delete out['caret-color']
  if (out['min-width'] === 'auto') delete out['min-width']
  if (out['min-height'] === 'auto') delete out['min-height']
  if (el.tagName === 'svg' && out['display'] === 'inline') delete out['display']

  if (out['row-gap'] && out['row-gap'] === out['column-gap']) {
    out['gap'] = out['row-gap']
    delete out['row-gap']
    delete out['column-gap']
  }
  // Grid tracks are resolved to px. Equal columns are almost always repeat(n, 1fr);
  // resolved rows are usually just implicit auto rows, which the child sizes already describe.
  const columns = out['grid-template-columns']?.split(' ')
  if (columns && columns.length > 1 && columns.every((t) => t.endsWith('px'))) {
    if (columns.every((t) => Math.abs(parseFloat(t) - parseFloat(columns[0])) < 0.5)) {
      out['grid-template-columns'] = `repeat(${columns.length}, ${tidyNumbers(columns[0])}) /* equal columns, likely repeat(${columns.length}, 1fr) */`
    }
  }
  if (out['grid-template-rows']?.split(' ').every((t) => t.endsWith('px'))) delete out['grid-template-rows']
}

export function tidyNumbers(value: string): string {
  return value.replace(/(-?\d+\.\d{3,})(?=px|%|em|rem|deg|s\b|\b)/g, (n) => String(Math.round(parseFloat(n) * 100) / 100))
}

function noteAnimation(cs: CSSStyleDeclaration, ctx: WalkContext) {
  if (!cs.animationName || cs.animationName === 'none') return
  for (const name of cs.animationName.split(',')) ctx.animationNames.add(name.trim())
}

// ::before / ::after get the same full style diff as elements (they're often the decorative layer:
// gradient blobs, glows, masks, animated borders), measured against an inline element.
function pseudo(el: Element, which: '::before' | '::after', owner: CSSStyleDeclaration, ctx: WalkContext): PseudoElement | undefined {
  const cs = getComputedStyle(el, which)
  const content = cs.content
  if (!content || content === 'none' || content === 'normal') return undefined
  const styles = diffStyles(el, cs, owner, ctx.defaults.get('span'), unsetOffsets(el, cs, ctx, which))
  if (cs.display !== 'inline') {
    styles['width'] = tidyNumbers(cs.width)
    styles['height'] = tidyNumbers(cs.height)
  }
  noteAnimation(cs, ctx)
  const target = `${label(el)}${which}`
  for (const url of cssUrls(cs.backgroundImage)) ctx.assets.push({ kind: 'background', src: absolute(url), target, width: 0, height: 0 })
  for (const url of cssUrls(cs.maskImage)) ctx.assets.push({ kind: 'mask', src: absolute(url), target, width: 0, height: 0 })
  for (const url of cssUrls(content)) ctx.assets.push({ kind: 'image', src: absolute(url), target, width: 0, height: 0 })
  return { content: truncate(content, 500), styles }
}

function readableText(el: Element): string {
  const parts: string[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent?.trim()
    if (t) parts.push(t)
  }
  return parts.join(' ')
}

// ---------- SVG ----------

const SVG_NS = 'http://www.w3.org/2000/svg'

// Bakes the computed paint styles of every SVG element into its style attribute, so the markup
// renders the same without the site's CSS classes, including CSS animations inside the SVG.
function bakeSvgStyles(originals: Element[], copies: Element[], ctx: WalkContext) {
  const computed = new Map<Element, CSSStyleDeclaration>()
  const rootDefaults = ctx.defaults.get('svg')
  const hasText = originals.some((el) => el.tagName === 'text')
  originals.forEach((orig, i) => {
    const cs = getComputedStyle(orig)
    computed.set(orig, cs)
    const parentCs = i === 0 ? null : computed.get(orig.parentElement!) ?? null
    const decl: string[] = []
    for (const p of SVG_INHERITED) {
      if (!hasText && SVG_TEXT_PROPS.has(p)) continue
      const v = cs.getPropertyValue(p)
      if (!v) continue
      const differs = parentCs ? v !== parentCs.getPropertyValue(p) : v !== rootDefaults[p] || SVG_ROOT_ALWAYS.has(p)
      if (differs) decl.push(`${p}: ${v}`)
    }
    for (const [p, initial] of Object.entries(SVG_OWN)) {
      const v = cs.getPropertyValue(p)
      if (v && v !== initial) decl.push(`${p}: ${v}`)
    }
    const animated = cs.animationName && cs.animationName !== 'none'
    if (animated) {
      noteAnimation(cs, ctx)
      decl.push(cs.animation ? `animation: ${cs.animation}` : ANIMATION_LONGHANDS.map((p) => `${p}: ${cs.getPropertyValue(p)}`).join('; '))
    }
    if (i > 0 && (animated || (!orig.hasAttribute('transform') && cs.transform !== 'none'))) {
      if (cs.transform !== 'none') decl.push(`transform: ${cs.transform}`)
      decl.push(`transform-box: ${cs.getPropertyValue('transform-box')}`, `transform-origin: ${cs.transformOrigin}`)
    }
    if (decl.length) {
      const existing = copies[i].getAttribute('style')
      copies[i].setAttribute('style', tidyNumbers(normalizeColors([existing, ...decl].filter(Boolean).join('; '))))
    }
  })
}

// Ids referenced as url(#id), href="#id" or xlink:href="#id".
function referencedIds(el: Element): Set<string> {
  const ids = new Set<string>()
  const page = location.href.split('#')[0]
  for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
    for (const attr of Array.from(node.attributes)) {
      for (const m of attr.value.matchAll(/url\(["']?([^"')]*)#([^"')]+)["']?\)/g)) {
        if (!m[1] || m[1] === page) ids.add(m[2])
      }
      if ((attr.name === 'href' || attr.name === 'xlink:href') && attr.value.startsWith('#')) ids.add(attr.value.slice(1))
    }
  }
  return ids
}

// Makes the SVG self-contained: gradients, filters, masks, clip paths, markers and <symbol>s that
// it references from elsewhere on the page (or from an external sprite file) are copied into it.
function resolveReferences(clone: SVGSVGElement) {
  let defs = clone.querySelector(':scope > defs')
  const localId = (id: string) => clone.querySelector(`[id="${CSS.escape(id)}"]`)
  for (let pass = 0; pass < 5; pass++) {
    const missing = Array.from(referencedIds(clone)).filter((id) => !localId(id))
    if (!missing.length) break
    for (const id of missing) {
      const source = document.getElementById(id)
      if (!source || !(source instanceof SVGElement)) continue
      if (!defs) defs = clone.insertBefore(document.createElementNS(SVG_NS, 'defs'), clone.firstChild)
      defs.append(source.cloneNode(true))
    }
  }
}

// <use href="/sprite.svg#icon">: copy the symbol from the prefetched sprite file into the SVG.
function inlineExternalUses(clone: SVGSVGElement, ctx: WalkContext) {
  for (const use of Array.from(clone.querySelectorAll('use'))) {
    const ref = use.getAttribute('href') ?? use.getAttribute('xlink:href')
    if (!ref || ref.startsWith('#') || !ref.includes('#')) continue
    const [file, id] = ref.split('#')
    const sprite = ctx.sprites.get(absolute(file))
    const symbol = sprite?.getElementById(id)
    if (!symbol) continue
    let defs = clone.querySelector(':scope > defs')
    if (!defs) defs = clone.insertBefore(document.createElementNS(SVG_NS, 'defs'), clone.firstChild)
    if (!clone.querySelector(`[id="${CSS.escape(id)}"]`)) defs.append(document.importNode(symbol, true))
    use.removeAttribute('xlink:href')
    use.setAttribute('href', `#${id}`)
  }
}

function inlineSvg(svg: SVGSVGElement, ctx: WalkContext): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const originals = [svg, ...Array.from(svg.querySelectorAll('*'))]
  const copies = [clone, ...Array.from(clone.querySelectorAll('*'))]
  if (originals.length <= MAX_SVG_ELEMENTS) bakeSvgStyles(originals, copies, ctx)

  for (const script of Array.from(clone.querySelectorAll('script'))) script.remove()
  for (const image of Array.from(clone.querySelectorAll('image'))) {
    const href = image.getAttribute('href') ?? image.getAttribute('xlink:href')
    if (!href || href.startsWith('data:')) continue
    const src = absolute(href)
    image.setAttribute('href', src)
    ctx.assets.push({ kind: 'image', src, target: `${label(svg)} <image>`, width: 0, height: 0 })
  }
  inlineExternalUses(clone, ctx)
  resolveReferences(clone)
  clone.removeAttribute(PROBE_ROOT_ATTR) // set on the root while the probe inspects the page
  return clone.outerHTML.replace(/\s+/g, ' ')
}

async function fetchSprites(root: Element): Promise<Map<string, Document>> {
  const urls = new Set<string>()
  for (const use of Array.from(root.querySelectorAll('use'))) {
    const ref = use.getAttribute('href') ?? use.getAttribute('xlink:href')
    if (ref && !ref.startsWith('#') && ref.includes('#')) urls.add(absolute(ref.split('#')[0]))
  }
  const sprites = new Map<string, Document>()
  await Promise.all(
    Array.from(urls)
      .slice(0, 10)
      .map(async (url) => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
          if (res.ok) sprites.set(url, new DOMParser().parseFromString(await res.text(), 'image/svg+xml'))
        } catch {
          // Cross-origin without CORS, or the page's Trusted Types policy blocks parsing.
        }
      }),
  )
  return sprites
}

// ---------- media, embeds ----------

function collectMedia(el: Element, cs: CSSStyleDeclaration, box: Box, ctx: WalkContext) {
  const target = label(el)
  const size = { width: box.w, height: box.h }
  if (el instanceof HTMLImageElement) {
    // Lazy images keep their real URL in a data attribute and show a placeholder until they scroll
    // into view: a 1×1 data: GIF, or a tiny blurred version (LQIP) stretched to the full size.
    const shown = el.currentSrc || el.src
    const lowRes = el.complete && el.naturalWidth > 2 && box.w > 64 && el.naturalWidth * 4 < box.w
    const placeholder = !shown || shown.startsWith('data:') || (el.complete && el.naturalWidth <= 2) || lowRes
    const lazySrcset = el.getAttribute('data-srcset') ?? undefined
    const lazy = LAZY_IMAGE_ATTRS.map((a) => el.getAttribute(a)).find((v) => v) ?? (lazySrcset && largestCandidate(lazySrcset))
    const unloadedSrcset = (!shown || lowRes) && el.getAttribute('srcset') ? largestCandidate(el.getAttribute('srcset')!) : undefined
    const src = placeholder && lazy ? absolute(lazy) : placeholder && unloadedSrcset ? absolute(unloadedSrcset) : shown
    const srcset = el.getAttribute('srcset') ?? lazySrcset
    const picture = el.parentElement instanceof HTMLPictureElement ? el.parentElement : null
    const sources = picture
      ? Array.from(picture.querySelectorAll('source'), (s) => ({
          srcset: s.getAttribute('srcset') ?? s.getAttribute('data-srcset') ?? '',
          media: s.media || undefined,
          type: s.type || undefined,
        })).filter((s) => s.srcset)
      : []
    ctx.assets.push({
      kind: 'image',
      src,
      target,
      alt: el.alt,
      ...size,
      naturalWidth: el.naturalWidth || undefined,
      naturalHeight: el.naturalHeight || undefined,
      srcset,
      sources: sources.length ? sources : undefined,
    })
  } else if (el instanceof HTMLVideoElement) {
    const stream = ctx.streams.get(el)
    if (stream) ctx.assets.push({ kind: 'video', src: stream, target, ...size, via: 'ffmpeg' })
    else if (!isStreamed(el)) {
      const source = videoFile(el)
      if (source) ctx.assets.push({ kind: 'video', src: source, target, ...size })
    }
    if (el.poster) ctx.assets.push({ kind: 'poster', src: el.poster, target, ...size })
  }
  // A background on an <img> that has loaded is its blur-up placeholder (next/image placeholder="blur",
  // Gatsby, …), not part of the design.
  const blurUp = el instanceof HTMLImageElement && el.complete && el.naturalWidth > 2
  if (!blurUp) for (const url of cssUrls(cs.backgroundImage)) ctx.assets.push({ kind: 'background', src: absolute(url), target, ...size })
  for (const url of cssUrls(cs.maskImage)) ctx.assets.push({ kind: 'mask', src: absolute(url), target, ...size })
  for (const url of cssUrls(cs.borderImageSource)) ctx.assets.push({ kind: 'background', src: absolute(url), target: `${target} (border-image)`, ...size })
  const lazyBg = el.getAttribute('data-bg') ?? el.getAttribute('data-background')
  if (lazyBg) ctx.assets.push({ kind: 'background', src: absolute(lazyBg), target: `${target} (lazy background)`, ...size })
}

const LAZY_IMAGE_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-img', 'data-image']
const LAZY_VIDEO_ATTRS = ['data-src', 'data-lazy-src', 'data-video-src', 'data-video']

// The widest candidate of a srcset ("a.jpg 640w, b.jpg 1280w" → "b.jpg").
function largestCandidate(srcset: string): string | undefined {
  const candidates = srcset
    .split(/,\s+(?=\S)/)
    .map((part) => {
      const [url, size = '1x'] = part.trim().split(/\s+/)
      return { url, size: parseFloat(size) || 1 }
    })
    .filter((c) => c.url)
  return candidates.sort((a, b) => b.size - a.size)[0]?.url
}

// Media in the section as it is now. After the scroll recording, lazy images and videos that only load
// when scrolled into view have their real URLs.
export function collectSectionMedia(root: Element): Asset[] {
  const ctx = { assets: [] as Asset[], streams: new Map<HTMLVideoElement, string>() } as unknown as WalkContext
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (SKIP_TAGS.has(el.tagName) || el instanceof SVGElement) continue
    const r = el.getBoundingClientRect()
    collectMedia(el, getComputedStyle(el), { x: 0, y: 0, w: Math.round(r.width), h: Math.round(r.height) }, ctx)
  }
  return ctx.assets.filter((a) => a.src)
}

// The file to download for a <video>. An MP4 <source> wins over what Chrome chose to play (often
// WebM), since MP4 plays everywhere. Lazy videos keep their URL in a data attribute until they load.
function videoFile(el: HTMLVideoElement): string {
  const sources = Array.from(el.querySelectorAll('source'))
  const urlOf = (e: Element) => {
    const lazy = LAZY_VIDEO_ATTRS.map((a) => e.getAttribute(a)).find((v) => v)
    const src = e.getAttribute('src') ? (e as HTMLSourceElement | HTMLVideoElement).src : lazy ? absolute(lazy) : ''
    return src.startsWith('blob:') ? '' : src
  }
  const mp4 = sources.find((s) => /mp4/i.test(s.type) || /\.mp4(\?|#|$)/i.test(urlOf(s)))
  if (mp4 && urlOf(mp4)) return urlOf(mp4)
  if (el.currentSrc && !el.currentSrc.startsWith('blob:')) return el.currentSrc
  return urlOf(el) || sources.map(urlOf).find((u) => u) || ''
}

// Vimeo/YouTube iframes used as muted autoplay backgrounds are decoration: they're noted as a video
// on the element (Asset.via). Players with controls stay embeds.
function isBackgroundEmbed(src: string): boolean {
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return false
  }
  const q = url.searchParams
  if (/vimeo\.com/.test(url.hostname)) return q.get('background') === '1' || (q.get('autoplay') === '1' && q.get('controls') === '0')
  if (/youtube/.test(url.hostname)) return q.get('autoplay') === '1' && q.get('controls') === '0' && (q.get('mute') === '1' || q.get('muted') === '1')
  return false
}

const STREAM_RE = /\.(m3u8|mpd)(\?|#|$)/i

const isStreamed = (v: HTMLVideoElement) => v.currentSrc.startsWith('blob:')

// A blob: video is fed by a script (hls.js, dash.js, Mux, …) that loaded a manifest first.
// Resource timing doesn't say which video a manifest belongs to, so the page's Nth streamed
// video is matched to the Nth top-level manifest it loaded. HLS variant playlists are skipped
// by reading each one: only a master playlist lists #EXT-X-STREAM-INF renditions.
async function streamManifests(root: Element): Promise<Map<HTMLVideoElement, string>> {
  const matched = new Map<HTMLVideoElement, string>()
  const inSection = root instanceof HTMLVideoElement ? [root] : Array.from(root.querySelectorAll('video'))
  if (!inSection.some(isStreamed)) return matched

  const urls = Array.from(new Set(performance.getEntriesByType('resource').map((e) => e.name))).filter((u) => STREAM_RE.test(u))
  const masters = await Promise.all(
    urls.slice(0, 20).map(async (url) => {
      if (/\.mpd/i.test(url)) return url
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        return res.ok && (await res.text()).includes('#EXT-X-STREAM-INF') ? url : null
      } catch {
        return null // cross-origin without CORS: fall back to load order below
      }
    }),
  )
  const found = masters.filter((u): u is string => !!u)
  const manifests = found.length ? found : urls
  Array.from(document.querySelectorAll('video'))
    .filter(isStreamed)
    .forEach((video, i) => manifests[i] && matched.set(video, manifests[i]))
  return matched
}

// Video state set by script (muted autoplay loops) often isn't in the attributes.
function videoAttrs(el: HTMLVideoElement, attrs: Record<string, string>) {
  if (el.autoplay) attrs['autoplay'] = ''
  if (el.loop) attrs['loop'] = ''
  if (el.muted) attrs['muted'] = ''
  if (el.playsInline) attrs['playsinline'] = ''
  if (el.controls) attrs['controls'] = ''
}

const EMBED_IFRAMES: [RegExp, string][] = [
  [/youtube\.com|youtu\.be|youtube-nocookie/, 'YouTube video'],
  [/vimeo\.com/, 'Vimeo video'],
  [/spline\.design/, 'Spline 3D scene'],
  [/unicorn\.studio/, 'Unicorn Studio scene'],
  [/lottiefiles\.com/, 'Lottie animation'],
  [/rive\.app/, 'Rive animation'],
  [/codepen\.io/, 'CodePen demo'],
  [/figma\.com/, 'Figma embed'],
  [/google\.com\/maps|maps\.google/, 'Google Map'],
  [/loom\.com/, 'Loom video'],
]

function addEmbed(el: Element, node: CapturedNode, ctx: WalkContext, kind: string, detail: string, src?: string) {
  ctx.embeds.push({ kind, target: label(el), box: node.box, detail, src })
  ctx.embedHosts.add(el)
  node.note = `${kind}: see "Canvas, WebGL & embeds"`
}

function detectEmbed(el: Element, node: CapturedNode, ctx: WalkContext) {
  const tag = node.tag
  if (tag === 'spline-viewer') {
    return addEmbed(el, node, ctx, 'Spline 3D scene', 'Embed the same scene with the Spline runtime: the <spline-viewer> web component, or @splinetool/react-spline in React.', el.getAttribute('url') ?? undefined)
  }
  if (tag === 'lottie-player' || tag === 'dotlottie-player' || tag === 'dotlottie-wc') {
    return addEmbed(el, node, ctx, 'Lottie animation', 'Play the same animation file with lottie-web or @lottiefiles/dotlottie-web (or the matching framework wrapper).', absolute(el.getAttribute('src') ?? ''))
  }
  if (tag === 'model-viewer') {
    return addEmbed(el, node, ctx, '3D model (<model-viewer>)', 'Show the same model with the <model-viewer> web component.', absolute(el.getAttribute('src') ?? ''))
  }
  if (el.hasAttribute('data-us-project')) {
    return addEmbed(el, node, ctx, 'Unicorn Studio scene', 'A WebGL scene made in Unicorn Studio. Embed it with the Unicorn Studio SDK using this project id.', el.getAttribute('data-us-project') ?? undefined)
  }
  if (el instanceof HTMLIFrameElement) {
    const match = EMBED_IFRAMES.find(([re]) => re.test(el.src))
    if (isBackgroundEmbed(el.src)) {
      ctx.assets.push({ kind: 'video', src: el.src, target: label(el), width: node.box.w, height: node.box.h, via: 'yt-dlp' })
      return addEmbed(el, node, ctx, `${match?.[1] ?? 'Video'} (background)`, 'A muted autoplay background video from a video host. It is not a file JevElements can save: embed the same URL the same way (muted, autoplay, looping, no controls), sized to cover the area.', el.src)
    }
    return addEmbed(el, node, ctx, match?.[1] ?? 'iframe', 'Third-party content in an iframe; its inside can\'t be captured. Embed the same URL.', el.src || undefined)
  }
  if (el instanceof HTMLVideoElement && isStreamed(el)) {
    const stream = ctx.streams.get(el)
    const detail = stream
      ? 'The video is streamed by a script (HLS/DASH) from this manifest. A stream is not a file JevElements can save: play the same manifest with hls.js (or natively in Safari), or use the poster.'
      : 'The video is streamed by a script (HLS/DASH) and no manifest was found, so there is no file URL. Use the poster/screenshot, or find the stream source on the site.'
    return addEmbed(el, node, ctx, 'Streamed video', detail, stream)
  }
  if (el instanceof HTMLCanvasElement) {
    const host = (el.getRootNode() as ShadowRoot).host
    if (host && ctx.embedHosts.has(host)) return // part of an embed already described (e.g. Spline)
    const engine = el.getAttribute('data-engine') // three.js tags its canvas, e.g. "three.js r160"
    const kind = engine ? `WebGL (${engine})` : 'Canvas'
    const detail = `${el.width}×${el.height} drawing buffer${engine ? `, rendered by ${engine}` : ''}. Only its pixels are visible to the capture: the drawing code, shaders, and 3D scene can't be read.`
    const pixels = canvasPixels(el)
    if (pixels) ctx.assets.push({ kind: 'canvas', src: pixels, target: label(el), width: node.box.w, height: node.box.h })
    return addEmbed(el, node, ctx, kind, detail)
  }
}

const MAX_CANVAS_PIXELS = 16_000_000
const CANVAS_PROBE = 32

// The canvas's own pixels as a PNG at full resolution, even where it's scrolled off screen. Undefined
// when it is tainted by cross-origin images, huge, or blank: WebGL clears its buffer after every
// frame unless preserveDrawingBuffer is set. Those get a crop of the screenshot instead (inspector.ts).
function canvasPixels(canvas: HTMLCanvasElement): string | undefined {
  if (!canvas.width || !canvas.height || canvas.width * canvas.height > MAX_CANVAS_PIXELS) return undefined
  try {
    const probe = document.createElement('canvas')
    probe.width = probe.height = CANVAS_PROBE
    const g = probe.getContext('2d', { willReadFrequently: true })
    if (!g) return undefined
    g.drawImage(canvas, 0, 0, CANVAS_PROBE, CANVAS_PROBE)
    const data = new Uint32Array(g.getImageData(0, 0, CANVAS_PROBE, CANVAS_PROBE).data.buffer)
    // One color everywhere is a cleared buffer (transparent, or black without alpha), not a drawing.
    if (data.every((px) => px === data[0])) return undefined
    return canvas.toDataURL('image/png')
  } catch {
    return undefined // tainted by cross-origin images
  }
}

// ---------- animations ----------

function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

// Animations made with the Web Animations API. CSS animations and transitions are skipped: the
// element styles and @keyframes already describe them.
function collectScriptAnimations(root: Element): ScriptAnimation[] {
  const out: ScriptAnimation[] = []
  for (const anim of root.getAnimations({ subtree: true })) {
    if (out.length >= MAX_SCRIPT_ANIMATIONS) break
    if (anim instanceof CSSAnimation || anim instanceof CSSTransition) continue
    const effect = anim.effect
    if (!(effect instanceof KeyframeEffect) || !effect.target) continue
    const keyframes = effect.getKeyframes().map((frame) => {
      const { offset, computedOffset, easing, composite, ...props } = frame
      void offset
      void composite
      const values = Object.entries(props)
        .map(([k, v]) => `${kebab(k)}: ${tidyNumbers(normalizeColors(String(v)))}`)
        .join('; ')
      return `${Math.round(Number(computedOffset ?? 0) * 100)}% { ${values} }${easing && easing !== 'linear' ? ` easing ${easing}` : ''}`
    })
    const t = effect.getTiming()
    const iterations = t.iterations === Infinity ? 'infinite' : `${t.iterations ?? 1}×`
    const timing = `duration ${t.duration}ms, delay ${t.delay ?? 0}ms, ${iterations}, direction ${t.direction ?? 'normal'}, easing ${t.easing ?? 'linear'}, fill ${t.fill ?? 'auto'}`
    const timelineType = anim.timeline?.constructor.name ?? ''
    out.push({
      target: `${label(effect.target)}${effect.pseudoElement ?? ''}`,
      keyframes,
      timing,
      scrollDriven: /Scroll|View/.test(timelineType),
    })
  }
  return out
}

const PAGE_MEDIA_RE = /\.(riv|lottie|glb|gltf|bin|drc|splinecode|hdr|exr|ktx2|basis|usdz|fbx|obj|glsl|frag|vert|wgsl|m3u8|mpd|woff2?|ttf|otf)(\?|#|$)|lottie.*\.json|\.json.*lottie/i

// Files the page's scripts loaded that DOM capture can't see: 3D models, Lottie/Rive files, shaders, fonts.
function collectPageMedia(): string[] {
  const urls = performance.getEntriesByType('resource').map((e) => e.name)
  return Array.from(new Set(urls.filter((u) => PAGE_MEDIA_RE.test(u)))).slice(0, 40)
}

// ---------- walk ----------

function hasContent(el: Element): boolean {
  return readableText(el).length > 0 || !!el.querySelector('img, svg, video, picture, canvas') || el instanceof HTMLImageElement
}

function authoredRulesFor(el: Element, ctx: WalkContext): string[] {
  const out: string[] = []
  for (const rule of ctx.scan.authoredRules) {
    if (out.length >= MAX_AUTHORED_PER_NODE) break
    if (rule.matchable.some((s) => safeMatches(el, s))) out.push(rule.cssText)
  }
  return out
}

function walk(el: Element, parentCs: CSSStyleDeclaration | null, ctx: WalkContext, insideHidden = false): CapturedNode | null {
  if (SKIP_TAGS.has(el.tagName)) return null
  const cs = getComputedStyle(el)
  const hidden = insideHidden || cs.display === 'none'
  if (hidden) {
    // display:none content (inactive tabs, closed menus, accordions) is kept, within a budget,
    // when it has something to show; purely technical hidden elements are skipped.
    if (ctx.hiddenCount >= MAX_HIDDEN_NODES) return null
    if (!insideHidden && !hasContent(el)) return null
    ctx.hiddenCount++
  }

  ctx.count++
  const tag = el.tagName.toLowerCase()
  const isRoot = el === ctx.root
  let box = NO_BOX
  if (!hidden) {
    const rect = el.getBoundingClientRect()
    box = isRoot
      ? roundBox(rect, -window.scrollX, -window.scrollY) // page coordinates for the root
      : roundBox(rect, ctx.originX, ctx.originY) // relative to the captured root
  }

  const attrs: Record<string, string> = {}
  for (const name of CAPTURED_ATTRS) {
    if (!el.hasAttribute(name)) continue
    let value = el.getAttribute(name) ?? ''
    if (name === 'href' && el instanceof HTMLAnchorElement) value = el.href
    if (name === 'src' && el instanceof HTMLImageElement) value = el.currentSrc || el.src
    attrs[name] = truncate(value, 600)
  }
  if (el instanceof HTMLVideoElement) videoAttrs(el, attrs)

  const node: CapturedNode = {
    tag,
    id: el.id || undefined,
    classes: stableClasses(el).slice(0, 4),
    attrs,
    text: ownText(el),
    box,
    styles: diffStyles(el, cs, parentCs, ctx.defaults.get(tag), unsetOffsets(el, cs, ctx)),
    children: [],
  }
  if (!node.classes?.length) delete node.classes
  if (hidden && !insideHidden) node.hidden = true
  if (!hidden) ctx.visible.push([el, node])

  node.before = pseudo(el, '::before', cs, ctx)
  node.after = pseudo(el, '::after', cs, ctx)
  noteAnimation(cs, ctx)

  const states: StateRule[] = []
  for (const s of ctx.scan.stateSelectors) {
    if (states.length >= MAX_STATES_PER_NODE) break
    if (safeMatches(el, s.matchable)) states.push({ state: s.state, declarations: s.declarations })
  }
  if (states.length) node.states = states

  // For animated elements, keep the original CSS rules too: computed values resolve var(--x)
  // away, which loses animated custom properties (e.g. a rotating conic-gradient border).
  const pseudoAnimated = [node.before, node.after].some((p) => p?.styles['animation'] || p?.styles['animation-name'])
  if ((cs.animationName && cs.animationName !== 'none') || pseudoAnimated) {
    const authored = authoredRulesFor(el, ctx)
    if (authored.length) node.authored = authored
  }

  collectMedia(el, cs, box, ctx)

  if (node.text) {
    const family = primaryFamily(cs.fontFamily)
    const usage = ctx.families.get(family) ?? { weights: new Set<string>(), styles: new Set<string>() }
    usage.weights.add(cs.fontWeight)
    usage.styles.add(cs.fontStyle)
    ctx.families.set(family, usage)
  }

  if (!hidden && cs.opacity === '0') node.note = 'opacity 0 when captured: probably revealed by an entrance or scroll animation'

  if (el instanceof SVGSVGElement) {
    ctx.svgCount++
    const markup = inlineSvg(el, ctx)
    node.note = `inline SVG #${ctx.svgCount}`
    const lottie = el.querySelector('[id^="__lottie_element"], [clip-path*="__lottie_element"]')
    if (lottie) addEmbed(el, node, ctx, 'Lottie animation (rendered as SVG)', 'lottie-web draws each frame into this SVG, so the markup is one frozen frame. Play the original animation JSON instead (look for it under "Files loaded by the page\'s scripts").')
    ctx.assets.push({ kind: 'svg', src: markup, target: `SVG #${ctx.svgCount}`, width: box.w, height: box.h, alt: `SVG #${ctx.svgCount}` })
    return node
  }
  detectEmbed(el, node, ctx)
  if (el instanceof HTMLIFrameElement || el instanceof HTMLCanvasElement) return node

  const kids = childrenOf(el)
  const seen = new Map<string, number>()
  const skippedTexts: string[] = []
  let skippedSig = ''
  let skippedCount = 0

  const flushSkipped = () => {
    if (!skippedCount) return
    node.children.push({
      tag: '…',
      attrs: {},
      box: NO_BOX,
      styles: {},
      children: [],
      note: `${skippedCount} more <${skippedSig}> siblings with the same structure and styles. Their text: ${skippedTexts
        .map((t) => JSON.stringify(t))
        .join(', ')}`,
    })
    skippedCount = 0
    skippedTexts.length = 0
  }

  for (const child of kids) {
    if (ctx.count >= MAX_NODES) {
      ctx.truncated = true
      node.children.push({ tag: '…', attrs: {}, box: NO_BOX, styles: {}, children: [], note: 'node budget reached — remaining children omitted' })
      break
    }
    const sig = `${child.tagName.toLowerCase()}${stableClasses(child).length ? '.' + stableClasses(child).join('.') : ''}`
    const n = (seen.get(sig) ?? 0) + 1
    seen.set(sig, n)
    if (n > MAX_SIMILAR_SIBLINGS && child.children.length > 0) {
      skippedSig = sig
      skippedCount++
      skippedTexts.push(truncate(readableText(child), 120))
      // Still record their images so no asset is lost.
      for (const img of Array.from(child.querySelectorAll('img'))) {
        const r = img.getBoundingClientRect()
        collectMedia(img, getComputedStyle(img), roundBox(r, ctx.originX, ctx.originY), ctx)
      }
      continue
    }
    flushSkipped()
    const captured = walk(child, cs, ctx, hidden)
    if (captured) node.children.push(captured)
  }
  flushSkipped()

  return node
}

const LAYER_NODES = 300 // per alternate-state tree (Interaction.layers)

// Reads a region of the section again after a click replaced its content (a mock UI switching
// conversations, a tab panel React renders on demand): the same walk as the main tree, with the main
// capture's stylesheet scan and a smaller node budget.
export class LayerReader {
  private defaults = new DefaultStyles()
  private base: WalkContext
  // Inline SVG markup → the "SVG #n" the prompt lists it under. The media log keeps one asset per
  // markup, so an icon a layer draws again keeps the number it got first.
  private svgs = new Map<string, string>()

  constructor(base: WalkContext) {
    this.base = base
    for (const a of base.assets) if (a.kind === 'svg' && !this.svgs.has(a.src)) this.svgs.set(a.src, a.target)
  }

  // The main tree's node for an element of the section, when the main walk reached it.
  nodeOf(el: Element): CapturedNode | undefined {
    return this.base.visible.find(([e]) => e === el)?.[1]
  }

  // `budget`: nodes for this tree. A whole component in one of its states (states.ts) gets more than
  // the region a single click changed.
  read(el: Element, budget = LAYER_NODES): { tree: CapturedNode; assets: Asset[] } | null {
    const rect = this.base.root.getBoundingClientRect()
    const ctx: WalkContext = {
      ...this.base,
      originX: rect.left,
      originY: rect.top,
      count: MAX_NODES - budget,
      hiddenCount: 0,
      truncated: false,
      defaults: this.defaults,
      assets: [],
      embeds: [],
      embedHosts: new WeakSet(),
      families: new Map(),
      animationNames: new Set(),
      visible: [],
    }
    const parent = el.parentElement
    const tree = walk(el, parent ? getComputedStyle(parent) : null, ctx)
    this.base.svgCount = ctx.svgCount // "inline SVG #n" stays unique across the main tree and every layer
    if (!tree) return null
    const markup = new Map(ctx.assets.filter((a) => a.kind === 'svg').map((a) => [a.target, a.src]))
    const rename = (node: CapturedNode) => {
      const n = node.note?.match(/^inline SVG #(\d+)/)?.[1]
      const src = n && markup.get(`SVG #${n}`)
      if (src) {
        const known = this.svgs.get(src)
        if (known) node.note = node.note!.replace(/^inline SVG #\d+/, `inline ${known}`)
        else this.svgs.set(src, `SVG #${n}`)
      }
      node.children.forEach(rename)
    }
    rename(tree)
    return { tree, assets: ctx.assets.filter((a) => a.kind !== 'svg' || this.svgs.get(a.src) === a.target) }
  }

  dispose() {
    this.defaults.dispose()
  }
}

function collectFonts(families: Map<string, FontUsage>, scan: SheetScan): FontInfo[] {
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'))
    .map((l) => l.href)
    .filter((h) => /fonts\.googleapis|use\.typekit|fonts\.bunny|fontshare|fonts\.adobe/.test(h))

  return Array.from(families, ([family, usage]) => {
    const faces = scan.fontFaces.filter((f) => f.family.toLowerCase() === family.toLowerCase())
    const linked = links.filter((l) => l.toLowerCase().includes(family.toLowerCase().replace(/\s+/g, '+')))
    return {
      family,
      weights: Array.from(usage.weights).sort(),
      styles: Array.from(usage.styles).sort(),
      links: linked,
      faces: faces.map((f) => f.cssText).slice(0, 12),
      files: Array.from(new Set(faces.flatMap((f) => f.files))).slice(0, 12),
    }
  })
}

function collectResponsive(root: Element, scan: SheetScan): ResponsiveRule[] {
  const out: ResponsiveRule[] = []
  for (const rule of scan.mediaRules) {
    if (out.length >= MAX_RESPONSIVE_RULES) break
    if (rule.selectors.some((s) => subtreeMatches(root, s))) {
      out.push({ media: rule.media, selector: rule.selectorText, declarations: rule.declarations })
    }
  }
  return out
}

// @keyframes used in the section, plus the @property rules for custom properties they animate.
function collectKeyframes(names: Set<string>, scan: SheetScan, authored: string[]): string[] {
  const keyframes = Array.from(names)
    .map((name) => scan.keyframes.get(name))
    .filter((k): k is string => !!k)
  const text = [...keyframes, ...authored].join('\n')
  const properties = Array.from(scan.properties)
    .filter(([name]) => text.includes(name))
    .map(([, css]) => css)
  return [...properties, ...keyframes].map(normalizeColors)
}

export interface CaptureResult {
  capture: Capture
  // Scrolls the section through the viewport and adds `scroll` lines to the nodes that change.
  recordScroll: (options?: ScrollOptions) => Promise<ScrollStory | null>
  // Hovers and clicks the section's interactive elements and records what they change, including the
  // alternate states (layers) clicks bring up.
  recordInteractions: (options?: InteractionOptions) => Promise<InteractionReport>
}

export async function captureElement(root: Element, onPhase?: (phase: 'reading' | 'watching') => void, textLog?: TextLog): Promise<CaptureResult> {
  onPhase?.('reading')
  const rootRect = root.getBoundingClientRect()
  const defaults = new DefaultStyles()
  const [scan, sprites, streams] = await Promise.all([scanStylesheets(root), fetchSprites(root), streamManifests(root)])
  // Big sites have thousands of hover/pseudo rules; keep only those that match inside the section.
  const inSection = (selector: string) => subtreeMatches(root, selector)
  scan.stateSelectors = scan.stateSelectors.filter((r) => inSection(r.matchable))
  scan.pseudoRules = scan.pseudoRules.filter((r) => inSection(r.matchable))
  scan.authoredRules = scan.authoredRules.filter((r) => r.matchable.some(inSection))
  const hoverRules: HoverRule[] = scan.stateSelectors.filter((r) => r.state.includes(':hover')).map(({ selector, media, declarations }) => ({ selector, media, declarations }))

  const ctx: WalkContext = {
    root,
    originX: rootRect.left,
    originY: rootRect.top,
    count: 0,
    hiddenCount: 0,
    truncated: false,
    defaults,
    scan,
    sprites,
    assets: [],
    embeds: [],
    embedHosts: new WeakSet(),
    streams,
    svgCount: 0,
    families: new Map(),
    animationNames: new Set(),
    visible: [],
  }

  try {
    const tree = walk(root, null, ctx)!
    const animations = collectScriptAnimations(root)
    onPhase?.('watching')
    const moved = new Set<Element>() // changed by itself during the idle watch
    const simulation = await recordSimulation(root, ctx.visible, textLog, moved)

    const authored: string[] = []
    const gather = (n: CapturedNode) => {
      if (n.authored) authored.push(...n.authored)
      n.children.forEach(gather)
    }
    gather(tree)

    // De-duplicate assets by kind + src, keeping the first. An inline SVG drawn again (the same icon on
    // three buttons) is referred to by the number it got first, the one that stays listed.
    const firstSvg = new Map<string, string>()
    for (const a of ctx.assets) if (a.kind === 'svg' && !firstSvg.has(a.src)) firstSvg.set(a.src, a.target)
    const svgSrc = new Map(ctx.assets.filter((a) => a.kind === 'svg').map((a) => [a.target, a.src]))
    const renumber = (node: CapturedNode) => {
      const n = node.note?.match(/^inline SVG #(\d+)/)?.[1]
      const first = n ? firstSvg.get(svgSrc.get(`SVG #${n}`) ?? '') : undefined
      if (first && first !== `SVG #${n}`) node.note = node.note!.replace(/^inline SVG #\d+/, `inline ${first}`)
      node.children.forEach(renumber)
    }
    renumber(tree)
    const listed = new Set<string>()
    const assets = ctx.assets.filter((a) => {
      if (!a.src || listed.has(a.kind + a.src)) return false
      listed.add(a.kind + a.src)
      return true
    })

    const capture: Capture = {
      id: crypto.randomUUID(),
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      selector: cssPath(root),
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      root: tree,
      assets,
      fonts: collectFonts(ctx.families, scan),
      responsive: collectResponsive(root, scan),
      keyframes: collectKeyframes(ctx.animationNames, scan, authored),
      animations,
      libraries: [],
      embeds: ctx.embeds,
      pageMedia: collectPageMedia(),
      nodeCount: ctx.count,
      hiddenNodes: ctx.hiddenCount,
      truncated: ctx.truncated,
      unreadableStylesheets: scan.unreadable,
      simulation,
    }
    return {
      capture,
      recordScroll: (options) => recordScrollMotion(root, ctx.visible, options),
      recordInteractions: async (options) => {
        const layers = new LayerReader(ctx)
        try {
          return await recordInteractions(root, ctx.visible, hoverRules, layers, options, moved)
        } finally {
          layers.dispose()
        }
      },
    }
  } finally {
    defaults.dispose()
  }
}
