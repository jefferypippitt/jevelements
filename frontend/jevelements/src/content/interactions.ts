// Plays the section's hover and click interactions on the live page and records what they do:
// styles, classes, text and attributes that change, content that appears (dropdowns, tab panels,
// accordions, modals portaled to <body>), and the transitions/animations that run. No screenshots:
// images an interaction brings on screen are logged instead, so they are downloaded with the rest.
//
// Events are synthetic pointer sequences, which is what JavaScript handlers listen to (vanilla, GSAP,
// React, Framer Motion's whileHover/whileTap, Radix's pointerdown triggers). Synthetic events don't
// switch on CSS :hover, so hovers also apply the stylesheet's :hover rules (see hover.ts). That covers
// buttons, links and feature cards whose hover is pure CSS.
//
// Safety: while it runs, link navigation and form submits are cancelled, and buttons that look
// destructive or transactional are never clicked. After each interaction it tries to undo it.
import { label, stableClasses } from '../shared/dom'
import { PROBE_INTERACTIVE_ATTR } from '../shared/runtime'
import type { CapturedNode, Interaction, InteractionReport } from '../shared/types'
import { normalizeColors, tidyNumbers } from './extract'
import { ForcedHover, hoverTarget, type HoverRule } from './hover'
import { PROPS } from './scroll'
import { clip, directText } from './timeline'
import { MediaLog } from './seen'

const MAX_HOVERS = 16
const MAX_CLICKS = 12
const MAX_SAME_LOOK = 2 // play at most this many of a repeated element (cards, dots, tabs)
const MAX_TRACKED = 600
const MAX_LINES = 14
const BUDGET_MS = 30_000
const SETTLE_MS = 120 // let handlers run and transitions start
const MAX_ANIMATION_WAIT_MS = 1500
const STYLE_PROPS = [...PROPS, 'box-shadow', 'border-color', 'outline-color', 'text-decoration-line', 'max-height', 'grid-template-rows', 'cursor']
const STATE_ATTRS = ['aria-expanded', 'aria-selected', 'aria-pressed', 'aria-checked', 'aria-hidden', 'data-state', 'open', 'hidden']
const DANGER = /\b(delete|remove|destroy|buy|purchase|checkout|check out|pay|order|subscribe|unsubscribe|sign ?out|log ?out|submit|send|confirm|cancel (my|your)|add to (cart|bag|basket)|download|install|accept|reject|decline)\b/i
const CLICKABLE = 'button, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], [role="option"], summary, [aria-expanded], [aria-controls], [aria-haspopup], [data-state], [data-toggle], [data-bs-toggle]'

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface InteractionOptions {
  onProgress?: (done: number, total: number) => void
}

interface Candidate {
  el: Element
  kind: 'hover' | 'click'
  signal: string
  similar: number
}

function textOf(el: Element): string | undefined {
  const t = el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || ''
  const flat = t.replace(/\s+/g, ' ').trim()
  return flat ? clip(flat, 60) : undefined
}

function look(el: Element): string {
  const parent = el.parentElement
  return `${parent ? `${parent.tagName}.${stableClasses(parent).join('.')}>` : ''}${el.tagName}.${stableClasses(el).join('.')}`
}

const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: false }) ?? el.getClientRects().length > 0

// ---------- choosing what to play ----------

function matches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector)
  } catch {
    return false
  }
}

