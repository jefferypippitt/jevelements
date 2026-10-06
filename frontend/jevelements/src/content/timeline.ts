// Watches a captured section while the page sits idle and records what a script actually changes:
// text, classes, media src, added or removed nodes, and computed styles. Works for any site —
// GSAP, Motion, a custom rAF loop, or a mock UI that swaps its own copy.
import { label } from '../shared/dom'
import type { CapturedNode, Simulation, SimulationEvent, TextAnimation } from '../shared/types'
import { normalizeColors, tidyNumbers } from './extract'

const DURATION_MS = 4000
const SAMPLES = 4 // one snapshot up front, then one per interval
const MAX_STYLE_ELEMENTS = 400
const MAX_TEXT_ELEMENTS = 250
const MAX_EVENTS = 80
const MAX_TEXT_SERIES = 300 // elements whose text is followed mutation by mutation
const MAX_SERIES_POINTS = 400
const MAX_TEXT_ANIMATIONS = 24
const STYLE_PROPS = ['transform', 'translate', 'rotate', 'scale', 'opacity', 'filter', 'clip-path', 'background-position', 'stroke-dashoffset', 'color', 'background-color', 'width', 'height']
export const WATCHED_ATTRS = ['class', 'src', 'srcset', 'poster', 'href', 'hidden', 'open', 'aria-hidden', 'aria-expanded', 'data-state']

export function clip(value: string, max = 160): string {
  const v = value.replace(/\s+/g, ' ').trim()
  return v.length > max ? `${v.slice(0, max - 1)}…` : v
}

function showStyle(value: string): string {
  return clip(tidyNumbers(normalizeColors(value)), 80)
}

export function directText(el: Element): string {
  let s = ''
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) s += node.textContent ?? ''
  }
  return clip(s)
}

export function nodeText(node: Node): string {
  if (node instanceof Element) return clip(node.textContent ?? '', 80)
  return clip(node.textContent ?? '', 80)
}

type TextPoint = { t: number; text: string } // t: performance.now()

// Text edits anywhere on the page, from the moment the picker opens. Count-ups and typing often play
// once, when the section scrolls into view: by the time it's clicked they have finished, so the idle
// watch alone would only see the last step. Only edits to text are logged (characterData, or text
// nodes swapped), not elements coming and going.
export class TextLog {
  private series = new Map<Element, TextPoint[]>()
  private observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'childList' && ![...Array.from(rec.addedNodes), ...Array.from(rec.removedNodes)].every((n) => n.nodeType === Node.TEXT_NODE)) continue
      const el = rec.target instanceof Element ? rec.target : rec.target.parentElement
      if (el && !el.closest('jev-inspector')) this.track(el)
    }
  })

  start() {
    this.observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  }

  stop() {
    this.observer.disconnect()
  }

  track(el: Element, first?: string) {
    let points = this.series.get(el)
    if (!points) {
      if (this.series.size >= MAX_TEXT_SERIES) return
      points = first === undefined ? [] : [{ t: performance.now(), text: first }]
      this.series.set(el, points)
    }
    const text = clip(el.textContent ?? '', 400)
    if (text !== points.at(-1)?.text && points.length < MAX_SERIES_POINTS) points.push({ t: performance.now(), text })
  }

  // Starts from another log's entries (the picker-time log, for the captured section).
  seed(entries: Map<Element, TextPoint[]>) {
    for (const [el, points] of entries) this.series.set(el, [...points])
  }

  within(root: Element): Map<Element, TextPoint[]> {
    return new Map(Array.from(this.series).filter(([el]) => el === root || root.contains(el)))
  }
}

interface Bucket {
  target: string
  change: string
  t: number
}

function styleSnapshot(el: Element): string[] {
  const cs = getComputedStyle(el)
  return STYLE_PROPS.map((p) => cs.getPropertyValue(p))
}

