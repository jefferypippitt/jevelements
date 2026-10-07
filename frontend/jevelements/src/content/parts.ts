// The parts of the hovered element, shown by the picker as dotted boxes inside its blue ring: the
// building blocks of the section (a heading, a paragraph, the buttons, an image, each card) and, in a
// fainter line, the parts of the bigger ones. An element with a single child is a wrapper (a
// container, padding, a grid around one column set) and is looked through, so the parts shown are
// always two or more side by side, never just the box around the next box.
import { stableClasses } from '../shared/dom'
import type { SectionPart } from '../shared/types'

const MIN_SIDE = 6 // px: anything thinner is a rule or a spacer, not a part
const MAX_WRAPPERS = 6 // wrappers looked through in a row
const MAX_PARTS = 24
const MAX_SUBPARTS = 8 // per part
const SUBPART_MIN = { w: 120, h: 48 } // only parts this big get their own parts drawn
const TAG_MIN = { w: 56, h: 18 } // only parts this big get a name tag
const TAG_ROOM = 16 // px above a part its tag needs; nearer the top of the screen it goes inside

export interface Part {
  el: Element
  depth: 1 | 2
}

function shown(el: Element, r: DOMRect): boolean {
  if (r.width < MIN_SIDE || r.height < MIN_SIDE) return false
  const style = getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01
}

// The visible children of el, looking through wrappers that only hold one child.
function childParts(el: Element): Element[] {
  let at = el
  for (let i = 0; i <= MAX_WRAPPERS; i++) {
    const kids = Array.from(at.children).filter((c) => shown(c, c.getBoundingClientRect()))
    if (kids.length !== 1) return kids
    at = kids[0]
  }
  return []
}

export function findParts(el: Element): Part[] {
  const parts: Part[] = []
  for (const part of childParts(el).slice(0, MAX_PARTS)) {
    parts.push({ el: part, depth: 1 })
    const r = part.getBoundingClientRect()
    if (r.width < SUBPART_MIN.w || r.height < SUBPART_MIN.h) continue
    for (const sub of childParts(part).slice(0, MAX_SUBPARTS)) parts.push({ el: sub, depth: 2 })
  }
  return parts
}

function name(el: Element): string {
  const cls = Array.from(el.classList).find((c) => c.length <= 24 && !/^(css|sc|jsx|svelte|emotion)-|__[A-Za-z0-9-]{4,}$/.test(c))
  return el.tagName.toLowerCase() + (cls ? `.${cls}` : '')
}

// ---------- the parts in the capture ----------
// The same parts, written down when a capture starts (before hovers and clicks change anything), so
// the prompt can split the rebuild into components the way the section is built. Names are written
// like the tree's element lines, boxes are relative to the section, and siblings built the same way
// (cards, logos, list items) are one entry with a count.

const TEXT_CHARS = 60

function treeName(el: Element): string {
  let s = el.tagName.toLowerCase()
  if (el.id) s += `#${el.id}`
  const cls = stableClasses(el).slice(0, 4)
  if (cls.length) s += '.' + cls.join('.')
  return s
}

function kindOf(el: Element): SectionPart['kind'] {
  const tag = el.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (['img', 'picture', 'svg', 'video', 'canvas', 'iframe'].includes(tag)) return 'media'
  if (tag === 'a' || tag === 'button' || el.getAttribute('role') === 'button') return 'control'
  if (['ul', 'ol', 'dl'].includes(tag)) return 'list'
  if (['nav', 'header', 'footer', 'form'].includes(tag)) return tag as SectionPart['kind']
  if (el.children.length === 0 || ['p', 'span', 'blockquote', 'label'].includes(tag)) return 'text'
  return 'group'
}

// Built the same way: same tag and classes, and the same children in the same order.
function signature(el: Element): string {
  return `${treeName(el)}>${Array.from(el.children, (c) => c.tagName).join(',')}`
}

function describe(el: Element, origin: DOMRect, depth: 1 | 2): SectionPart {
  const r = el.getBoundingClientRect()
  const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const part: SectionPart = {
    name: treeName(el),
    kind: kindOf(el),
    box: { x: Math.round(r.left - origin.left), y: Math.round(r.top - origin.top), w: Math.round(r.width), h: Math.round(r.height) },
  }
  if (text) part.text = text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}…` : text
  if (depth === 1 && r.width >= SUBPART_MIN.w && r.height >= SUBPART_MIN.h) {
    const subs = group(childParts(el).slice(0, MAX_SUBPARTS), origin, 2)
    if (subs.length) part.parts = subs
  }
  return part
}

function group(els: Element[], origin: DOMRect, depth: 1 | 2): SectionPart[] {
  const out: SectionPart[] = []
  let last: { sig: string; part: SectionPart } | null = null
  for (const el of els) {
    const sig = signature(el)
    if (last && last.sig === sig) {
      last.part.repeats = (last.part.repeats ?? 1) + 1
      const text = describe(el, origin, 2).text
      if (text) (last.part.items ??= last.part.text ? [last.part.text] : []).push(text)
      continue
    }
    const part = describe(el, origin, depth)
    out.push(part)
    last = { sig, part }
  }
  return out
}

export function captureParts(root: Element): SectionPart[] {
  return group(childParts(root).slice(0, MAX_PARTS), root.getBoundingClientRect(), 1)
}

// The dotted boxes, in the inspector's shadow root under its blue ring.
export class PartsLayer {
  private readonly layer: HTMLDivElement
  private parts: { part: Part; box: HTMLDivElement }[] = []

  constructor(root: ShadowRoot) {
    this.layer = document.createElement('div')
    this.layer.className = 'parts'
    root.append(this.layer)
  }

  get count(): number {
    return this.parts.filter((p) => p.part.depth === 1).length
  }

  show(el: Element | null) {
    const parts = el ? findParts(el) : []
    this.parts = parts.map((part) => {
      const box = document.createElement('div')
      box.className = part.depth === 1 ? 'part' : 'part sub'
      if (part.depth === 1) {
        const tag = document.createElement('span')
        tag.className = 'part-tag'
        tag.textContent = name(part.el)
        box.append(tag)
      }
      return { part, box }
    })
    this.layer.replaceChildren(...this.parts.map((p) => p.box))
    this.place()
  }

  // Follows scrolling and resizing; the elements stay the same.
  place() {
    for (const { part, box } of this.parts) {
      const r = part.el.getBoundingClientRect()
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
      box.classList.toggle('untagged', r.width < TAG_MIN.w || r.height < TAG_MIN.h)
      box.classList.toggle('tag-inside', r.top < TAG_ROOM)
    }
  }

  clear() {
    this.parts = []
    this.layer.replaceChildren()
  }
}