// `cssTargets`: elements the stylesheet's :hover rules hang on (buttons, cards, links).
function hoverSignal(el: Element, cssTargets: string[]): string | null {
  const marks = el.getAttribute(PROBE_INTERACTIVE_ATTR) ?? ''
  if (marks.includes('hover')) return 'hover handler in the page script'
  if (el.hasAttribute('data-highlight')) return 'Framer hover variant'
  if (cssTargets.some((t) => matches(el, t))) return 'CSS :hover rule'
  // cursor: pointer is inherited; only the element that sets it counts (a card, not each line in it).
  const cursor = getComputedStyle(el).cursor
  if (cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer')) return 'cursor: pointer'
  return null
}

function clickSignal(el: Element): string | null {
  const marks = el.getAttribute(PROBE_INTERACTIVE_ATTR) ?? ''
  if (el.matches('[role="tab"]')) return 'tab'
  if (el.matches('summary')) return '<details> toggle'
  if (el.hasAttribute('aria-expanded')) return 'aria-expanded toggle'
  if (el.hasAttribute('aria-haspopup')) return 'opens a popup'
  if (el.hasAttribute('aria-controls')) return 'controls another element'
  if (marks.includes('click')) return 'click handler in the page script'
  if (el.matches(CLICKABLE)) return el.tagName === 'BUTTON' ? 'button' : 'clickable element'
  return null
}

// Why an element must not be clicked, or null when it's safe.
function unsafe(el: Element): string | null {
  if (el.matches('input, select, textarea, option, [contenteditable="true"]')) return 'form field'
  if (el.closest('button[type="submit"], input[type="submit"]')) return 'submits a form'
  const button = el.closest('button')
  if (button?.form && button.type !== 'button') return 'submits a form'
  const link = el.closest('a[href]')
  const href = link?.getAttribute('href') ?? ''
  if (link && !/^(#|javascript:)/.test(href) && !el.matches('[role="tab"], [aria-expanded], [aria-controls], [aria-haspopup]')) return 'navigates to another page'
  const words = `${textOf(el) ?? ''} ${el.getAttribute('title') ?? ''} ${el.id} ${el.getAttribute('class') ?? ''}`
  if (DANGER.test(words)) return 'looks destructive or transactional'
  return null
}

function candidates(tracked: Element[], cssTargets: string[]): { list: Candidate[]; skipped: string[] } {
  const hovers: Candidate[] = []
  const clicks: Candidate[] = []
  const skipped: string[] = []
  const seen = new Map<string, Candidate[]>()
  const add = (list: Candidate[], cap: number, el: Element, kind: 'hover' | 'click', signal: string) => {
    const key = `${kind}|${look(el)}`
    const same = seen.get(key) ?? []
    if (same.length >= MAX_SAME_LOOK) {
      same[0].similar++
      return
    }
    if (list.length >= cap) return
    const c = { el, kind, signal, similar: 0 }
    same.push(c)
    seen.set(key, same)
    list.push(c)
  }
  for (const el of tracked) {
    if (!visible(el)) continue
    const hover = hoverSignal(el, cssTargets)
    if (hover) add(hovers, MAX_HOVERS, el, 'hover', hover)
    const click = clickSignal(el)
    if (!click) continue
    // A clickable child inside a clickable parent (icon inside a button) is the same control.
    if (el.parentElement?.closest(CLICKABLE) && el.parentElement.closest(CLICKABLE) !== el && tracked.includes(el.parentElement.closest(CLICKABLE)!)) continue
    const reason = unsafe(el)
    if (reason) {
      if (skipped.length < 10 && reason !== 'navigates to another page' && reason !== 'form field') skipped.push(`\`${label(el)}\`${textOf(el) ? ` "${textOf(el)}"` : ''} (${reason})`)
      continue
    }
    add(clicks, MAX_CLICKS, el, 'click', click)
  }
  return { list: [...hovers, ...clicks], skipped }
}

// ---------- observing ----------

interface Snapshot {
  styles: string[][]
  classes: string[]
  texts: string[]
  attrs: string[]
  shown: boolean[]
}

function snapshot(els: Element[]): Snapshot {
  return {
    styles: els.map((el) => {
      const cs = getComputedStyle(el)
      return STYLE_PROPS.map((p) => cs.getPropertyValue(p))
    }),
    classes: els.map((el) => el.getAttribute('class') ?? ''),
    texts: els.map((el) => directText(el)),
    attrs: els.map((el) => STATE_ATTRS.map((a) => (el.hasAttribute(a) ? `${a}=${el.getAttribute(a)}` : '')).filter(Boolean).join(' ')),
    shown: els.map(visible),
  }
}

function signature(root: Element): string {
  const els = [root, ...Array.from(root.querySelectorAll('*')).slice(0, 3000)]
  // Plus <body>'s own children, where menus and dialogs are portaled to.
  const portals = Array.from(document.body.children)
    .filter((el) => el.tagName !== 'JEV-INSPECTOR' && el.tagName !== 'SCRIPT' && visible(el))
    .map((el) => `${el.tagName}.${el.getAttribute('class') ?? ''}`)
  return els.map((el) => `${el.getAttribute('class') ?? ''}|${STATE_ATTRS.map((a) => el.getAttribute(a) ?? '').join(',')}|${visible(el) ? 1 : 0}`).join('\n') + (root.textContent ?? '').length + portals.join(',')
}

function show(value: string): string {
  return clip(tidyNumbers(normalizeColors(value)), 90)
}

function diff(els: Element[], before: Snapshot, after: Snapshot): string[] {
  const lines: string[] = []
  els.forEach((el, i) => {
    const target = `\`${label(el)}\``
    if (before.shown[i] !== after.shown[i]) return // reported as appeared/disappeared
    STYLE_PROPS.forEach((prop, k) => {
      if (before.styles[i][k] !== after.styles[i][k]) lines.push(`${target} ${prop}: ${show(before.styles[i][k])} → ${show(after.styles[i][k])}`)
    })
    if (before.classes[i] !== after.classes[i]) lines.push(`${target} class ${JSON.stringify(before.classes[i])} → ${JSON.stringify(after.classes[i])}`)
    if (before.texts[i] !== after.texts[i]) lines.push(`${target} text ${JSON.stringify(before.texts[i])} → ${JSON.stringify(after.texts[i])}`)
    if (before.attrs[i] !== after.attrs[i]) lines.push(`${target} ${before.attrs[i] || '(no state)'} → ${after.attrs[i] || '(no state)'}`)
  })
  return lines
}

// A compact outline of new content: tags, classes and text, a few levels deep.
function outline(el: Element, depth = 0): string {
  if (depth > 2) return '…'
  const kids = Array.from(el.children).filter(visible).slice(0, 6)
  const text = directText(el)
  const r = el.getBoundingClientRect()
  const head = `${label(el)}${depth === 0 ? ` [${Math.round(r.width)}×${Math.round(r.height)}]` : ''}${text ? ` "${clip(text, 50)}"` : ''}`
  return kids.length ? `${head} { ${kids.map((k) => outline(k, depth + 1)).join(', ')}${el.children.length > kids.length ? ', …' : ''} }` : head
}

// Outermost only: a revealed panel's children don't need their own line.
function outermost(els: Element[]): Element[] {
  const set = new Set(els)
  return els.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false
    return true
  })
}

function describeAnimation(a: Animation): string | null {
  const effect = a.effect
  if (!(effect instanceof KeyframeEffect) || !effect.target) return null
  const t = effect.getTiming()
  const timing = `${Math.round(Number(t.duration) || 0)}ms${t.delay ? ` delay ${t.delay}ms` : ''} ${t.easing ?? 'linear'}`
  const target = `\`${label(effect.target)}${effect.pseudoElement ?? ''}\``
  if (a instanceof CSSTransition) return `${target} transition ${a.transitionProperty} ${timing}`
  if (a instanceof CSSAnimation) return `${target} animation ${a.animationName} ${timing}`
  const frames = effect.getKeyframes()
  const props = Array.from(new Set(frames.flatMap((f) => Object.keys(f).filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)))))
  const values = props.map((p) => `${p} ${frames.map((f) => show(String(f[p] ?? ''))).join(' → ')}`).join('; ')
  return `${target} script animation (Web Animations, e.g. Motion) ${timing}: ${clip(values, 200)}`
}

