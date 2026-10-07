// Which elements react to the pointer. Only the page's own JavaScript world can see that: listeners
// added with addEventListener (vanilla, GSAP, jQuery, Motion's gestures) are recorded from
// document_start, and React handlers are read from the props React keeps on each DOM node. The content
// script reads the result from a data attribute, then hovers and clicks those elements. Listeners for
// the pointer's position (mousemove, pointermove, React's onMouseMove) are kept apart: they mean the
// section follows the pointer, which the hover sweep (content/sweep.ts) maps, and the elements that have
// one of their own are marked `move` too, so it sweeps each of them on its own.
import { PROBE_CLICK_ATTR, PROBE_INTERACTIVE_ATTR, PROBE_POINTER_ATTR } from '../shared/runtime'

const HOVER_EVENTS = new Set(['mouseenter', 'mouseover', 'pointerenter', 'pointerover', 'mousemove', 'pointermove'])
const CLICK_EVENTS = new Set(['click', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart'])
const MOVE_EVENTS = new Set(['mousemove', 'pointermove', 'pointerrawupdate'])
const REACT_HOVER = ['onMouseEnter', 'onMouseOver', 'onPointerEnter', 'onPointerOver', 'onMouseMove', 'onPointerMove', 'onHoverStart', 'whileHover']
const REACT_CLICK = ['onClick', 'onPointerDown', 'onMouseDown', 'onPointerUp', 'onMouseUp', 'onTap', 'onTapStart', 'whileTap']
const REACT_MOVE = ['onMouseMove', 'onPointerMove']
const REACT_PRESS = ['onClick', 'onPointerDown', 'onMouseDown', 'onPointerUp', 'onMouseUp']
const MAX_ELEMENTS = 4000

type Kind = 'hover' | 'click' | 'move'

const listened = new WeakMap<EventTarget, Set<Kind>>()
const moving = new WeakSet<EventTarget>() // listens for the pointer's position: elements, document, window
const clicking = new WeakSet<EventTarget>() // listens for clicks and presses: elements, document, window

export function hookListeners() {
  const original = EventTarget.prototype.addEventListener
  const patched = function (this: EventTarget, type: string, ...rest: unknown[]) {
    if (MOVE_EVENTS.has(type) && (this instanceof Node || this === window)) moving.add(this)
    if (CLICK_EVENTS.has(type) && (this instanceof Node || this === window)) clicking.add(this)
    if (this instanceof Element && (HOVER_EVENTS.has(type) || CLICK_EVENTS.has(type))) {
      const kinds = listened.get(this) ?? new Set()
      kinds.add(HOVER_EVENTS.has(type) ? 'hover' : 'click')
      if (MOVE_EVENTS.has(type)) kinds.add('move')
      listened.set(this, kinds)
    }
    return (original as (...args: unknown[]) => void).call(this, type, ...rest)
  }
  Object.defineProperty(EventTarget.prototype, 'addEventListener', { value: patched, writable: true, configurable: true })
}

type Fiber = { tag?: number; memoizedProps?: Record<string, unknown>; return?: Fiber | null }

function reactProps(el: Element): Record<string, unknown> | undefined {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'))
  return key ? (el as unknown as Record<string, Record<string, unknown>>)[key] : undefined
}

// React props of the DOM node, plus those of the components right above it (motion.div keeps
// whileHover/whileTap on the wrapping component, not on the <div>).
function reactKinds(el: Element): Set<Kind> {
  const kinds = new Set<Kind>()
  const scan = (props: Record<string, unknown> | undefined) => {
    if (!props) return
    if (REACT_HOVER.some((k) => props[k])) kinds.add('hover')
    if (REACT_CLICK.some((k) => props[k])) kinds.add('click')
    if (REACT_MOVE.some((k) => props[k])) kinds.add('move')
  }
  scan(reactProps(el))
  const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
  let fiber = fiberKey ? (el as unknown as Record<string, Fiber>)[fiberKey]?.return : null
  for (let depth = 0; fiber && fiber.tag !== 5 && depth < 3; depth++, fiber = fiber.return) scan(fiber.memoizedProps) // 5: host (DOM) component
  return kinds
}

export function markHandlers(root: Element) {
  const elements = [root, ...Array.from(root.querySelectorAll('*')).slice(0, MAX_ELEMENTS)]
  for (const el of elements) {
    const kinds = new Set([...(listened.get(el) ?? []), ...reactKinds(el)])
    if (kinds.size) el.setAttribute(PROBE_INTERACTIVE_ATTR, Array.from(kinds).join(' '))
  }
}

export function markInteractive(root: Element) {
  markHandlers(root)
  const pointer = pointerTarget(root)
  if (pointer) document.documentElement.setAttribute(PROBE_POINTER_ATTR, pointer)
  else document.documentElement.removeAttribute(PROBE_POINTER_ATTR)
  const click = clickTarget(root)
  if (click) document.documentElement.setAttribute(PROBE_CLICK_ATTR, click)
  else document.documentElement.removeAttribute(PROBE_CLICK_ATTR)
}

// React puts one listener for every event type on its root container, mousemove included: that says
// nothing about the page following the pointer.
function reactRoot(target: EventTarget): boolean {
  return Object.keys(target).some((k) => k.startsWith('__reactContainer$'))
}

function moves(target: EventTarget): boolean {
  return moving.has(target) && !reactRoot(target)
}

function reactMoves(el: Element): boolean {
  const props = reactProps(el)
  return !!props && REACT_MOVE.some((k) => props[k])
}

// Something follows the pointer's position: a listener on the window (a shader, a cursor follower, a
// parallax), or on the section, an element in it, or a wrapper around it. A button's hover listener is
// not that: the hover pass already plays it.
function pointerTarget(root: Element): 'window' | 'section' | null {
  if ([window, document, document.documentElement, document.body].some((t) => t && moves(t))) return 'window'
  for (let el: Element | null = root; el; el = el.parentElement) if (moves(el) || reactMoves(el)) return 'section'
  for (const el of Array.from(root.querySelectorAll('*')).slice(0, MAX_ELEMENTS)) if (moves(el) || reactMoves(el)) return 'section'
  return null
}

function presses(target: EventTarget): boolean {
  if (clicking.has(target) && !reactRoot(target)) return true
  const props = target instanceof Element ? reactProps(target) : undefined
  return !!props && REACT_PRESS.some((k) => props[k])
}

// Where a click on something without markup of its own could be handled: by a listener on the page,
// or on the section, a wrapper around it, or a container in it (event delegation).
function clickTarget(root: Element): 'page' | 'section' | null {
  if ([window, document, document.documentElement, document.body].some((t) => t && presses(t))) return 'page'
  for (let el: Element | null = root; el; el = el.parentElement) if (presses(el)) return 'section'
  for (const el of Array.from(root.querySelectorAll('*')).slice(0, MAX_ELEMENTS)) if (presses(el) && el.childElementCount) return 'section'
  return null
}
