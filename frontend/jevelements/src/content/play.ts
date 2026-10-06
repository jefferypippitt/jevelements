// Playing one hover or click on the live page and measuring what it did. Shared by the flat pass over
// a section's controls (interactions.ts) and the state explorer that walks a component's nested states
// (states.ts).
import { label, stableClasses } from '../shared/dom'
import { PROBE_BLOCKED_ATTR, PROBE_CLOCK_ATTR, PROBE_CLOCK_EVENT, PROBE_GUARD_ATTR, PROBE_GUARD_EVENT, PROBE_INTERACTIVE_ATTR } from '../shared/runtime'
import type { Interaction, InteractionPhase } from '../shared/types'
import { childrenOf, normalizeColors, tidyNumbers } from './extract'
import type { ForcedHover } from './hover'
import { PROPS } from './scroll'
import { clip, directText } from './timeline'
import type { MediaLog } from './seen'

const MAX_LINES = 14
const SETTLE_MS = 120 // let handlers run and transitions start
const MAX_ANIMATION_WAIT_MS = 1500
// After a click settles, keep watching while the UI keeps changing (a mock UI playing a sequence).
// A step is recorded each time it goes quiet for PHASE_QUIET_MS.
export const PHASE_WINDOW_MS = 6000
const PHASE_POLL_MS = 150
const PHASE_QUIET_MS = 450
const PHASE_IDLE_END_MS = 900 // nothing new for this long: the sequence is over
const MAX_PHASES = 8
const QUIET_MAX_MS = 4000
export const STYLE_PROPS = [...PROPS, 'box-shadow', 'border-color', 'outline-color', 'text-decoration-line', 'max-height', 'grid-template-rows', 'cursor']
export const STATE_ATTRS = ['aria-expanded', 'aria-selected', 'aria-pressed', 'aria-checked', 'aria-hidden', 'data-state', 'open', 'hidden']
const DANGER = /\b(delete|remove|destroy|buy|purchase|checkout|check out|pay|order|subscribe|unsubscribe|sign ?(in|up|out)|log ?(in|out)|submit|send|confirm|cancel (my|your)|add to (cart|bag|basket)|download|install|accept|reject|decline|get started)\b/i
// A mock UI: a product demo built from real markup but hidden from assistive tech. Its buttons switch
// the demo's own state (conversations, files, steps of a simulation); they aren't site navigation.
export const DEMO = '[aria-hidden="true"], [inert]'
const BUTTON = 'button, [role="button"]'

export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function textOf(el: Element): string | undefined {
  const t = el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || ''
  const flat = t.replace(/\s+/g, ' ').trim()
  return flat ? clip(flat, 60) : undefined
}

export function look(el: Element): string {
  const parent = el.parentElement
  return `${parent ? `${parent.tagName}.${stableClasses(parent).join('.')}>` : ''}${el.tagName}.${stableClasses(el).join('.')}`
}

export const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: false }) ?? el.getClientRects().length > 0

// Every element under `root` in document order, into shadow roots and through slots the way the main
// walk goes (web components keep their tabs and panels there).
export function allIn(root: Element, max = 3000): Element[] {
  const out: Element[] = []
  const visit = (el: Element) => {
    for (const child of childrenOf(el)) {
      if (out.length >= max) return
      out.push(child)
      visit(child)
    }
  }
  visit(root)
  return out
}

// The parent across shadow boundaries: a shadow root's top elements belong to their host.
export function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement
  const root = el.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

// `contains` that sees into shadow roots.
export function containsDeep(outer: Element, el: Element): boolean {
  for (let node: Element | null = el; node; node = parentOf(node)) if (node === outer) return true
  return false
}

// `cursor: pointer` set on the element itself, not inherited: a row a delegated listener handles
// (one listener on the list, or on the document) has no handler of its own, only this.
export function ownPointer(el: Element): boolean {
  if (getComputedStyle(el).cursor !== 'pointer') return false
  const parent = el.parentElement
  return !parent || getComputedStyle(parent).cursor !== 'pointer'
}

const scripted = (el: Element) => (el.getAttribute(PROBE_INTERACTIVE_ATTR) ?? '').includes('click')

