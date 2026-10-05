// Scroll story: scrolls the page so the captured section travels all the way through the viewport and
// records everything that changes on the way: ScrollTrigger scrubs and pins, sticky "storytelling"
// sections that step through phases, parallax, reveal-on-scroll (Framer Motion whileInView, AOS, GSAP),
// CSS scroll timelines, and text/image/class swaps. The samples are grouped into phases (stretches where
// something animates, and holds where nothing does). No screenshots: every image the story shows on the
// way is logged instead (MediaLog), so it is downloaded with the rest of the section's files.
//
// The range covers the section, the GSAP pin spacer around it, the sticky track it sits in, and the
// ScrollTriggers that touch it. 0% is the first of those entering the bottom of the viewport; 100% is
// the last leaving at the top. The page is scrolled back afterwards.
import { label } from '../shared/dom'
import type { Capture, CapturedNode, RuntimeData, ScrollPhase, ScrollStory, SimulationEvent } from '../shared/types'
import { normalizeColors, tidyNumbers } from './extract'
import { findImageSequences, MediaLog } from './seen'
import { clip, directText, nodeText, WATCHED_ATTRS } from './timeline'

const STEP_VIEWPORTS = 0.2 // one sample per fifth of a viewport scrolled
const MIN_STOPS = 9
const MAX_STOPS = 40
const MAX_RANGE_VIEWPORTS = 24 // a ScrollTrigger on a page wrapper shouldn't make us scroll the whole site
const SETTLE_MS = 260 // scrubbed and smoothed animations lag behind the scroll position
const SMOOTH_SETTLE_MS = 450 // Lenis, `scrub: 1` and friends lag more
const MAX_ELEMENTS = 600
const MAX_TEXT_ELEMENTS = 300
const MAX_PHASES = 14
const MAX_CHANGES_PER_PHASE = 12
const MAX_POINTS = 12
const MAX_EVENTS = 120
const SCRUB_MIN_STEPS = 4 // a value changing on this many steps, densely, follows the scroll
const SCRUB_DENSITY = 0.7
const MAX_SCRUBS = 20
export const PROPS = [
  'transform',
  'translate',
  'rotate',
  'scale',
  'opacity',
  'filter',
  'backdrop-filter',
  'clip-path',
  'mask-position',
  'background-position',
  'background-color',
  'color',
  'stroke-dashoffset',
  'width',
  'height',
  'border-radius',
  'position',
  'top',
  'left',
  'z-index',
  'display',
  'visibility',
  'background-image',
]
const BACKGROUND_IMAGE = PROPS.indexOf('background-image')
const ATTRS = [...WATCHED_ATTRS, 'aria-current', 'aria-selected', 'data-active', 'data-index', 'data-step', 'data-in-view']
const SCROLL_LIBRARIES = /ScrollTrigger|Lenis|Locomotive|AOS|ScrollMagic|Framer|Webflow|Motion|GSAP|Sal|ScrollReveal|Swup|Barba/i
const SCROLL_ATTRS = '[data-aos], [data-scroll], [data-scroll-section], [data-sal], [data-framer-appear-id], [data-motion], [data-animate], [data-speed], [data-lag], .pin-spacer'

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Worth scrolling the page for. Storytelling sections often look completely static until scrolled,
// so anything hinting at scroll behaviour counts, and so does a section taller than the viewport.
export function wantsScrollRecording(capture: Capture, runtime: RuntimeData | undefined, root?: Element): boolean {
  if (runtime?.gsap?.scrollTriggers.length || runtime?.gsap?.bundled || runtime?.smoothScroll) return true
  if ((runtime?.libraries ?? capture.libraries).some((l) => SCROLL_LIBRARIES.test(l.name))) return true
  if (capture.animations.some((a) => a.scrollDriven)) return true
  if (capture.keyframes.length && /timeline|view\(|scroll\(/.test(JSON.stringify(capture.root))) return true
  // A scripted simulation that only advances on scroll sits still during the idle watch.
  if (capture.simulation?.idle) return true
  if (capture.root.box.h > capture.viewport.h * 1.2) return true
  if (root && (root.closest(SCROLL_ATTRS) || root.querySelector(SCROLL_ATTRS) || stickyTrack(root))) return true
  const pending = (n: CapturedNode): boolean =>
    !!n.note?.startsWith('opacity 0') || n.styles['position'] === 'sticky' || n.children.some(pending)
  return pending(capture.root)
}

// The section, or a sticky element inside/around it, stays stuck while its parent scrolls past: that
// parent is the "track" whose height sets how long the story lasts.
function stickyTrack(root: Element): Element | null {
  for (let el: Element | null = root; el && el !== document.body; el = el.parentElement) {
    if (getComputedStyle(el).position === 'sticky') return el.parentElement
  }
  const inner = Array.from(root.querySelectorAll('*'))
    .slice(0, 2000)
    .find((el) => getComputedStyle(el).position === 'sticky')
  return inner?.parentElement ?? null
}

function scrollRange(root: Element, runtime: RuntimeData | undefined): { from: number; to: number } {
  const y = window.scrollY
  const vh = window.innerHeight
  const span = (el: Element): [number, number] => {
    const r = el.getBoundingClientRect()
    return [r.top + y - vh, r.bottom + y]
  }
  let [from, to] = span(root)
  const grow = ([a, b]: [number, number]) => {
    from = Math.min(from, a)
    to = Math.max(to, b)
  }
  const spacer = root.closest('.pin-spacer') // GSAP wraps pinned elements in a spacer as tall as the pin
  if (spacer) grow(span(spacer))
  const track = stickyTrack(root)
  if (track && track !== document.body) grow(span(track))
  // ScrollTriggers that overlap the section (their start/end are page scroll positions).
  for (const st of runtime?.gsap?.scrollTriggers ?? []) {
    const m = /(-?\d+)px → (-?\d+)px/.exec(st.range)
    if (!m) continue
    const a = Number(m[1])
    const b = Number(m[2])
    if (b >= from && a <= to) grow([a, b])
  }
  const maxY = Math.max(0, document.documentElement.scrollHeight - vh)
  from = Math.max(0, Math.round(from))
  to = Math.min(maxY, Math.round(to), from + vh * MAX_RANGE_VIEWPORTS)
  return { from, to }
}

interface Sample {
  y: number
  progress: number
  styles: string[][] // [element][prop]
  texts: string[] // per text element
  srcs: string[] // per media element
  times: number[] // currentTime per video: scroll-scrubbed videos
  tops: number[] // viewport top of each element, for pin detection
}

export interface ScrollOptions {
  runtime?: RuntimeData
  onProgress?: (done: number, total: number) => void
}

export async function recordScrollMotion(
  root: Element,
  visible: [Element, CapturedNode][],
  { runtime, onProgress }: ScrollOptions = {},
): Promise<ScrollStory | null> {
  const tracked = visible.slice(0, MAX_ELEMENTS)
  const startY = window.scrollY
  const { from, to } = scrollRange(root, runtime)
  if (to - from < 2) return null
  const vh = window.innerHeight
  const count = Math.min(MAX_STOPS, Math.max(MIN_STOPS, Math.ceil((to - from) / (vh * STEP_VIEWPORTS)) + 1))
  const positions = Array.from(new Set(Array.from({ length: count }, (_, i) => Math.round(from + ((to - from) * i) / (count - 1)))))
  const progressAt = (y: number) => Math.round(((y - from) / (to - from)) * 100)
  const smooth = !!runtime?.smoothScroll || (runtime?.gsap?.scrollTriggers ?? []).some((st) => /scrub:\s*(true|[\d.]*[1-9])/.test(st.config))
  const settle = smooth ? SMOOTH_SETTLE_MS : SETTLE_MS

  // Changes from looping animations and script motion that runs anyway (seen while the page sat idle)
  // aren't caused by scrolling.
  const looping = new Set(
    tracked
      .filter(([el]) => el.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity))
      .map(([el]) => el),
  )
  const idleMotion = (node: CapturedNode, prop: string) => node.motion?.some((m) => m.startsWith(`${prop}:`)) ?? false

  const textEls = tracked.filter(([el]) => directText(el)).slice(0, MAX_TEXT_ELEMENTS)
  const mediaEls = tracked.filter(([el]) => el instanceof HTMLImageElement || el instanceof HTMLVideoElement)
  const sampledMedia = new Set(mediaEls.map(([el]) => el))
  const videoEls = mediaEls.map(([el]) => el).filter((el): el is HTMLVideoElement => el instanceof HTMLVideoElement)
  const mediaSrc = (el: Element) => (el instanceof HTMLImageElement || el instanceof HTMLVideoElement ? el.currentSrc || el.getAttribute('src') || '' : '')

  // DOM changes (class toggles, nodes added, aria/data state) with the scroll progress they happened at.
  let currentProgress = 0
  const events: SimulationEvent[] = []
  const media = new MediaLog()
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      const el = rec.target instanceof Element ? rec.target : rec.target.parentElement
      if (!el || (el !== root && !root.contains(el))) continue
      // Nodes rendered for one step of the story may be gone by the end: log their media now.
      rec.addedNodes.forEach((node) => node instanceof Element && media.scan(node, currentProgress))
      if (events.length >= MAX_EVENTS) continue
      const target = label(el)
      if (rec.type === 'attributes' && rec.attributeName) {
        if (/^(src|srcset|poster)$/.test(rec.attributeName) && sampledMedia.has(el)) continue // in the samples already
        const next = el.getAttribute(rec.attributeName) ?? ''
        const prev = rec.oldValue ?? ''
        if (clip(prev) === clip(next)) continue
        events.push({ t: currentProgress, target, change: `${rec.attributeName} ${JSON.stringify(clip(prev, 80))} → ${JSON.stringify(clip(next, 80))}` })
      } else if (rec.type === 'childList' && (rec.addedNodes.length || rec.removedNodes.length)) {
        // Text swaps are in the samples; scripts that rewrite the same text on every scroll event are noise.
        const nodes = [...Array.from(rec.addedNodes), ...Array.from(rec.removedNodes)]
        if (nodes.every((n) => n.nodeType === Node.TEXT_NODE)) continue
        const added = Array.from(rec.addedNodes).map(nodeText).filter(Boolean).slice(0, 3)
        const removed = Array.from(rec.removedNodes).map(nodeText).filter(Boolean).slice(0, 3)
        if ((!added.length && !removed.length) || added.join('\n') === removed.join('\n')) continue
        const parts = [added.length ? `added ${added.map((s) => JSON.stringify(s)).join(', ')}` : '', removed.length ? `removed ${removed.map((s) => JSON.stringify(s)).join(', ')}` : '']
        events.push({ t: currentProgress, target, change: `children ${parts.filter(Boolean).join('; ')}` })
      }
    }
  })

  const scrollTo = async (y: number, ms = settle) => {
    window.scrollTo({ top: y, behavior: 'instant' })
    await nextFrame()
    await nextFrame()
    await wait(ms)
  }

  const samples: Sample[] = []
  try {
    // Start above the range and scroll down in order, the way a visitor would, so one-time reveals
    // (whileInView, toggleActions "play none none none") fire at the right moment.
    await scrollTo(positions[0], settle * 2)
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ATTRS })
    for (let i = 0; i < positions.length; i++) {
      const y = positions[i]
      currentProgress = progressAt(y)
      if (i > 0) await scrollTo(y)
      samples.push({
        y,
        progress: progressAt(y),
        // An element the story unmounted keeps its last values: its removal is a DOM change below.
        styles: tracked.map(([el], j) => {
          if (!el.isConnected) return samples.at(-1)?.styles[j] ?? PROPS.map(() => '')
          const cs = getComputedStyle(el)
          return PROPS.map((p) => cs.getPropertyValue(p))
        }),
        texts: textEls.map(([el]) => directText(el)),
        srcs: mediaEls.map(([el]) => mediaSrc(el)),
        times: videoEls.map((el) => Math.round(el.currentTime * 100) / 100),
        tops: tracked.map(([el]) => {
          const r = el.getBoundingClientRect()
          return r.width || r.height ? r.top : NaN // display:none reads as a still 0
        }),
      })
      // Every image and background on screen at this step, so swapped-out files are saved too.
      const sample = samples.at(-1)!
      mediaEls.forEach(([el], k) => media.image(el, sample.srcs[k], sample.progress))
      tracked.forEach(([el], j) => media.background(el, sample.styles[j][BACKGROUND_IMAGE], sample.progress))
      onProgress?.(i + 1, positions.length)
    }
    observer.disconnect()

    const analysis = analyze(tracked, samples, looping, idleMotion, textEls, mediaEls, events, videoEls)
    const phases = analysis.phases

    return {
      start: from,
      end: to,
      viewport: { w: window.innerWidth, h: vh },
      samples: samples.length,
      pinned: analysis.pinned,
      continuous: analysis.continuous,
      phases,
      events: events.slice(0, MAX_EVENTS),
      media: [...media.assets, ...findImageSequences(root)],
    }
  } finally {
    observer.disconnect()
    window.scrollTo({ top: startY, behavior: 'instant' })
  }
}

