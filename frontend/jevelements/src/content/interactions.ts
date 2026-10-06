// Plays the section's hover and click interactions on the live page and records what they do:
// styles, classes, text and attributes that change, content that appears (dropdowns, tab panels,
// accordions, menus portaled to <body>), and the transitions/animations that run. No screenshots:
// images an interaction brings on screen are logged instead, so they are downloaded with the rest.
//
// Events are synthetic pointer sequences, which is what JavaScript handlers listen to (vanilla, GSAP,
// React, Framer Motion's whileHover/whileTap, Radix's pointerdown triggers). Synthetic events don't
// switch on CSS :hover, so hovers also apply the stylesheet's :hover rules (see hover.ts). That covers
// buttons, links and feature cards whose hover is pure CSS.
//
// Clicks can start a sequence (a mock UI streams a reply, runs a tool, shows a diff): it is followed
// step by step until it goes quiet, and the region whose content changed is then read again as a full
// tree (a layer: another state of the section to build).
//
// Controls that switch the state of a bigger component (a mock UI's sidebar rows and tabs, a tab set
// with its panels) aren't played here: states.ts explores that component's states as a graph, down
// to the controls that only exist after a click.
//
// Safety: only controls that say in their markup that they change the page in place are clicked
// (tabs, disclosures, menus), plus the buttons of mock UIs (product demos hidden from assistive tech).
// Other buttons and links are only hovered, since nothing tells a "Download" button that routes to
// /download apart from one that opens a panel. While it runs, the
// page probe's navigation guard (probe/guard.ts) cancels anything that would leave the page; if it
// fires, clicking stops. Without the probe nothing is clicked. After each interaction it tries to
// undo it.
import { label } from '../shared/dom'
import { PROBE_INTERACTIVE_ATTR, PROBE_POINTER_ATTR } from '../shared/runtime'
import type { CapturedNode, Interaction, InteractionReport } from '../shared/types'
import type { LayerReader } from './extract'
import { ForcedHover, hoverTarget, type HoverRule } from './hover'
import { allIn, cap, clickSignal, containsDeep, parentOf, delegating, diff, escape, guard, LEAVE, look, nextFrame, outermost, play, pointer, PRESS, quiet, settle, shownAdded, signature, snapshot, switchers, textOf, unsafe, visible, type Snapshot } from './play'
import { MediaLog } from './seen'
import { componentAround, componentOf, exploreComponent, outermostComponents, type Component } from './states'

const MAX_HOVERS = 16
const MAX_CLICKS = 16
const MAX_SAME_LOOK = 2 // hover at most this many of a repeated element (cards, dots)
const MAX_SAME_LOOK_CLICK = 6 // each tab or demo row usually brings up different content
const MAX_TRACKED = 600
const BUDGET_MS = 90_000 // clicks that start a sequence take seconds each
const EXPLORE_BUDGET_MS = 150_000 // for every component's states together, after the flat pass
const MAX_LAYERS = 12 // alternate-state trees per capture
const MIN_LAYER_ELEMENTS = 3 // smaller changes are described by the change lines alone

export interface InteractionOptions {
  onProgress?: (done: number, total: number) => void
  onExplore?: (component: string, states: number) => void // a component's state explorer found another state
}

interface Candidate {
  el: Element
  kind: 'hover' | 'click'
  signal: string
  similar: number
  // To find it again if a script rendered it anew meanwhile (a carousel that plays itself): which one
  // of the elements with its look and text it was.
  find: { look: string; text: string; nth: number }
}

// The live element for a candidate, the same one or its re-rendered copy.
function relocate(root: Element, c: Candidate): Element | null {
  if (c.el.isConnected) return c.el
  const same = allIn(root).filter((el) => look(el) === c.find.look && (textOf(el) ?? '') === c.find.text)
  return same[c.find.nth] ?? null
}

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

