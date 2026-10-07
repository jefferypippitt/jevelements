// Pink boxes over the page while a capture plays the section's hovers and clicks: a dashed ring around
// the section or component being explored, a solid one with a label around the control being played,
// and a frosted cover over each popup the page opened on <body> (a menu, a dialog, a demo's options)
// while it's read. The same picture as the picker's blue ring, so the work shows where it happens. The
// popup is covered rather than hidden: hiding it would change what the capture reads.
// While the hover sweep runs, the same boxes turn green and a dot shows where its virtual pointer is;
// while the click sweep runs (hidden clicks, clicks over a canvas or the section), they turn amber.
//
// The sweeps screenshot the element they sweep dozens of times, so while they run nothing is drawn over
// it: the rings sit just outside its edge, the label above or below it, and the pointer's position is
// shown by two markers on its edges, one following x and one following y. Anything that would still
// cover it (a popup's cover) stays hidden until the sweep ends rather than blinking out for each shot.
//
// The boxes sit in the inspector's shadow root with pointer-events: none, so a synthetic click's
// elementFromPoint passes through them, and the capture skips <jev-inspector> when it looks for portals.
import { label } from '../shared/dom'

export type TraceAction = 'hover' | 'click' | 'move' | 'sweep' | 'sweep-click'

export interface TraceFocus {
  el: Element // the control being played
  action: TraceAction
  area: Element // the section, or the component whose states are explored
  point?: { x: number; y: number } // where a sweep's virtual pointer is (viewport px)
}

const VERB: Record<TraceAction, string> = { hover: 'Hovering', click: 'Clicking', move: 'Going back via', sweep: 'Sweeping the pointer over', 'sweep-click': 'Click sweep:' }

function box(className: string): HTMLDivElement {
  const div = document.createElement('div')
  div.className = className
  return div
}

const RING_GAP = 3 // a sweep's solid ring: px between the swept element and the ring's inner edge
const AREA_GAP = 8 // the dashed ring around it
const MARKER_GAP = 12 // from the swept element's edge to a pointer marker's center
const LABEL_HEIGHT = 24