type Change = { target: string; what: string; from: string; to: string }
type Scrub = { target: string; prop: string; start: number; end: number; points: string } // start/end: sample indices

function show(value: string): string {
  return clip(tidyNumbers(normalizeColors(value)), 90)
}

// Values at the points where they change; holds in between are implied by equal neighbours.
function keyPoints(progress: number[], values: string[]): string {
  const idx: number[] = []
  for (let i = 0; i < values.length; i++) {
    const changedIn = i > 0 && values[i] !== values[i - 1]
    const changesNext = i < values.length - 1 && values[i] !== values[i + 1]
    if (i === 0 || i === values.length - 1 || changedIn || changesNext) idx.push(i)
  }
  const kept = idx.length > MAX_POINTS ? idx.filter((_, k) => k % Math.ceil(idx.length / MAX_POINTS) === 0 || k === idx.length - 1) : idx
  return kept.map((i) => `${progress[i]}% ${show(values[i])}`).join(' · ')
}

function analyze(
  tracked: [Element, CapturedNode][],
  samples: Sample[],
  looping: Set<Element>,
  idleMotion: (node: CapturedNode, prop: string) => boolean,
  textEls: [Element, CapturedNode][],
  mediaEls: [Element, CapturedNode][],
  events: SimulationEvent[],
  videoEls: HTMLVideoElement[],
) {
  const progress = samples.map((s) => s.progress)
  const stepChanges: Change[][] = Array.from({ length: samples.length }, () => [])
  const scrubs: Scrub[] = []

  // Styles: per-node `scroll` lines for the tree, and per-step changes for the phases.
  tracked.forEach(([el, node], j) => {
    if (looping.has(el)) return
    const lines: string[] = []
    const target = label(el)
    PROPS.forEach((prop, k) => {
      if (idleMotion(node, prop)) return
      const values = samples.map((s) => s.styles[j][k])
      if (new Set(values).size < 2) return
      lines.push(`${prop}: ${keyPoints(progress, values)}`)
      // A value that moves on (nearly) every step of a stretch follows the scroll: a scrub or parallax.
      // It's reported as a span, so it doesn't swallow the discrete steps of the story into one phase.
      const changed = values.flatMap((v, i) => (i > 0 && v !== values[i - 1] ? [i] : []))
      const first = changed[0]
      const last = changed.at(-1)!
      if (changed.length >= SCRUB_MIN_STEPS && changed.length / (last - first + 1) >= SCRUB_DENSITY) {
        const span = (list: (string | number)[]) => list.slice(first - 1, last + 1)
        scrubs.push({ target, prop, start: first - 1, end: last, points: keyPoints(span(progress) as number[], span(values) as string[]) })
        return
      }
      for (let i = 1; i < values.length; i++) {
        if (values[i] !== values[i - 1]) stepChanges[i].push({ target, what: prop, from: values[i - 1], to: values[i] })
      }
    })
    node.scroll = lines.length ? lines : undefined
  })

  // Text and media swaps: the classic "step 1 / step 2 / step 3" storytelling section.
  textEls.forEach(([el, node], j) => {
    const values = samples.map((s) => s.texts[j])
    if (new Set(values).size < 2) return
    node.scroll = [...(node.scroll ?? []), `text: ${keyPoints(progress, values.map((v) => JSON.stringify(v)))}`]
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1]) stepChanges[i].push({ target: label(el), what: 'text', from: JSON.stringify(values[i - 1]), to: JSON.stringify(values[i]) })
    }
  })
  mediaEls.forEach(([el, node], j) => {
    // A lazy image swapping its placeholder for the real file is loading, not part of the story.
    const raw = samples.map((s) => s.srcs[j])
    const values = raw.map((v, i) => (v.startsWith('data:') ? (raw.slice(i).find((r) => !r.startsWith('data:')) ?? v) : v))
    if (new Set(values).size < 2) return
    const short = (v: string) => v.split('?')[0].split('/').pop() || v
    node.scroll = [...(node.scroll ?? []), `src: ${keyPoints(progress, values.map(short))}`]
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1]) stepChanges[i].push({ target: label(el), what: 'src', from: short(values[i - 1]), to: short(values[i]) })
    }
  })
  // Paused videos whose playback position moves with the page: the scroll scrubs through the video.
  videoEls.forEach((el, j) => {
    const values = samples.map((s) => s.times[j])
    if (!el.paused || new Set(values).size < 3) return
    const node = mediaEls.find(([m]) => m === el)?.[1]
    const points = keyPoints(progress, values.map((v) => `${v}s`))
    if (node) node.scroll = [...(node.scroll ?? []), `currentTime: ${points}`]
    const changed = values.flatMap((v, i) => (i > 0 && v !== values[i - 1] ? [i] : []))
    scrubs.push({ target: label(el), prop: 'currentTime (the scroll scrubs the paused video)', start: changed[0] - 1, end: changed.at(-1)!, points })
  })

  // DOM events land in the step that ended at their progress.
  for (const e of events) {
    const i = Math.max(1, progress.findIndex((p) => p >= e.t))
    stepChanges[i].push({ target: e.target, what: e.change, from: '', to: '' })
  }

  const continuous = scrubs
    .slice(0, MAX_SCRUBS)
    .map((s) => `\`${s.target}\` ${s.prop}: ${s.points}`)
  return { phases: buildPhases(samples, stepChanges, scrubs), pinned: pins(tracked, samples), continuous }
}

