// Which elements react to the pointer. Only the page's own JavaScript world can see that: listeners
// added with addEventListener (vanilla, GSAP, jQuery, Motion's gestures) are recorded from
// document_start, and React handlers are read from the props React keeps on each DOM node. The content
// script reads the result from a data attribute, then hovers and clicks those elements.
import { PROBE_INTERACTIVE_ATTR, PROBE_POINTER_ATTR } from '../shared/runtime'

const HOVER_EVENTS = new Set(['mouseenter', 'mouseover', 'pointerenter', 'pointerover', 'mousemove', 'pointermove'])
const CLICK_EVENTS = new Set(['click', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart'])
const REACT_HOVER = ['onMouseEnter', 'onMouseOver', 'onPointerEnter', 'onPointerOver', 'onMouseMove', 'onPointerMove', 'onHoverStart', 'whileHover']
const REACT_CLICK = ['onClick', 'onPointerDown', 'onMouseDown', 'onPointerUp', 'onMouseUp', 'onTap', 'onTapStart', 'whileTap']
const MAX_ELEMENTS = 4000

const listened = new WeakMap<EventTarget, Set<'hover' | 'click'>>()

export function hookListeners() {
  const original = EventTarget.prototype.addEventListener
  const patched = function (this: EventTarget, type: string, ...rest: unknown[]) {
    if (this instanceof Element && (HOVER_EVENTS.has(type) || CLICK_EVENTS.has(type))) {
      const kinds = listened.get(this) ?? new Set()
      kinds.add(HOVER_EVENTS.has(type) ? 'hover' : 'click')
      listened.set(this, kinds)
    }
    return (original as (...args: unknown[]) => void).call(this, type, ...rest)
  }
  Object.defineProperty(EventTarget.prototype, 'addEventListener', { value: patched, writable: true, configurable: true })
}

type Fiber = { tag?: number; memoizedProps?: Record<string, unknown>; return?: Fiber | null }

// React props of the DOM node, plus those of the components right above it (motion.div keeps
// whileHover/whileTap on the wrapping component, not on the <div>).
function reactKinds(el: Element): Set<'hover' | 'click'> {
  const kinds = new Set<'hover' | 'click'>()
  const keys = Object.keys(el)
  const scan = (props: Record<string, unknown> | undefined) => {
    if (!props) return
    if (REACT_HOVER.some((k) => props[k])) kinds.add('hover')
    if (REACT_CLICK.some((k) => props[k])) kinds.add('click')
  }
  const propsKey = keys.find((k) => k.startsWith('__reactProps$'))
  if (propsKey) scan((el as unknown as Record<string, Record<string, unknown>>)[propsKey])
  const fiberKey = keys.find((k) => k.startsWith('__reactFiber$'))
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
}

function listens(target: EventTarget): boolean {
  return listened.get(target)?.has('hover') ?? false
}

// A gallery that follows the cursor listens on the window, or on the section itself. A button's
// hover listener is not that: the hover pass already plays it.
function pointerTarget(root: Element): 'window' | 'section' | null {
  if (listens(window) || listens(document) || listens(document.documentElement) || listens(document.body)) return 'window'
  if (listens(root) || root.getAttribute(PROBE_INTERACTIVE_ATTR)?.includes('hover')) return 'section'
  return null
}