// Sibling controls that look alike, where one (or a few) look selected: tabs, a segmented control, a
// pricing toggle, a sidebar, carousel dots, whatever their markup says or doesn't. Picking one of them
// changes the page in place, so they're safe to click and worth exploring.
export function switchers(els: Element[]): Set<Element> {
  const groups = new Map<Element, Element[]>()
  for (const el of els) {
    const parent = el.parentElement
    if (!parent || !visible(el)) continue
    if (!el.matches(BUTTON) && !scripted(el) && !ownPointer(el)) continue
    // Rows wrapped one per <li> are siblings one level up.
    const key = parent.children.length === 1 && parent.parentElement ? parent.parentElement : parent
    const group = groups.get(key) ?? []
    group.push(el)
    groups.set(key, group)
  }
  const out = new Set<Element>()
  for (const group of groups.values()) {
    const members = group.filter((el) => el.tagName === group[0].tagName)
    if (members.length < 2 || members.length > 24) continue
    const look = (el: Element) => `${el.getAttribute('class') ?? ''}|${['aria-selected', 'aria-current', 'aria-pressed', 'data-state', 'data-active', 'data-selected'].map((a) => el.getAttribute(a) ?? '').join(',')}`
    const counts = new Map<string, number>()
    for (const el of members) counts.set(look(el), (counts.get(look(el)) ?? 0) + 1)
    // Some look selected, most don't. All alike (a list of links) or all different (cards) isn't one.
    const odd = members.length - Math.max(...counts.values())
    if (counts.size < 2 || odd > members.length / 2) continue
    members.forEach((el) => out.add(el))
  }
  return out
}

// ---------- choosing what to click ----------

export function clickSignal(el: Element): string | null {
  if (el.matches('[role="tab"]')) return 'tab'
  if (el.matches('summary')) return '<details> toggle'
  if (el.hasAttribute('aria-expanded')) return 'aria-expanded toggle'
  if (el.matches('[aria-haspopup]:not([aria-haspopup="false"])')) return 'opens a popup'
  if (el.hasAttribute('aria-controls')) return 'controls another element'
  if (el.matches('[data-toggle], [data-bs-toggle]')) return 'toggle'
  const scripted = (el.getAttribute(PROBE_INTERACTIVE_ATTR) ?? '').includes('click')
  if (!el.matches(BUTTON) && !scripted) return null
  if (el.closest(DEMO)) return 'control in a mock UI (aria-hidden demo)'
  if (el.matches(BUTTON) && el.getAttribute('tabindex') === '-1') return 'control in a mock UI (out of the tab order)'
  return null
}

// A click listener on a container that holds controls of its own (one listener for every row of a
// list, the usual event delegation) doesn't make the container a control: its controls are the ones
// to click.
export function delegating(el: Element): boolean {
  if (el.matches(`${BUTTON}, [role="tab"], summary, [aria-expanded], [aria-haspopup], [aria-controls], a[href]`)) return false
  return !!el.querySelector(`${BUTTON}, [role="tab"], summary, [${PROBE_INTERACTIVE_ATTR}~="click"]`)
}