// CSS and WAAPI animations are already described from stylesheets and getAnimations().
// Style sampling is for libraries that write inline styles every frame.
function applyStyleMotion(visible: [Element, CapturedNode][], frames: string[][][]) {
  visible.forEach(([, node], j) => {
    const samples = frames[j]
    if (!samples) return
    const changes: string[] = []
    STYLE_PROPS.forEach((prop, k) => {
      const values = Array.from(new Set(samples.map((frame) => showStyle(frame[k] ?? ''))))
      if (values.length > 1) changes.push(`${prop}: ${values.slice(0, 3).join(' → ')}${values.length > 3 ? ' → …' : ''}`)
    })
    if (changes.length) node.motion = changes
  })
}

// `moved` collects the elements that changed while the page sat idle (children, attributes, text), so
// the state explorer can tell a demo that plays itself, and a click's changes from the page's own.
export async function recordSimulation(root: Element, visible: [Element, CapturedNode][], earlier?: TextLog, moved?: Set<Element>): Promise<Simulation> {
  const started = performance.now()
  const seconds = () => Math.round(((performance.now() - started) / 1000) * 10) / 10
  const buckets = new Map<string, Bucket>()

  const note = (key: string, target: string, change: string, t: number) => {
    if (!change) return
    const prev = buckets.get(key)
    if (!prev) buckets.set(key, { target, change, t })
    else {
      prev.change = change
      prev.t = t
    }
  }

  const textOf = new Map<Element, string>()
  for (const [el] of visible) {
    if (textOf.size >= MAX_TEXT_ELEMENTS) break
    const text = directText(el)
    if (text) textOf.set(el, text)
  }

  // Every text change, timestamped, per element: typing, counters and scrambles change many times a
  // second, which the once-a-second samples below would collapse into one "before → after". The log
  // starts with what the page did while the picker was open (see TextLog).
  const log = new TextLog()
  if (earlier) log.seed(earlier.within(root))
  const baseline = new Map<Element, string>()
  for (const [el] of visible) if (el.textContent?.trim()) baseline.set(el, clip(el.textContent, 400))
  const track = (el: Element) => log.track(el, baseline.get(el))

  const observer = new MutationObserver((records) => {
    const t = seconds()
    for (const rec of records) {
      const el = rec.target instanceof Element ? rec.target : rec.target.parentElement
      if (!el || (el !== root && !root.contains(el))) continue
      // Only edits to the text itself: elements coming and going (a chat list scrolling by) are
      // structure, reported as children added/removed below.
      const textOnly = rec.type === 'childList' && [...Array.from(rec.addedNodes), ...Array.from(rec.removedNodes)].every((n) => n.nodeType === Node.TEXT_NODE)
      if (rec.type === 'characterData' || textOnly) track(el)
      moved?.add(el)
      if (rec.type === 'characterData') continue
      // Inline styles that scripts animate (GSAP, Motion) are only noted as moving by themselves; the
      // style samples below describe the motion.
      if (rec.attributeName === 'style') continue
      const target = label(el)
      if (rec.type === 'attributes' && rec.attributeName) {
        const next = el.getAttribute(rec.attributeName) ?? ''
        const prev = rec.oldValue ?? ''
        if (clip(prev) === clip(next)) continue
        note(`attr:${target}:${rec.attributeName}`, target, `${rec.attributeName} ${JSON.stringify(clip(prev, 80))} → ${JSON.stringify(clip(next, 80))}`, t)
      } else if (rec.type === 'childList' && (rec.addedNodes.length || rec.removedNodes.length)) {
        const added = Array.from(rec.addedNodes).map(nodeText).filter(Boolean).slice(0, 3)
        const removed = Array.from(rec.removedNodes).map(nodeText).filter(Boolean).slice(0, 3)
        const parts = [added.length ? `added ${added.map((s) => JSON.stringify(s)).join(', ')}` : '', removed.length ? `removed ${removed.map((s) => JSON.stringify(s)).join(', ')}` : '']
        note(`kids:${target}`, target, `children ${parts.filter(Boolean).join('; ')}`, t)
      }
    }
  })
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [...WATCHED_ATTRS, 'style'],
    characterData: true,
  })

  const styled = visible.filter(([el]) => el.getAnimations().length === 0).slice(0, MAX_STYLE_ELEMENTS)
  const frames: string[][][] = styled.map(([el]) => [styleSnapshot(el)])

  try {
    const step = DURATION_MS / SAMPLES
    for (let i = 0; i < SAMPLES; i++) {
      await new Promise((resolve) => setTimeout(resolve, step))
      const t = seconds()
      styled.forEach(([el], j) => frames[j].push(styleSnapshot(el)))
      for (const [el, from] of textOf) {
        const next = directText(el)
        if (!next || next === from) continue
        note(`text:${label(el)}`, label(el), `text ${JSON.stringify(from)} → ${JSON.stringify(next)}`, t)
        textOf.set(el, next)
      }
    }
  } finally {
    observer.disconnect()
  }

  applyStyleMotion(styled, frames)

  const texts = [...describeTextSeries(log.within(root)), ...splitTextReveals(visible)].slice(0, MAX_TEXT_ANIMATIONS)
  // Text animations are described in full; drop their once-a-second samples.
  const animated = new Set(texts.map((a) => a.target))
  for (const [key, bucket] of buckets) if (key.startsWith('text:') && animated.has(bucket.target)) buckets.delete(key)

  const events: SimulationEvent[] = Array.from(buckets.values())
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_EVENTS)
    .map((b) => ({ t: b.t, target: b.target, change: b.change }))

  const styleMoved = styled.some(([, node]) => !!node.motion?.length)
  return { durationMs: DURATION_MS, events, texts, idle: events.length === 0 && !styleMoved && !texts.length }
}