function candidates(root: Element, tracked: Element[], cssTargets: string[]): { list: Candidate[]; skipped: string[]; components: Component[] } {
  const hovers: Candidate[] = []
  const clicks: Candidate[] = []
  const skipped: string[] = []
  const components: Component[] = []
  const seen = new Map<string, Candidate[]>()
  const clickable = new Set<Element>()
  const add = (list: Candidate[], cap: number, el: Element, kind: 'hover' | 'click', signal: string) => {
    const key = `${kind}|${look(el)}`
    const same = seen.get(key) ?? []
    if (same.length >= (kind === 'click' ? MAX_SAME_LOOK_CLICK : MAX_SAME_LOOK)) {
      same[0].similar++
      return
    }
    if (list.length >= cap) return
    const text = textOf(el) ?? ''
    const nth = tracked.filter((other) => other !== el && look(other) === look(el) && (textOf(other) ?? '') === text && other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).length
    const c = { el, kind, signal, similar: 0, find: { look: look(el), text, nth } }
    same.push(c)
    seen.set(key, same)
    list.push(c)
  }
  // Look-alike siblings where one looks selected switch the page in place, marked up or not.
  const picks = switchers(tracked)
  for (const el of tracked) {
    if (!visible(el)) continue
    const hover = hoverSignal(el, cssTargets)
    if (hover) add(hovers, MAX_HOVERS, el, 'hover', hover)
    const click = clickSignal(el) ?? (picks.has(el) ? 'one of a row of look-alike controls where one looks selected (tabs, a toggle, a sidebar)' : null)
    if (!click || delegating(el)) continue
    // A control inside a control (icon inside a trigger, label inside a row) is the same control.
    // `tracked` is in document order, so the outer one was seen first.
    const inner = Array.from(clickable).some((outer) => outer.contains(el))
    clickable.add(el)
    if (inner) continue
    const reason = unsafe(el)
    if (reason) {
      if (skipped.length < 10 && reason !== 'form field') skipped.push(`\`${label(el)}\`${textOf(el) ? ` "${textOf(el)}"` : ''} (${reason})`)
      continue
    }
    // Part of a component with states of its own: the explorer finds its controls itself, so it
    // isn't held to MAX_CLICKS.
    const component = componentOf(root, el)
    if (component) {
      components.push(component)
      continue
    }
    add(clicks, MAX_CLICKS, el, 'click', click)
  }
  return { list: [...hovers, ...clicks], skipped, components: outermostComponents(components) }
}

// ---------- the pointer sweep ----------

function movePointer(x: number, y: number) {
  const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  window.dispatchEvent(new PointerEvent('pointermove', init))
  window.dispatchEvent(new MouseEvent('mousemove', init))
  const hit = document.elementFromPoint(x, y)
  if (hit && hit.tagName !== 'JEV-INSPECTOR') {
    hit.dispatchEvent(new PointerEvent('pointermove', init))
    hit.dispatchEvent(new MouseEvent('mousemove', init))
  }
}

// One pass across the section, for a gallery or cursor effect that follows the pointer. Hover only
// samples the center. Nothing is pressed, so it doesn't activate links.
async function pointerSweep(root: Element, scope: Element[]): Promise<Interaction | null> {
  const mode = document.documentElement.getAttribute(PROBE_POINTER_ATTR)
  if (mode !== 'window' && mode !== 'section') return null
  const box = root.getBoundingClientRect()
  if (box.width < 40 || box.height < 40) return null
  const stops = [0.15, 0.5, 0.85]
  const samples: Snapshot[] = []
  for (const stop of stops) {
    movePointer(box.left + box.width * stop, box.top + box.height * 0.5)
    await nextFrame()
    samples.push(snapshot(scope))
  }
  movePointer(box.left + box.width / 2, box.top - 20)
  const first = samples[0]
  if (!first) return null
  const changes: string[] = []
  for (let index = 1; index < samples.length; index++) {
    const sample = samples[index]
    if (!sample) continue
    const at = Math.round((stops[index] ?? 0) * 100)
    for (const line of diff(scope, first, sample)) changes.push(`at ${at}% across: ${line}`)
  }
  if (!changes.length) return null
  return {
    kind: 'pointer',
    target: label(root),
    similar: 0,
    signal: mode === 'window' ? 'the page listens for mousemove on the window' : 'the section listens for the pointer',
    changes: cap(changes),
    appeared: [],
    disappeared: [],
    animations: [],
    restored: true,
  }
}