// Why a control must not be clicked, or null when it's safe.
export function unsafe(el: Element): string | null {
  if (el.matches('input, select, textarea, option, [contenteditable="true"]')) return 'form field'
  if (el.closest('button[type="submit"], input[type="submit"]')) return 'submits a form'
  const button = el.closest('button')
  if (button?.form && button.type !== 'button') return 'submits a form'
  const link = el.closest('a[href]')
  if (link && !/^(#|javascript:)/.test(link.getAttribute('href') ?? '')) return 'opens a link'
  if (el.closest(DEMO)) return null // a demo's "Send" or "Delete" only changes the demo
  const words = `${textOf(el) ?? ''} ${el.getAttribute('title') ?? ''} ${el.id} ${el.getAttribute('class') ?? ''}`
  if (DANGER.test(words)) return 'looks like an action, not a toggle'
  return null
}

// Turns the probe's navigation guard on or off. True when it's on: the probe answers synchronously.
// Turning it on again restarts the probe's safety timer, so a long run stays guarded.
export function guard(on: boolean): boolean {
  document.dispatchEvent(new CustomEvent(PROBE_GUARD_EVENT, { detail: on ? 'on' : 'off' }))
  return document.documentElement.hasAttribute(PROBE_GUARD_ATTR)
}

// Holds the page's long timers (a demo's tour) or lets them run again. True when they're held.
export function holdClock(on: boolean): boolean {
  document.dispatchEvent(new CustomEvent(PROBE_CLOCK_EVENT, { detail: on ? 'hold' : 'release' }))
  return document.documentElement.hasAttribute(PROBE_CLOCK_ATTR)
}

// ---------- observing ----------

export interface Snapshot {
  styles: string[][]
  classes: string[]
  texts: string[]
  attrs: string[]
  shown: boolean[]
}

export function snapshot(els: Element[]): Snapshot {
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

export function signature(root: Element): string {
  const els = [root, ...allIn(root)]
  // Plus <body>'s own children, where menus and dialogs are portaled to.
  const portals = Array.from(document.body.children)
    .filter((el) => el.tagName !== 'JEV-INSPECTOR' && el.tagName !== 'SCRIPT' && visible(el))
    .map((el) => `${el.tagName}.${el.getAttribute('class') ?? ''}`)
  return els.map((el) => `${el.getAttribute('class') ?? ''}|${STATE_ATTRS.map((a) => el.getAttribute(a) ?? '').join(',')}|${visible(el) ? 1 : 0}`).join('\n') + (root.textContent ?? '').length + portals.join(',')
}

function show(value: string): string {
  return clip(tidyNumbers(normalizeColors(value)), 90)
}

export function diff(els: Element[], before: Snapshot, after: Snapshot): string[] {
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
export function outline(el: Element, depth = 0): string {
  if (depth > 2) return '…'
  const kids = Array.from(el.children).filter(visible).slice(0, 6)
  const text = directText(el)
  const r = el.getBoundingClientRect()
  const head = `${label(el)}${depth === 0 ? ` [${Math.round(r.width)}×${Math.round(r.height)}]` : ''}${text ? ` "${clip(text, 50)}"` : ''}`
  return kids.length ? `${head} { ${kids.map((k) => outline(k, depth + 1)).join(', ')}${el.children.length > kids.length ? ', …' : ''} }` : head
}

// Outermost only: a revealed panel's children don't need their own line.
export function outermost(els: Element[]): Element[] {
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

export function cap(lines: string[]): string[] {
  const unique = Array.from(new Set(lines))
  return unique.length > MAX_LINES ? [...unique.slice(0, MAX_LINES), `…and ${unique.length - MAX_LINES} more`] : unique
}

// ---------- playing ----------

// Events go to the deepest element under the control's center, as a real click's would: a tab whose
// handler sits on the button inside it never hears an event dispatched on the tab itself.
export function pointer(el: Element, types: string[]) {
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const hit = document.elementFromPoint(x, y)
  const target = hit && el.contains(hit) ? hit : el
  const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  for (const type of types) {
    const bubbles = !/enter|leave/.test(type)
    const event = type.startsWith('pointer') ? new PointerEvent(type, { ...init, bubbles }) : new MouseEvent(type, { ...init, bubbles, buttons: type.endsWith('down') ? 1 : 0 })
    target.dispatchEvent(event)
  }
}

export const ENTER = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']
export const LEAVE = ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']
export const PRESS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']

// Waits for the handlers' effects to finish. Returns the animations that started after `known` was
// taken; finished transitions drop out of getAnimations(), so they're collected while still running.
// Without `known`, waits for every running finite animation (used while undoing).
export async function settle(known?: Set<Animation>): Promise<Animation[]> {
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

export function escape() {
  for (const target of [document.activeElement ?? document.body, document]) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }))
  }
}

// Content a script just added that is still on screen, outermost only.
export function shownAdded(added: Element[]): Element[] {
  return outermost(added.filter((el) => el.isConnected && visible(el)))
}

// Keeps watching after a click while the UI keeps changing: a mock UI that streams a reply, runs a
// tool, then shows a diff. Each time it goes quiet, the step is recorded against the previous one.
// `added` is the click's MutationObserver log, still growing. Ends when nothing new happens for
// PHASE_IDLE_END_MS; a looping effect (a blinking caret) only repeats lines already seen, so it
// doesn't count as a step and doesn't keep the watch going.
async function followPhases(root: Element, scope: Element[], start: Snapshot, added: Element[], clickedAt: number): Promise<{ phases: InteractionPhase[]; last: Snapshot }> {
  const phases: InteractionPhase[] = []
  const seen = new Set<string>()
  let previous = start
  let addedFrom = added.length
  let sig = signature(root)
  let changedAt = 0
  let lastStep = performance.now()
  while (performance.now() - clickedAt < PHASE_WINDOW_MS && phases.length < MAX_PHASES) {
    await wait(PHASE_POLL_MS)
    const now = performance.now()
    const next = signature(root)
    if (next !== sig) {
      sig = next
      changedAt = now
      continue
    }
    if (!changedAt) {
      if (now - lastStep > PHASE_IDLE_END_MS) break
      continue
    }
    if (now - changedAt < PHASE_QUIET_MS) continue
    const current = snapshot(scope)
    const changes = diff(scope, previous, current).filter((line) => !seen.has(line))
    const appeared = shownAdded(added.slice(addedFrom)).map((el) => `${root.contains(el) ? '' : 'outside the section (portal): '}${outline(el)}`)
    changedAt = 0
    previous = current
    addedFrom = added.length
    if (!changes.length && !appeared.length) continue // only a loop repeating itself
    changes.forEach((line) => seen.add(line))
    phases.push({ at: Math.round(now - clickedAt), changes: cap(changes), appeared: cap(appeared) })
    lastStep = now
  }
  return { phases, last: previous }
}

// Waits until the section stops changing (an undo click can replay a whole demo sequence), so the next
// interaction starts from a still page.
export async function quiet(root: Element, maxMs = QUIET_MAX_MS) {
  const until = performance.now() + maxMs
  let sig = signature(root)
  let stillSince = performance.now()
  while (performance.now() < until && performance.now() - stillSince < PHASE_QUIET_MS) {
    await wait(PHASE_POLL_MS)
    const next = signature(root)
    if (next !== sig) {
      sig = next
      stillSince = performance.now()
    }
  }
}

export interface PlayTarget {
  el: Element
  kind: 'hover' | 'click'
  signal: string
  similar: number
}

export interface Played {
  item: Interaction
  changed: boolean // the interaction changed something visible
  // It tried to leave the page (cancelled by the guard, or undone with history.back): the reason for
  // the skipped list. The caller stops clicking.
  blocked?: string
  navigated?: boolean // the URL changed before it could be stopped (it went back): the page may be mid-route
  when: string // "after click `button.tab`": what the media log calls this moment
  before: Snapshot
  final: Snapshot // after the click's sequence played out
  added: Element[] // nodes scripts added meanwhile
  removedFrom: Element[] // where content was taken out
  touched: Element[] // every element whose children or text changed, inside shadow roots too
  beforeSig: string
}

// A shadow root to watch and walk: open ones, and closed ones where the extension API can reach them.
function shadowOf(el: Element): ShadowRoot | null {
  if (!(el instanceof HTMLElement)) return null
  return (typeof chrome !== 'undefined' ? chrome.dom?.openOrClosedShadowRoot?.(el) : undefined) ?? el.shadowRoot
}

// Plays one hover or click against `scope` (the elements compared before and after) and records what
// changed, including the sequence a click starts. Doesn't undo it. `root` is watched for added and
// removed content, plus <body> for portals.
export async function play(c: PlayTarget, root: Element, scope: Element[], media: MediaLog, forced?: ForcedHover): Promise<Played> {
  c.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  await nextFrame()
  if (c.kind === 'click') guard(true)
  // Named before playing it: a click often changes its own classes (row → row.on).
  const target = label(c.el)
  const text = textOf(c.el)
  const when = `${c.kind === 'click' ? 'after click' : 'on hover'} \`${target}\``
  const background = STYLE_PROPS.indexOf('background-image')

  const before = snapshot(scope)
  const known = new Set(document.getAnimations())
  const added: Element[] = []
  const removed: string[] = []
  const removedFrom: Element[] = []
  const touched: Element[] = []
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      const at = rec.target instanceof Element ? rec.target : rec.target instanceof ShadowRoot ? rec.target.host : rec.target.parentElement
      if (at && !at.closest('jev-inspector')) touched.push(at)
      rec.addedNodes.forEach((node) => {
        if (!(node instanceof Element) || node.closest('jev-inspector')) return
        added.push(node)
        media.scan(node, when) // may be removed again before the diff
      })
      rec.removedNodes.forEach((node) => {
        if (!(node instanceof Element) || node.tagName === 'JEV-INSPECTOR') return
        removed.push(outline(node))
        if (rec.target instanceof Element) removedFrom.push(rec.target)
      })
    }
  })
  // Attributes too, for `touched` only: a carousel moves its track with an inline transform.
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', ...STATE_ATTRS] })
  for (const el of scope) {
    const shadow = shadowOf(el)
    if (shadow) observer.observe(shadow, { childList: true, subtree: true, characterData: true }) // web components
  }
  observer.observe(document.body, { childList: true }) // menus and modals portaled to <body>
  // A carousel that scrolls (scroll-snap, scrollLeft) changes nothing in the DOM: what scrolled counts as touched.
  const scrolled = (e: Event) => {
    const el = e.target instanceof Element ? e.target : null
    if (el) touched.push(el)
  }
  document.addEventListener('scroll', scrolled, true)
  const beforeSig = signature(root)

  const href = location.href
  const clickedAt = performance.now()
  pointer(c.el, c.kind === 'hover' ? ENTER : [...ENTER, ...PRESS])
  if (c.kind === 'hover') forced?.on(c.el)
  const ranAnimations = await settle(known)

  const item: Interaction = { kind: c.kind, target, text, similar: c.similar, signal: c.signal, changes: [], appeared: [], disappeared: [], animations: [], restored: true }
  // It tried to leave the page. The guard cancelled it, or (a back/forward, or no Navigation API)
  // the URL changed anyway: go back. Checked again after the click's sequence: a router (Angular's,
  // after its guards and resolvers) can start navigating a while after the click.
  const left = async (): Promise<Played | null> => {
    const blocked = document.documentElement.getAttribute(PROBE_BLOCKED_ATTR)
    if (blocked === null && location.href === href) return null
    observer.disconnect()
    document.removeEventListener('scroll', scrolled, true)
    forced?.off()
    const navigated = location.href !== href
    if (navigated) {
      history.back()
      await wait(800)
    } else escape()
    const where = blocked ? `tried to open ${clip(blocked, 80)}; blocked` : 'navigated to another page; went back'
    const now = snapshot(scope)
    return { item, changed: false, blocked: `\`${label(c.el)}\`${textOf(c.el) ? ` "${textOf(c.el)}"` : ''} (${where})`, navigated, when, before, final: now, added, removedFrom, touched, beforeSig }
  }
  const early = await left()
  if (early) return early

  const after = snapshot(scope)
  const addedNow = added.length
  // A click can start a sequence that runs on after the first change settled.
  const followed = c.kind === 'click' ? await followPhases(root, scope, after, added, clickedAt) : { phases: [], last: after }
  const late = await left()
  if (late) return late
  observer.disconnect()
  document.removeEventListener('scroll', scrolled, true)
  // Files this interaction put on screen: swapped sources, new backgrounds, revealed panels.
  scope.forEach((el, i) => {
    if (!after.shown[i]) return
    if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement) media.image(el, el.currentSrc || el.getAttribute('src') || '', when)
    media.background(el, after.styles[i][background], when)
  })
  const changes = diff(scope, before, after)
  const appearedEls = outermost([...scope.filter((_, i) => !before.shown[i] && after.shown[i]), ...added.slice(0, addedNow).filter((el) => el.isConnected && visible(el))])
  item.changes = cap(changes)
  item.appeared = cap(appearedEls.map((el) => `${root.contains(el) ? '' : 'outside the section (portal): '}${outline(el)}`))
  item.disappeared = cap([...outermost(scope.filter((_, i) => before.shown[i] && !after.shown[i])).map((el) => outline(el)), ...removed])
  item.animations = cap(ranAnimations.map(describeAnimation).filter((a): a is string => !!a))
  if (followed.phases.length) item.phases = followed.phases
  const changed = !!(item.changes.length || item.appeared.length || item.disappeared.length || followed.phases.length)
  return { item, changed, when, before, final: followed.last, added, removedFrom, touched, beforeSig }
}