// ---------- text animations ----------

const CARET = /[|▍▌█_▮⎸]\s*$/
const NUMBER = /^(\D*?)(-?[\d,]*\.?\d+)(\D*)$/

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
}

// first, second, third … last three: enough to show the pattern without listing every keystroke.
function sampleValues(values: string[], max = 8): string[] {
  const clipped = values.map((v) => clip(v, 120))
  return clipped.length <= max ? clipped : [...clipped.slice(0, 3), '…', ...clipped.slice(-3)]
}

// Which kind of text animation a series of values is, from the values themselves.
function classify(points: TextPoint[]): Pick<TextAnimation, 'kind' | 'summary' | 'timing'> | null {
  const values = points.map((p) => p.text)
  if (values.length < 3) return null
  const span = points.at(-1)!.t - points[1].t
  const gaps = points.slice(2).map((p, i) => p.t - points[i + 1].t)
  const every = `every ~${Math.round(median(gaps))}ms`
  const secs = (ms: number) => `${Math.round(ms / 100) / 10}s`

  const numbers = values.map((v) => NUMBER.exec(v.trim()))
  const [, prefix = '', , suffix = ''] = numbers[0] ?? []
  if (numbers.every((m) => m && m[1] === prefix && m[3] === suffix)) {
    const decimals = numbers[0]![2].split('.')[1]?.length ?? 0
    return {
      kind: 'counter',
      summary: `counts ${values[0].trim()} → ${values.at(-1)!.trim()} in ${values.length - 1} steps over ${secs(span)}, with ${decimals} decimal${decimals === 1 ? '' : 's'}${prefix || suffix ? ` and the same "${prefix}…${suffix}" around the number` : ''}`,
      timing: every,
    }
  }

  const bare = values.map((v) => v.replace(CARET, ''))
  const caret = values.some((v) => CARET.test(v))
  const grows = bare.slice(1).every((v, i) => v.startsWith(bare[i]) && v.length >= bare[i].length)
  const shrinks = bare.slice(1).every((v, i) => bare[i].startsWith(v) && v.length <= bare[i].length)
  if (grows || shrinks) {
    const chars = Math.abs(bare.at(-1)!.length - bare[0].length)
    const perStep = chars / (values.length - 1)
    const rate = span > 0 ? Math.round((chars / span) * 1000) : chars
    const deleting = shrinks && !grows
    const words = perStep > 3
    return {
      kind: deleting ? 'deleting' : words ? 'stream' : 'typing',
      summary: `${deleting ? 'deletes' : words ? 'streams in' : 'types'} ${chars} characters over ${secs(span)} (~${rate} chars/s, ~${Math.round(perStep * 10) / 10} per step)${caret ? ', with a caret at the end' : ''}`,
      timing: every,
    }
  }

  const sameLength = bare.at(-1)!.length <= 120 && bare.every((v) => Math.abs(v.length - bare.at(-1)!.length) <= 1)
  const changedChars = (a: string, b: string) => Array.from(a).filter((c, i) => c !== b[i]).length / Math.max(1, a.length)
  if (sameLength && bare.slice(1, -1).some((v, i) => changedChars(v, bare[i]) > 0.3)) {
    return { kind: 'scramble', summary: `scrambles through random characters and resolves to "${clip(bare.at(-1)!, 80)}" over ${secs(span)}`, timing: every }
  }

  const distinct = Array.from(new Set(bare))
  if (distinct.length < bare.length) return { kind: 'cycle', summary: `cycles through ${distinct.length} texts`, timing: every }
  return { kind: 'changes', summary: `changes ${values.length - 1} times over ${secs(span)}`, timing: every }
}