function place(div: HTMLElement, r: DOMRect) {
  Object.assign(div.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
}

function grow(r: DOMRect, by: number): DOMRect {
  return new DOMRect(r.left - by, r.top - by, r.width + by * 2, r.height + by * 2)
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

export class Trace {
  private readonly root: ShadowRoot
  private readonly area = box('trace-area')
  private readonly target = box('trace')
  private readonly tag = box('trace-label')
  private readonly dot = box('trace-dot')
  private readonly dotY = box('trace-dot') // a sweep's second marker, on a vertical edge
  private readonly popups: HTMLDivElement[] = []
  private focus: TraceFocus | null = null
  private frame = 0
  // <body>'s children when tracing started: anything visible there since is a popup the page opened.
  // A portal container that was there all along but empty counts once it has content.
  private readonly atStart: Map<Element, number>

  constructor(root: ShadowRoot) {
    this.root = root
    this.atStart = new Map(Array.from(document.body?.children ?? []).map((el) => [el, el.childElementCount]))
    root.append(this.area, this.target, this.tag, this.dot, this.dotY)
    this.frame = requestAnimationFrame(this.draw)
  }

  show(focus: TraceFocus | null) {
    this.focus = focus
  }

  stop() {
    cancelAnimationFrame(this.frame)
    for (const div of [this.area, this.target, this.tag, this.dot, this.dotY, ...this.popups]) div.remove()
    this.popups.length = 0
    this.focus = null
  }

  private openPopups(): Element[] {
    return Array.from(document.body?.children ?? []).filter((el) => {
      if (el.tagName === 'JEV-INSPECTOR' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false
      if (this.focus && el.contains(this.focus.area)) return false
      const before = this.atStart.get(el)
      if (before !== undefined && !(before === 0 && el.childElementCount > 0)) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (el as HTMLElement).checkVisibility?.() !== false
    })
  }

  // Follows the page every frame: the explorer scrolls each control into view, and clicks move things.
  private draw = () => {
    this.frame = requestAnimationFrame(this.draw)
    const focus = this.focus
    const sweeping = focus?.action === 'sweep' || focus?.action === 'sweep-click'
    if (!focus || !focus.el.isConnected) {
      for (const div of [this.area, this.target, this.tag, this.dot, this.dotY]) div.style.display = 'none'
    } else if (sweeping) {
      this.drawAround(focus)
    } else {
      this.dotY.style.display = 'none'
      place(this.area, focus.area.getBoundingClientRect())
      const r = focus.el.getBoundingClientRect()
      place(this.target, r)
      const text = (focus.el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 40)
      this.tag.textContent = `${VERB[focus.action]} ${label(focus.el)}${text ? ` "${text}"` : ''}`
      const top = r.top > 26 ? r.top - 24 : Math.min(r.bottom + 4, window.innerHeight - 24)
      Object.assign(this.tag.style, { display: 'block', left: `${Math.max(4, r.left)}px`, top: `${top}px` })
      if (focus.point) Object.assign(this.dot.style, { display: 'block', left: `${focus.point.x}px`, top: `${focus.point.y}px` })
      else this.dot.style.display = 'none'
    }
    const open = focus ? this.openPopups() : []
    while (this.popups.length < open.length) {
      const div = box('trace-popup')
      this.root.append(div)
      this.popups.push(div)
    }

    // Green for the hover sweep, amber for the click sweep, pink for the hover & click pass.
    const sweep = focus?.action === 'sweep'
    const clicks = focus?.action === 'sweep-click'
    for (const div of [this.area, this.target, this.tag, this.dot, this.dotY, ...this.popups]) {
      div.classList.toggle('sweep', sweep)
      div.classList.toggle('sweep-click', clicks)
      div.classList.toggle('outside', sweeping)
    }
    const swept = focus && sweeping && focus.el.isConnected ? focus.el.getBoundingClientRect() : null
    this.popups.forEach((div, i) => {
      const el = open[i]
      if (!el) return void (div.style.display = 'none')
      const r = el.getBoundingClientRect()
      if (swept && overlaps(r, swept)) return void (div.style.display = 'none')
      place(div, r)
      div.style.display = 'flex' // centers its label
    })
  }

  // A sweep's marks, all outside the swept element (see the top of the file).
  private drawAround(focus: TraceFocus) {
    const r = focus.el.getBoundingClientRect()
    const ring = grow(r, RING_GAP)
    place(this.target, ring)
    if (focus.area === focus.el) this.area.style.display = 'none'
    else place(this.area, grow(focus.area.getBoundingClientRect(), AREA_GAP))

    const outer = focus.area === focus.el ? ring : grow(focus.area.getBoundingClientRect(), AREA_GAP)
    this.tag.textContent = `${VERB[focus.action]} ${label(focus.el)}`
    const above = outer.top - LABEL_HEIGHT - 4
    const below = outer.bottom + 4
    const top = above >= 0 ? above : below + LABEL_HEIGHT <= window.innerHeight ? below : null
    if (top === null) this.tag.style.display = 'none'
    else Object.assign(this.tag.style, { display: 'block', left: `${Math.max(4, outer.left)}px`, top: `${top}px` })

    // x on the top edge (else the bottom), y on the left edge (else the right); none where it can't fit.
    const point = focus.point
    const room = MARKER_GAP + 8
    const y = r.top >= room ? r.top - MARKER_GAP : r.bottom + room <= window.innerHeight ? r.bottom + MARKER_GAP : null
    const x = r.left >= room ? r.left - MARKER_GAP : r.right + room <= window.innerWidth ? r.right + MARKER_GAP : null
    if (point && y !== null) Object.assign(this.dot.style, { display: 'block', left: `${point.x}px`, top: `${y}px` })
    else this.dot.style.display = 'none'
    if (point && x !== null) Object.assign(this.dotY.style, { display: 'block', left: `${x}px`, top: `${point.y}px` })
    else this.dotY.style.display = 'none'
  }
}