function cap(lines: string[]): string[] {
  const unique = Array.from(new Set(lines))
  return unique.length > MAX_LINES ? [...unique.slice(0, MAX_LINES), `…and ${unique.length - MAX_LINES} more`] : unique
}

// ---------- playing ----------

function pointer(el: Element, types: string[]) {
  const r = el.getBoundingClientRect()
  const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  for (const type of types) {
    const bubbles = !/enter|leave/.test(type)
    const event = type.startsWith('pointer') ? new PointerEvent(type, { ...init, bubbles }) : new MouseEvent(type, { ...init, bubbles, buttons: type.endsWith('down') ? 1 : 0 })
    el.dispatchEvent(event)
  }
}

const ENTER = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']
const LEAVE = ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']
const PRESS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']

function escape() {
  for (const target of [document.activeElement ?? document.body, document]) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }))
  }
}

// Waits for the handlers' effects to finish. Returns the animations that started after `known` was
// taken; finished transitions drop out of getAnimations(), so they're collected while still running.
// Without `known`, waits for every running finite animation (used while undoing).
async function settle(known?: Set<Animation>): Promise<Animation[]> {
  await nextFrame()
  const started: Animation[] = []
  const collect = () => {
    for (const a of document.getAnimations()) if (known && !known.has(a) && !started.includes(a)) started.push(a)
  }
  collect()
  await wait(SETTLE_MS)
  collect()
  const running = (known ? started : document.getAnimations()).filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
  if (running.length) await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => undefined))), wait(MAX_ANIMATION_WAIT_MS)])
  await nextFrame()
  return started
}