// The smallest element holding every piece of content a click changed: the region to read as a layer.
// Inside the section, clamped to it; content portaled outside it is its own region.
function regions(root: Element, changed: Element[]): Element[] {
  const inside = changed.filter((el) => el.isConnected && root.contains(el))
  const out: Element[] = []
  if (inside.length) {
    let common = inside[0]
    for (const el of inside.slice(1)) while (!common.contains(el) && common !== root) common = common.parentElement ?? root
    out.push(common)
  }
  const portal = outermost(changed.filter((el) => el.isConnected && !root.contains(el) && !el.closest('jev-inspector')))[0]
  if (portal) out.push(portal)
  return out.filter((el) => el.querySelectorAll('*').length >= MIN_LAYER_ELEMENTS)
}

export async function recordInteractions(
  root: Element,
  tracked: [Element, CapturedNode][],
  hoverRules: HoverRule[],
  layers: LayerReader,
  { onProgress, onExplore }: InteractionOptions = {},
  moved: Set<Element> = new Set(), // changed by itself during the capture's idle watch (timeline.ts)
): Promise<InteractionReport> {
  const started = performance.now()
  const startY = window.scrollY
  const els = tracked.slice(0, MAX_TRACKED).map(([el]) => el)
  const cssTargets = Array.from(new Set(hoverRules.map((r) => hoverTarget(r.selector)).filter((t): t is string => !!t)))
  // Every captured element can be played (a demo deep in a big hero is past MAX_TRACKED); the
  // before/after comparison stays on the first MAX_TRACKED plus the section's live elements.
  // From the live page, shadow roots included: what the capture saw first may have been rendered anew.
  const found = candidates(root, [root, ...allIn(root, 6000)], cssTargets)
  let layerCount = 0
  const forced = new ForcedHover(hoverRules)
  const report: InteractionReport = { tested: { hover: 0, click: 0, pointer: 0 }, skipped: found.skipped, items: [] }
  const media = new MediaLog()

  // Nothing leaves the page: the probe cancels navigations while this runs. Without it, only hover.
  const guarded = guard(true)
  const list = guarded ? found.list : found.list.filter((c) => c.kind === 'hover')
  if (!guarded && (list.length < found.list.length || found.components.length)) report.skipped.push('every click (the page probe that blocks navigation was not available)')
  let stopped = false // a click tried to leave the page: no more clicks

  try {
    for (const [n, c] of list.entries()) {
      if (performance.now() - started > BUDGET_MS) break
      onProgress?.(n, list.length)
      const live = relocate(root, c)
      if (!live || !visible(live)) continue
      c.el = live
      // Its component was found by an earlier click: the explorer plays it.
      if (c.kind === 'click' && found.components.some((k) => containsDeep(k.root, c.el))) continue
      report.tested[c.kind]++
      const scope = Array.from(new Set([...els, ...allIn(root)]))
      // Where the control sits, kept before the click: a click that renders it anew detaches it.
      const chain: Element[] = []
      for (let node: Element | null = c.el; node && node !== root; node = parentOf(node)) chain.push(node)
      const played = await play(c, root, scope, media, forced)
      if (played.blocked) {
        report.skipped.push(played.blocked)
        // The guard cancelled it before anything happened: only this control is skipped. If the URL
        // changed, or the section did anyway (a router half-way into another page), clicking stops.
        await quiet(root)
        if (played.navigated || signature(root) !== played.beforeSig) {
          stopped = true
          break
        }
        continue
      }
      const { item, before, final, added, removedFrom, beforeSig } = played

      // The content the click brought up, read in full once its sequence has played: another state of
      // the section to build. Only for clicks that replaced content, not a highlight or a label.
      const contentChanged = [
        ...shownAdded(added),
        ...scope.filter((_, i) => (!before.shown[i] && final.shown[i]) || (final.shown[i] && before.texts[i] !== final.texts[i])),
        ...removedFrom,
      ]
      if (c.kind === 'click' && contentChanged.length && layerCount < MAX_LAYERS) {
        for (const region of regions(root, contentChanged)) {
          const read = layers.read(region)
          if (!read) continue
          item.layers = [...(item.layers ?? []), { target: label(region), tree: read.tree }]
          for (const asset of read.assets) media.add(asset, played.when)
          layerCount++
        }
      }
      // A click that switched content where more controls are: a component with states of its own,
      // whatever its markup. The explorer takes it over (its other controls aren't played here).
      if (c.kind === 'click' && contentChanged.length) {
        const component = componentAround(root, chain.find((node) => node.isConnected) ?? root, contentChanged, moved)
        if (component && !found.components.some((k) => containsDeep(k.root, component.root))) {
          found.components = [...found.components.filter((k) => !containsDeep(component.root, k.root)), component]
          item.layers = undefined // its states are read in full by the explorer
        }
      }

      // Undo: leave for hovers. For clicks: press what was selected before (the tab, or the demo row
      // that lost its highlight), else the same control again, then Escape.
      forced.off()
      pointer(c.el, LEAVE)
      if (c.kind === 'click') {
        const selected =
          (c.el.matches('[role="tab"]') ? scope.find((el, i) => el !== c.el && el.matches('[role="tab"]') && before.attrs[i].includes('aria-selected=true')) : undefined) ??
          scope.find((el, i) => el !== c.el && final.shown[i] && look(el) === look(c.el) && (before.classes[i] !== final.classes[i] || before.attrs[i] !== final.attrs[i] || before.styles[i].join() !== final.styles[i].join()))
        if (signature(root) !== beforeSig) {
          pointer(selected ?? c.el, PRESS)
          await settle()
        }
        if (signature(root) !== beforeSig) {
          escape()
          await settle()
        }
        pointer(c.el, LEAVE)
      }
      await settle()
      if (c.kind === 'click') await quiet(root)
      item.restored = signature(root) === beforeSig
      if (played.changed) report.items.push(item)
    }

    // Components with states of their own, explored click by click down to their nested controls.
    if (guarded && !stopped && found.components.length) {
      const until = performance.now() + EXPLORE_BUDGET_MS
      report.components = []
      // Smallest first: each gets an even share of the time that's left, so what a small one doesn't
      // use goes to the big demo after it.
      const size = (c: Component) => allIn(c.root).filter((el) => clickSignal(el)).length
      found.components.sort((a, b) => size(a) - size(b))
      for (const [i, component] of found.components.entries()) {
        if (!component.root.isConnected) continue
        // An even share of what's left, so one big demo can't starve the others.
        const deadline = performance.now() + (until - performance.now()) / (found.components.length - i)
        const name = label(component.root)
        onExplore?.(name, 1)
        const autoplay = Array.from(moved).some((el) => containsDeep(component.root, el))
        const explored = await exploreComponent(component, { section: root, layers, media, deadline, autoplay, moved, onState: (states) => onExplore?.(name, states) })
        report.tested.click += explored.clicks
        report.items.push(...explored.items)
        report.skipped.push(...explored.skipped)
        report.components.push(explored.result)
        if (explored.blocked) {
          report.skipped.push(explored.blocked)
          break
        }
      }
    }

    const sweep = await pointerSweep(root, els)
    if (sweep) {
      report.tested.pointer++
      report.items.push(sweep)
    }
  } finally {
    guard(false)
    forced.dispose()
    root.querySelectorAll(`[${PROBE_INTERACTIVE_ATTR}]`).forEach((el) => el.removeAttribute(PROBE_INTERACTIVE_ATTR))
    root.removeAttribute(PROBE_INTERACTIVE_ATTR)
    document.documentElement.removeAttribute(PROBE_POINTER_ATTR)
    window.scrollTo({ top: startY, behavior: 'instant' })
  }
  report.media = media.assets
  return report
}
