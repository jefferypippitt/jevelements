// Media that only exists for part of the story. GSAP timelines and Framer Motion variants swap image
// sources, change background images, render new <img> elements for one step and remove them again,
// or draw a numbered image sequence onto a canvas as the page scrolls. The capture's first walk sees
// only the first frame, so the scroll recorder and the interaction player log every file they come
// across, with when it was on screen, and those become assets like any other.
import { label } from '../shared/dom'
import type { Asset } from '../shared/types'
import { absolute, collectSectionMedia, cssUrls } from './extract'

const MIN_SEQUENCE = 8 // numbered images loaded together, below this it's just a gallery
const MAX_SEQUENCE_FRAMES = 400
const SEQUENCE_EXT = /\.(jpe?g|png|webp|avif)$/i

export class MediaLog {
  readonly assets: Asset[] = []
  private readonly first = new Map<string, Asset>()

  // `when` is a label (e.g. "after click `button.tab`"), or a scroll progress %, which is merged into
  // a range ("scroll 40% → 76%") as the same file keeps being seen.
  add(asset: Asset, when: string | number) {
    if (!asset.src || (asset.src.startsWith('data:') && asset.src.length < 2_000)) return // lazy-load placeholders
    const key = asset.kind + asset.src
    const known = this.first.get(key)
    if (!known) {
      const entry = { ...asset, when: typeof when === 'number' ? `scroll ${when}%` : when }
      this.first.set(key, entry)
      this.assets.push(entry)
    } else if (typeof when === 'number' && known.when?.startsWith('scroll ')) {
      const from = known.when.match(/scroll (\d+)%/)?.[1]
      known.when = `scroll ${from}% → ${when}%`
    }
  }

  // Everything in a subtree right now: new nodes a script just rendered.
  scan(el: Element, when: string | number) {
    for (const asset of collectSectionMedia(el)) this.add(asset, when)
  }

  image(el: Element, src: string, when: string | number) {
    if (!src || src.startsWith('blob:')) return
    const r = el.getBoundingClientRect()
    const kind = el instanceof HTMLVideoElement ? 'video' : 'image'
    this.add({ kind, src, target: label(el), width: Math.round(r.width), height: Math.round(r.height) }, when)
  }

  background(el: Element, value: string, when: string | number) {
    if (!value || value === 'none') return
    const r = el.getBoundingClientRect()
    for (const url of cssUrls(value)) {
      this.add({ kind: 'background', src: absolute(url), target: label(el), width: Math.round(r.width), height: Math.round(r.height) }, when)
    }
  }
}

// Scroll-scrubbed image sequences (the Apple product-page technique): a script preloads
// frame_0001.jpg … frame_0240.jpg and draws the frame for the current scroll position onto a canvas.
// They never appear in the DOM, so they're found in the page's resource log by their numbering.
// Only kept when the section has a canvas, or an <img> showing one of the frames.
export function findImageSequences(root: Element): Asset[] {
  const canvas = root instanceof HTMLCanvasElement ? root : root.querySelector('canvas')
  const imgSrcs = new Set(Array.from(root.querySelectorAll('img'), (img) => img.currentSrc || img.src))
  const groups = new Map<string, { n: number; url: string }[]>()
  for (const entry of performance.getEntriesByType('resource')) {
    let url: URL
    try {
      url = new URL(entry.name)
    } catch {
      continue
    }
    const file = url.pathname.split('/').pop() ?? ''
    if (!SEQUENCE_EXT.test(file)) continue
    const m = /^(.*?)(\d+)(\D*)$/.exec(file)
    if (!m) continue
    const key = `${url.origin}${url.pathname.slice(0, -file.length)}${m[1]}#${m[3]}`
    const list = groups.get(key) ?? []
    if (!list.some((f) => f.url === entry.name)) list.push({ n: Number(m[2]), url: entry.name })
    groups.set(key, list)
  }

  const out: Asset[] = []
  let id = 0
  for (const list of groups.values()) {
    if (list.length < MIN_SEQUENCE) continue
    const shown = list.some((f) => imgSrcs.has(f.url))
    if (!canvas && !shown) continue
    id++
    const frames = list.sort((a, b) => a.n - b.n).slice(0, MAX_SEQUENCE_FRAMES)
    const host = canvas && !shown ? canvas : root.querySelector('img')
    const r = host?.getBoundingClientRect()
    frames.forEach((f, index) =>
      out.push({
        kind: 'image',
        src: f.url,
        target: host ? label(host) : label(root),
        width: Math.round(r?.width ?? 0),
        height: Math.round(r?.height ?? 0),
        when: 'image sequence, drawn as the page scrolls',
        sequence: { id, index, count: frames.length },
      }),
    )
  }
  return out
}