export async function recordInteractions(
  root: Element,
  tracked: [Element, CapturedNode][],
  hoverRules: HoverRule[],
  { onProgress }: InteractionOptions = {},
): Promise<InteractionReport> {
  const started = performance.now()
  const startY = window.scrollY
  const els = tracked.slice(0, MAX_TRACKED).map(([el]) => el)
  const cssTargets = Array.from(new Set(hoverRules.map((r) => hoverTarget(r.selector)).filter((t): t is string => !!t)))
  const { list, skipped } = candidates(els, cssTargets)
  const forced = new ForcedHover(hoverRules)
  const report: InteractionReport = { tested: { hover: 0, click: 0 }, skipped, items: [] }
  const media = new MediaLog()
  const background = STYLE_PROPS.indexOf('background-image')

  // Nothing leaves the page while we click: links and form submits are cancelled before the browser
  // acts on them (handlers on the page still run).
  const guardClick = (e: Event) => {
    const link = (e.target as Element | null)?.closest?.('a[href]')
    if (link && !/^(#|javascript:)/.test(link.getAttribute('href') ?? '')) e.preventDefault()
  }
  const guardSubmit = (e: Event) => e.preventDefault()
  window.addEventListener('click', guardClick, true)
  window.addEventListener('submit', guardSubmit, true)

  try {
    for (const [n, c] of list.entries()) {
      if (performance.now() - started > BUDGET_MS) break
      onProgress?.(n, list.length)
      if (!c.el.isConnected || !visible(c.el)) continue
      c.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
      await nextFrame()
      report.tested[c.kind]++
      const when = `${c.kind === 'click' ? 'after click' : 'on hover'} \`${label(c.el)}\``

      const scope = Array.from(new Set([...els, ...Array.from(root.querySelectorAll('*')).slice(0, 3000)]))
      const before = snapshot(scope)
      const known = new Set(document.getAnimations())
      const added: Element[] = []
      const removed: string[] = []
      const observer = new MutationObserver((records) => {
        for (const rec of records) {
          rec.addedNodes.forEach((node) => {
            if (!(node instanceof Element) || node.closest('jev-inspector')) return
            added.push(node)
            media.scan(node, when) // may be removed again before the diff
          })
          rec.removedNodes.forEach((node) => node instanceof Element && node.tagName !== 'JEV-INSPECTOR' && removed.push(outline(node)))
        }
      })
      observer.observe(root, { childList: true, subtree: true })
      observer.observe(document.body, { childList: true }) // menus and modals portaled to <body>
      const beforeSig = signature(root)

      const href = location.href
      pointer(c.el, c.kind === 'hover' ? ENTER : [...ENTER, ...PRESS])
      if (c.kind === 'hover') forced.on(c.el)
      const ranAnimations = await settle(known)
      // A client-side router navigated (router.push in a click handler): go back and stop clicking.
      if (location.href !== href) {
        observer.disconnect()
        history.back()
        await wait(800)
        report.skipped.push(`\`${label(c.el)}\`${textOf(c.el) ? ` "${textOf(c.el)}"` : ''} (navigated to another page; went back)`)
        break
      }
      observer.disconnect()

      const after = snapshot(scope)
      // Files this interaction put on screen: swapped sources, new backgrounds, revealed panels.
      scope.forEach((el, i) => {
        if (!after.shown[i]) return
        if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement) media.image(el, el.currentSrc || el.getAttribute('src') || '', when)
        media.background(el, after.styles[i][background], when)
      })
      const changes = diff(scope, before, after)
      const appearedEls = outermost([
        ...scope.filter((_, i) => !before.shown[i] && after.shown[i]),
        ...added.filter((el) => el.isConnected && visible(el)),
      ])
      const appeared = appearedEls.map((el) => `${root.contains(el) ? '' : 'outside the section (portal): '}${outline(el)}`)
      const disappeared = [...outermost(scope.filter((_, i) => before.shown[i] && !after.shown[i])).map((el) => outline(el)), ...removed]
      const animations = ranAnimations.map(describeAnimation).filter((a): a is string => !!a)

      const item: Interaction = {
        kind: c.kind,
        target: label(c.el),
        text: textOf(c.el),
        similar: c.similar,
        signal: c.signal,
        changes: cap(changes),
        appeared: cap(appeared),
        disappeared: cap(disappeared),
        animations: cap(animations),
        restored: true,
      }
      const changed = changes.length || appeared.length || disappeared.length

      // Undo: leave for hovers; for clicks, the originally selected tab, a second click, then Escape.
      forced.off()
      pointer(c.el, LEAVE)
      if (c.kind === 'click') {
        const selected = c.el.matches('[role="tab"]') ? scope.find((el, i) => el !== c.el && el.matches('[role="tab"]') && before.attrs[i].includes('aria-selected=true')) : undefined
        if (signature(root) !== beforeSig) {
          if (selected) pointer(selected, PRESS)
          else pointer(c.el, PRESS)
          await settle()
        }
        if (signature(root) !== beforeSig) {
          escape()
          await settle()
        }
        pointer(c.el, LEAVE)
      }
      await settle()
      item.restored = signature(root) === beforeSig
      if (changed) report.items.push(item)
    }
  } finally {
    forced.dispose()
    window.removeEventListener('click', guardClick, true)
    window.removeEventListener('submit', guardSubmit, true)
    root.querySelectorAll(`[${PROBE_INTERACTIVE_ATTR}]`).forEach((el) => el.removeAttribute(PROBE_INTERACTIVE_ATTR))
    root.removeAttribute(PROBE_INTERACTIVE_ATTR)
    window.scrollTo({ top: startY, behavior: 'instant' })
  }
  report.media = media.assets
  return report
}
