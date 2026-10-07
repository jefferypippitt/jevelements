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
//
// Hidden clicks: elements nothing in the markup announces as clickable, but that a script handles (a
// React onClick on a card, or `cursor: pointer` under a listener that delegates, one on the page or a
// container that checks what was clicked). They're played last, with the probe's write guard on
// (probe/writes.ts), so a hidden "like" or "add to cart" can't reach the server, and shown in amber.
import { label } from '../shared/dom'
import { PROBE_CLICK_ATTR, PROBE_INTERACTIVE_ATTR } from '../shared/runtime'
import type { CapturedNode, InteractionReport } from '../shared/types'
import type { LayerReader } from './extract'
import { ForcedHover, hoverTarget, type HoverRule } from './hover'
import { allIn, blockedWrites, blockWrites, clickSignal, hiddenClick, containsDeep, parentOf, delegating, escape, goesTo, guard, LEAVE, look, outermost, play, pointer, PRESS, quiet, settle, shownAdded, signature, switchers, textOf, unsafe, visible } from './play'
import { MediaLog } from './seen'
import { componentAround, componentOf, exploreComponent, outermostComponents, type Component } from './states'
import type { TraceFocus } from './trace'

const MAX_HOVERS = 16
const MAX_CLICKS = 16
const MAX_HIDDEN = 10 // hidden clicks: nothing says they are safe, so fewer
const MAX_SAME_LOOK = 2 // hover at most this many of a repeated element (cards, dots)
const MAX_SAME_LOOK_CLICK = 6 // each tab or demo row usually brings up different content
const MAX_SAME_LOOK_HIDDEN = 2 // cards in a grid usually do the same thing
const MAX_TRACKED = 600
const BUDGET_MS = 90_000 // clicks that start a sequence take seconds each
const EXPLORE_BUDGET_MS = 150_000 // for every component's states together, after the flat pass
const MAX_LAYERS = 12 // alternate-state trees per capture
const MIN_LAYER_ELEMENTS = 3 // smaller changes are described by the change lines alone

export interface InteractionOptions {
  onProgress?: (done: number, total: number) => void
  onExplore?: (component: string, states: number) => void // a component's state explorer found another state
  onFocus?: (focus: TraceFocus | null) => void // the control about to be played, for the on-page trace
}

interface Candidate {
  el: Element
  kind: 'hover' | 'click'
  signal: string
  similar: number
  hidden?: boolean // a hidden click: nothing in the markup says it's clickable (shown in amber)
  // Played with server writes blocked: a hidden click, or a look-alike row whose markup doesn't say
  // what it does either. Explicit markup (a tab, aria-expanded) is trusted, so a tab loading its panel
  // over POST still works.
  writes?: boolean
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
  const hiddens: Candidate[] = []
  const skipped: string[] = []
  const components: Component[] = []
  const seen = new Map<string, Candidate[]>()
  const clickable = new Set<Element>()
  const add = (list: Candidate[], cap: number, el: Element, kind: 'hover' | 'click', signal: string, hidden = false, writes = false) => {
    const key = `${hidden ? 'hidden' : kind}|${look(el)}`
    const same = seen.get(key) ?? []
    if (same.length >= (hidden ? MAX_SAME_LOOK_HIDDEN : kind === 'click' ? MAX_SAME_LOOK_CLICK : MAX_SAME_LOOK)) {
      same[0].similar++
      return
    }
    if (list.length >= cap) return
    const text = textOf(el) ?? ''
    const nth = tracked.filter((other) => other !== el && look(other) === look(el) && (textOf(other) ?? '') === text && other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).length
    const c = { el, kind, signal, similar: 0, hidden, writes: hidden || writes, find: { look: look(el), text, nth } }
    same.push(c)
    seen.set(key, same)
    list.push(c)
  }
  // Look-alike siblings where one looks selected switch the page in place, marked up or not.
  const picks = switchers(tracked)
  // A listener above the section or on a container in it may handle a click on a plain element.
  const delegated = !!document.documentElement.getAttribute(PROBE_CLICK_ATTR)
  for (const el of tracked) {
    if (!visible(el)) continue
    const hover = hoverSignal(el, cssTargets)
    if (hover) add(hovers, MAX_HOVERS, el, 'hover', hover)
    const marked = clickSignal(el)
    const known = marked ?? (picks.has(el) ? 'one of a row of look-alike controls where one looks selected (tabs, a toggle, a sidebar)' : null)
    const click = known ?? hiddenClick(el, delegated)
    const hidden = !known && !!click
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
    if (hidden) add(hiddens, MAX_HIDDEN, el, 'click', click, true)
    else add(clicks, MAX_CLICKS, el, 'click', click, false, !marked)
  }
  return { list: [...hovers, ...clicks, ...hiddens], skipped, components: outermostComponents(components) }
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
  { onProgress, onExplore, onFocus }: InteractionOptions = {},
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
  const report: InteractionReport = { tested: { hover: 0, click: 0 }, skipped: found.skipped, items: [] }
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
      // A click nothing in the markup explains is only played with server writes blocked.
      if (c.writes && !blockWrites(true)) {
        report.tested.click--
        if (!report.skipped.some((s) => s.startsWith('clicks without markup'))) report.skipped.push('clicks without markup (hidden clicks, look-alike rows: the page probe that blocks server writes was not available)')
        continue
      }
      onFocus?.({ el: c.el, action: c.hidden ? 'sweep-click' : c.kind, area: root })
      const played = await play(c, root, scope, media, forced)
      if (played.blocked) {
        blockWrites(false)
        // Where it goes is its behaviour: the rebuild opens the same URL the same way.
        if (played.destination) (report.navigates ??= []).push(`\`${label(c.el)}\`${textOf(c.el) ? ` "${textOf(c.el)}"` : ''} ${goesTo(played.destination)}`)
        else report.skipped.push(played.blocked)
        // The guard cancelled it before anything happened: only this control is left. If the URL
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
      if (c.writes) {
        const writes = blockedWrites()
        blockWrites(false)
        if (writes.length) item.signal += `; it tried to write to the server, which was blocked: ${writes.join(', ')}`
      }
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
        const explored = await exploreComponent(component, { section: root, layers, media, deadline, autoplay, moved, onState: (states) => onExplore?.(name, states), onFocus })
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
  } finally {
    onFocus?.(null)
    guard(false)
    blockWrites(false)
    forced.dispose()
    // The handler marks stay for the click sweep, which tells controls from free space by them and
    // removes them when done (sweep.ts endClickSweep).
    window.scrollTo({ top: startY, behavior: 'instant' })
  }
  report.media = media.assets
  return report
}