function describeTextSeries(series: Map<Element, TextPoint[]>): TextAnimation[] {
  const out: TextAnimation[] = []
  const covered: Element[] = []
  // Innermost first: a typing span is described once, not again for each ancestor that contains it.
  const entries = Array.from(series).sort(([a], [b]) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0))
  for (const [el, points] of entries) {
    if (covered.some((c) => el.contains(c))) continue
    const kind = classify(points)
    if (!kind) continue
    covered.push(el)
    out.push({ target: label(el), ...kind, values: sampleValues(points.map((p) => p.text)) })
  }
  return out
}

// Split-text reveals (GSAP SplitText, Motion staggers, per-letter CSS delays): a run of one-word or
// one-letter spans that animate with increasing delays, or that sat at different stages at capture.
function splitTextReveals(visible: [Element, CapturedNode][]): TextAnimation[] {
  const out: TextAnimation[] = []
  for (const [el] of visible) {
    const kids = Array.from(el.children)
    if (kids.length < 4 || kids.length > 400) continue
    const pieces = kids.map((k) => (k.children.length <= 1 ? (k.textContent ?? '').trim() : null))
    if (pieces.some((p) => p === null || !p || p.length > 24 || /\s/.test(p))) continue
    const delays = kids.map((k) => {
      const anim = k.getAnimations()[0] ?? k.firstElementChild?.getAnimations()[0]
      if (anim?.effect) return Number(anim.effect.getTiming().delay ?? 0)
      const cs = getComputedStyle(k)
      const css = cs.animationName !== 'none' ? cs.animationDelay : cs.transitionDelay
      return parseFloat(css) * (css.trim().endsWith('ms') ? 1 : 1000) || 0
    })
    const stagger = median(delays.slice(1).map((d, i) => d - delays[i]))
    const looks = new Set(
      kids.map((k) => {
        const cs = getComputedStyle(k)
        return `${cs.opacity} ${cs.transform} ${cs.filter}`
      }),
    )
    const midReveal = looks.size > 1
    if (stagger <= 0 && !midReveal) continue
    const timing = kids[kids.length - 1].getAnimations()[0]?.effect?.getTiming()
    const unit = pieces.every((p) => (p ?? '').length <= 1) ? 'letter' : 'word'
    out.push({
      target: label(el),
      kind: 'split',
      summary: `split into ${kids.length} ${unit} spans (<${kids[0].tagName.toLowerCase()}>), revealed one after another${midReveal ? '; at capture they were at different stages (their opacity/transform differ)' : ''}`,
      values: [clip(el.textContent ?? '', 160)],
      timing:
        [
          stagger > 0 ? `stagger ${Math.round(stagger)}ms per ${unit}` : '',
          timing?.duration ? `${Math.round(Number(timing.duration))}ms each` : '',
          timing?.easing && timing.easing !== 'linear' ? `easing ${timing.easing}` : '',
        ]
          .filter(Boolean)
          .join(', ') || 'stagger not readable: match it from the motion lines in the tree',
    })
  }
  return out
}