function buildPhases(samples: Sample[], stepChanges: Change[][], scrubs: Scrub[]): ScrollPhase[] {
  type Run = { start: number; end: number; active: boolean }
  const runs: Run[] = []
  for (let i = 1; i < samples.length; i++) {
    const active = stepChanges[i].length > 0
    const last = runs.at(-1)
    if (last && last.active === active) last.end = i
    else runs.push({ start: i - 1, end: i, active })
  }
  // Too many phases: fold the shortest hold into its neighbours until it fits.
  while (runs.length > MAX_PHASES) {
    let k = -1
    for (let i = 1; i < runs.length - 1; i++) {
      if (!runs[i].active && (k < 0 || runs[i].end - runs[i].start < runs[k].end - runs[k].start)) k = i
    }
    if (k < 0) break
    runs.splice(k - 1, 3, { start: runs[k - 1].start, end: runs[k + 1].end, active: true })
  }

  return runs.map((run) => {
    // First "from" and last "to" per element and property across the phase.
    const merged = new Map<string, Change>()
    for (let i = run.start + 1; i <= run.end; i++) {
      for (const c of stepChanges[i]) {
        const key = `${c.target}|${c.from || c.to ? c.what : c.what + i}`
        const prev = merged.get(key)
        if (prev) prev.to = c.to
        else merged.set(key, { ...c })
      }
    }
    const lines = Array.from(merged.values())
      .filter((c) => !(c.from || c.to) || c.from !== c.to)
      .map((c) => (c.from || c.to ? `\`${c.target}\` ${c.what}: ${show(c.from)} → ${show(c.to)}` : `\`${c.target}\` ${c.what}`))
    const capped = lines.length > MAX_CHANGES_PER_PHASE ? [...lines.slice(0, MAX_CHANGES_PER_PHASE), `…and ${lines.length - MAX_CHANGES_PER_PHASE} more`] : lines
    const scrubbing = scrubs.filter((s) => s.start < run.end && s.end > run.start)
    const changes = [
      ...capped,
      ...(scrubbing.length ? [`scrubbing with the scroll: ${scrubbing.slice(0, 6).map((s) => `\`${s.target}\` ${s.prop}`).join(', ')}${scrubbing.length > 6 ? ', …' : ''}`] : []),
    ]
    return {
      from: samples[run.start].progress,
      to: samples[run.end].progress,
      scrollFrom: samples[run.start].y,
      scrollTo: samples[run.end].y,
      kind: run.active ? 'change' : 'hold',
      changes,
    }
  })
}

// Elements that stay put in the viewport while the page scrolls under them (GSAP pin, position: sticky,
// position: fixed). Only the outermost pinned element is reported; its children ride along.
function pins(tracked: [Element, CapturedNode][], samples: Sample[]): ScrollStory['pinned'] {
  const out: ScrollStory['pinned'] = []
  const pinnedEls = new Set<Element>()
  tracked.forEach(([el], j) => {
    let best: [number, number] | null = null
    let runStart = -1
    for (let i = 1; i <= samples.length; i++) {
      const still = i < samples.length && Math.abs(samples[i].tops[j] - samples[i - 1].tops[j]) < 1 && samples[i].y !== samples[i - 1].y
      if (still && runStart < 0) runStart = i - 1
      if (!still && runStart >= 0) {
        if (i - 1 - runStart >= 2 && (!best || i - 1 - runStart > best[1] - best[0])) best = [runStart, i - 1]
        runStart = -1
      }
    }
    if (!best) return
    pinnedEls.add(el)
    for (let p = el.parentElement; p; p = p.parentElement) if (pinnedEls.has(p)) return
    if (out.length < 6) out.push({ target: label(el), from: samples[best[0]].progress, to: samples[best[1]].progress })
  })
  return out
}
