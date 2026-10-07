// Explores a component that holds several states behind its own controls, all the way down: a mock IDE
// whose sidebar switches agents, where each agent brings its own tabs, file tree and panes, and those
// tabs switch again. The flat pass (interactions.ts) clicks what is on screen at the start and undoes
// each click, so it never sees the controls a click brings up, and reads back only the region that
// changed. Here the component is a graph instead:
//
// - A state is what the component shows, identified by its visible elements (tags, classes, state
//   attributes, the start of their text). Lines that change by themselves between two samples (a
//   blinking caret, a clock) are left out, and a look a line or two away from a known state is that
//   state (a mock window whose traffic lights turned on with the first press).
// - Every state's controls are queued for that state, and the explorer clicks the ones of the state
//   it is in first: a sidebar row lands in that agent, whose tabs are clicked right there, then what
//   those tabs bring up. Controls that look alike and have twice changed nothing are left alone.
// - Nothing is undone. Clicks are recorded as transitions, and the explorer moves between states by
//   replaying them: the shortest route of known transitions, or a control on screen that has led
//   somewhere the target can be reached from. Clicking the control that was already selected records
//   a transition to the same state, which is how it learns the way back to the initial state.
// - A demo that plays itself (a timer moves its tour on every few seconds) would leave each state
//   before it's read. The page probe holds the page's long timers while the component is explored
//   (probe/clock.ts); short ones, like a reply streaming in, keep running.
// - Each new state is read as the whole component (sidebar, tab strip and panes together), so the
//   rebuild sees the parent components around what changed. What an earlier state already showed is
//   folded: an unchanged part into one "same as in S…" line, the same component with other text into
//   one line with that text, an unchanged wrapper into its label. A state costs only what is new in it.
import { label, stableClasses } from '../shared/dom'
import { PROBE_BLOCKED_ATTR, PROBE_INTERACTIVE_ATTR, PROBE_MARK_ATTR, PROBE_MARK_EVENT } from '../shared/runtime'
import type { CapturedNode, ComponentState, ComponentStates, Interaction, StateTransition } from '../shared/types'
import type { LayerReader } from './extract'
import { allIn, clickSignal, containsDeep, delegating, DEMO, ENTER, escape, guard, holdClock, LEAVE, look, ownPointer, parentOf, PHASE_WINDOW_MS, play, pointer, PRESS, quiet, settle, STATE_ATTRS, textOf, unsafe, visible, wait } from './play'
import type { MediaLog } from './seen'
import { directText } from './timeline'
import type { TraceFocus } from './trace'

const MAX_STATES = 20 // per component
const MAX_CLICKS = 80 // measured clicks per component; moves between states don't count
const MAX_SAME_LOOK = 6 // controls that look alike (file rows, list items): the rest share their behaviour
const STATE_NODES = 900 // per state tree, before folding what earlier states already show
const RESTLESS_MS = 300
const PORTAL_NODES = 300 // per menu or popover the state has open on <body>
const MIN_FOLD = 3 // a subtree is folded only when it holds at least this many nodes
const KEY_TEXT = 24 // characters of each element's text that count toward a state's identity
const KEY_SAMPLE_MS = 250
const MOVE_TRIES = 4
const MAX_ELEMENTS = 3000

export interface Component {
  root: Element
  signal: string
}

// The component a control switches the state of, when that is bigger than the control's own toggle:
// the outermost mock UI around it, or a tab set with its panels. Null for a lone disclosure (a menu,
// an accordion row), which the flat pass plays and undoes.
export function componentOf(section: Element, el: Element): Component | null {
  let demo: Element | null = null
  for (let p = el.closest(DEMO); p; p = p.parentElement?.closest(DEMO) ?? null) {
    if (!section.contains(p)) return { root: section, signal: 'mock UI (aria-hidden demo)' } // the whole section is the demo
    demo = p
  }
  if (demo) return { root: demo, signal: 'mock UI (aria-hidden demo)' }
  if (!el.matches('[role="tab"]')) return null
  const list = el.closest('[role="tablist"]') ?? el.parentElement
  if (!list || !section.contains(list)) return null
  const panels = Array.from(list.querySelectorAll('[role="tab"][aria-controls]'))
    .flatMap((tab) => (tab.getAttribute('aria-controls') ?? '').split(/\s+/))
    .map((id) => (id ? document.getElementById(id) : null))
    .filter((panel): panel is HTMLElement => !!panel && section.contains(panel))
  let common: Element = list
  for (const panel of panels) while (!common.contains(panel) && common !== section) common = common.parentElement ?? section
  // Without aria-controls the panels usually sit next to the tab list.
  if (common === list && list !== section && list.parentElement) common = list.parentElement
  return { root: common, signal: 'tabs' }
}

// A component found by clicking, whatever its markup: the control changed content in place, and the
// part that holds the control and that content has more controls, so it has states of its own
// (tabs without ARIA, a demo built from plain divs, a toggle whose panel has its own tabs). A lone
// disclosure (an accordion row with just its trigger) stays with the flat pass.
// `moved`: what changed by itself while the page sat idle (a carousel playing elsewhere in the
// section, a ticking counter). Changes there during the click aren't the click's doing.
export function componentAround(section: Element, control: Element, changed: Element[], moved: Set<Element>): Component | null {
  const inside = clickChanges(section, control, changed, moved)
  if (!inside.length) return null
  const start = control.isConnected && containsDeep(section, control) ? control : inside[0]
  const common = commonAncestor(section, start, inside)
  if (controlsIn(common).length < 2) return null
  return { root: common, signal: 'switches its own content (found by clicking it)' }
}

// The changes in the section a click made: not inside something that changes by itself (unless the
// control is in there too).
function clickChanges(section: Element, control: Element, changed: Element[], moved: Set<Element>): Element[] {
  const own = (el: Element) => {
    for (let node: Element | null = el; node && node !== section; node = parentOf(node)) if (moved.has(node) && !containsDeep(node, control)) return false
    return true
  }
  return changed.filter((el) => el.isConnected && containsDeep(section, el) && own(el))
}

function commonAncestor(section: Element, start: Element, els: Element[]): Element {
  let common = start
  for (const el of els) while (!containsDeep(common, el) && common !== section) common = parentOf(common) ?? section
  return common
}

// Outermost only: tabs inside a mock UI are explored as part of it.
export function outermostComponents(found: Component[]): Component[] {
  const unique = Array.from(new Map(found.map((c) => [c.root, c])).values())
  return unique.filter((c) => !unique.some((other) => other !== c && other.root.contains(c.root)))
}

// ---------- identity ----------

function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(36)}.${s.length.toString(36)}`
}

const CONTENT = 'img, svg, video, canvas, picture'
// Classes that follow focus, hover or a press rather than the state: Angular CDK's cdk-focused, MUI's
// Mui-focusVisible, focus-visible polyfills, ripples. The last click leaves them on whatever it hit.
const TRANSIENT = /focus|hover|ripple|pressed/i

// One line per visible element: tag, classes, state attributes, the start of its text, and for
// content (text, images), whether it sits inside the component's box. A carousel moves its slides
// with a transform and nothing else, so what is in view is the only sign of another slide.
function keyLines(root: Element): string[] {
  const box = root.getBoundingClientRect()
  const inView = (el: Element) => {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom ? 'in' : 'out'
  }
  return [root, ...allIn(root, MAX_ELEMENTS)].filter(visible).map((el) => {
    const text = directText(el)
    const where = text || el.matches(CONTENT) ? inView(el) : ''
    return `${el.tagName}.${stableClasses(el).filter((c) => !TRANSIENT.test(c)).join('.')}|${STATE_ATTRS.map((a) => el.getAttribute(a) ?? '').join(',')}|${text.slice(0, KEY_TEXT)}|${where}`
  })
}

interface Look {
  key: string
  lines: string[]
  // The lines of elements with a selection attribute set (aria-selected, data-state, …): two looks
  // that differ there are different states however few lines apart they are (a tab switch in a big
  // component).
  marks: string
}

// `parts`: the component, plus any popover it opened on <body>.
async function sample(parts: Element[]): Promise<Look> {
  const first = parts.flatMap(keyLines)
  await wait(KEY_SAMPLE_MS)
  const left = new Map<string, number>()
  for (const line of parts.flatMap(keyLines)) left.set(line, (left.get(line) ?? 0) + 1)
  const kept = first.filter((line) => {
    const n = left.get(line) ?? 0
    if (n) left.set(line, n - 1)
    return n > 0
  })
  const marked = kept.filter((line) => /[^,]/.test(line.split('|')[1] ?? '')).sort()
  return { key: hash(kept.join('\n')), lines: kept, marks: hash(marked.join('\n')) }
}

// Lines in one look and not the other. The first click into a mock window can leave a residue that
// no click undoes (its traffic-light dots turn on once the window is "active"), so a state is
// recognised by being nearly the same, not only by the exact key.
function distance(a: string[], b: string[]): number {
  const left = new Map<string, number>()
  for (const line of a) left.set(line, (left.get(line) ?? 0) + 1)
  let missing = 0
  for (const line of b) {
    const n = left.get(line) ?? 0
    if (n) left.set(line, n - 1)
    else missing++
  }
  return missing + a.length - (b.length - missing)
}

// At most 1% of the component apart is the same state: none in a small one, where a slide or a tab
// changes only a line or two.
const SAME_SHARE = 0.01

// The elements that keep changing while nothing is clicked: changed in two windows of `ms`, a gap apart.
// One window alone would also catch a slide finishing the move it started before the tour was held.
async function restlessIn(section: Element, ms: number): Promise<Set<Element>> {
  const watch = async () => {
    const seen = new Set<Element>()
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        const el = rec.target instanceof Element ? rec.target : rec.target.parentElement
        if (el) seen.add(el)
      }
    })
    observer.observe(section, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', ...STATE_ATTRS] })
    await wait(ms)
    observer.disconnect()
    return seen
  }
  const first = await watch()
  await wait(ms)
  const second = await watch()
  return new Set(Array.from(first).filter((el) => second.has(el)))
}

// Child indexes from the section down to `el`, to find the component again if a re-render replaced
// its root element.
function indexPath(section: Element, el: Element): number[] {
  const path: number[] = []
  for (let node = el; node !== section && node.parentElement; node = node.parentElement) path.unshift(Array.from(node.parentElement.children).indexOf(node))
  return path
}

function atPath(section: Element, path: number[]): Element | null {
  let node: Element | undefined = section
  for (const i of path) node = node?.children[i]
  return node ?? null
}

interface Control {
  // Tag + text + which one of those it is: finds it again after a re-render. Not its classes, which
  // change when it becomes the selected one.
  key: string
  el: Element
  name: string // `label` "text", for the prompt
  look: string
}

// Inside a component known to switch its own content, more counts as a control than on the page at
// large: any button, anything with a click handler, and anything that sets `cursor: pointer` itself
// (rows a delegated listener handles: one on the list, or jQuery's on the document).
function isControl(el: Element): boolean {
  if (clickSignal(el) || el.matches('button, [role="button"], [role="tab"], [role="option"], [role="menuitem"], [role="radio"], [role="switch"]')) return true
  if ((el.getAttribute(PROBE_INTERACTIVE_ATTR) ?? '').includes('click')) return true
  return el instanceof HTMLElement && ownPointer(el)
}

// The controls on screen in the component right now. The probe marks handlers again first, since
// what a click rendered wasn't there for its first scan.
function controlsIn(root: Element): Control[] {
  root.setAttribute(PROBE_MARK_ATTR, '')
  document.dispatchEvent(new CustomEvent(PROBE_MARK_EVENT))
  root.removeAttribute(PROBE_MARK_ATTR)
  const out: Control[] = []
  const outer: Element[] = []
  const count = new Map<string, number>()
  for (const el of allIn(root, MAX_ELEMENTS)) {
    if (!visible(el) || !isControl(el) || delegating(el)) continue
    // A control inside a control (icon inside a row) is the same control.
    if (outer.some((o) => o.contains(el))) continue
    outer.push(el)
    if (unsafe(el)) continue
    const text = textOf(el)
    // A drag or resize handle (a mock window's edges) says so with its cursor. Empty boxes that are
    // controls (carousel dots, color swatches) keep a pointer.
    if (/resize|move|grab/.test(getComputedStyle(el).cursor)) continue
    const base = `${el.tagName}|${text ?? ''}`
    const n = count.get(base) ?? 0
    count.set(base, n + 1)
    out.push({ key: `${base}|${n}`, el, name: `\`${label(el)}\`${text ? ` "${text}"` : ''}`, look: look(el) })
  }
  return out
}

// ---------- folding ----------

interface Seen {
  state: string
  label: string
}

function nodeLabel(node: CapturedNode): string {
  return `${node.tag}${node.id ? `#${node.id}` : ''}${node.classes?.length ? `.${node.classes.slice(0, 2).join('.')}` : ''}`
}

interface Print {
  fp: string // everything but the box: the same part moved elsewhere is still the same part
  shape: string // the same, without text: the same component showing other content
  self: string // the element alone, without its children
  size: number
}

function fingerprints(node: CapturedNode, into: Map<CapturedNode, Print>): Print {
  const kids = node.children.map((child) => fingerprints(child, into))
  // Not `motion` or `scroll`: only the main tree records those, and it must match a read of the same look.
  const own = [node.tag, node.id, node.classes, node.attrs, node.styles, node.before, node.after, node.states, node.hidden, node.note]
  const self = JSON.stringify([...own, node.text])
  const entry = {
    fp: hash(`${self}[${kids.map((k) => k.fp).join(',')}]`),
    shape: hash(`${JSON.stringify(own)}[${kids.map((k) => k.shape).join(',')}]`),
    self: hash(self),
    size: 1 + kids.reduce((sum, k) => sum + k.size, 0),
  }
  into.set(node, entry)
  return entry
}

// `seen` keys: "=" + fp for parts seen exactly, "~" + shape for components seen with other text,
// "." + self for single elements.
function remember(tree: CapturedNode, state: string, seen: Map<string, Seen>) {
  const prints = new Map<CapturedNode, Print>()
  fingerprints(tree, prints)
  for (const [node, { fp, shape, self }] of prints) {
    const at = { state, label: nodeLabel(node) }
    for (const key of [`=${fp}`, `~${shape}`, `.${self}`]) if (!seen.has(key)) seen.set(key, at)
  }
}

function textsOf(node: CapturedNode, out: string[] = []): string[] {
  if (node.text) out.push(node.text)
  node.children.forEach((child) => textsOf(child, out))
  return out
}

const MAX_FOLD_TEXTS = 40

// The tree with every subtree an earlier state already showed replaced by one line pointing there,
// and every component an earlier state showed with other text (another agent's chat messages, file
// rows) by one line with its text.
function fold(tree: CapturedNode, seen: Map<string, Seen>): CapturedNode {
  const prints = new Map<CapturedNode, Print>()
  fingerprints(tree, prints)
  const where = (at: Seen) => `${at.state === 'main' ? 'the main tree' : at.state}, at \`${at.label}\``
  const visit = (node: CapturedNode, isRoot: boolean): CapturedNode => {
    const print = prints.get(node)!
    const stub = (note: string): CapturedNode => ({ tag: '…', attrs: {}, box: node.box, styles: {}, children: [], note: `\`${nodeLabel(node)}\` (${print.size} elements): ${note}` })
    if (!isRoot && print.size >= MIN_FOLD) {
      const same = seen.get(`=${print.fp}`)
      if (same) return stub(`same as in ${where(same)}`)
      const shaped = seen.get(`~${print.shape}`)
      if (shaped) {
        const texts = textsOf(node)
        const listed = texts.slice(0, MAX_FOLD_TEXTS).map((t) => JSON.stringify(t)).join(' · ')
        return stub(`the same component as in ${where(shaped)} (same elements and styles), with this text in order: ${listed}${texts.length > MAX_FOLD_TEXTS ? ` …and ${texts.length - MAX_FOLD_TEXTS} more` : ''}`)
      }
    }
    const children = node.children.map((child) => visit(child, false))
    // The element itself is unchanged (a wrapper on the way down to what changed, a resize handle):
    // its line only; its details are in that earlier state.
    const unchanged = isRoot ? undefined : seen.get(`.${print.self}`)
    if (unchanged) {
      const position = node.styles.position
      return { tag: node.tag, id: node.id, classes: node.classes, attrs: {}, box: node.box, styles: position ? { position } : {}, hidden: node.hidden, note: `unchanged element: as in ${where(unchanged)}`, children }
    }
    return { ...node, children }
  }
  return visit(tree, true)
}

// ---------- exploring ----------

interface State {
  id: string
  look: Look
  path: string[]
  tree?: CapturedNode
  portals?: { target: string; tree: CapturedNode }[]
  controls: Set<string> // Control.key of every control on screen in this state
}

interface Edge {
  from: State
  to: State
  control: string // Control.key
  name: string
}

export interface ExploreContext {
  section: Element
  layers: LayerReader
  media: MediaLog
  deadline: number // performance.now() to stop at
  // It changed by itself while the page sat idle (the capture's idle watch saw its elements come and
  // go): a demo that plays itself, whose tour is held while it's explored.
  autoplay: boolean
  moved: Set<Element> // what changed by itself during the idle watch: not a click's doing
  onState?: (states: number) => void
  onFocus?: (focus: TraceFocus) => void // the control about to be pressed, for the on-page trace
}

export interface Explored {
  result: ComponentStates
  items: Interaction[] // the clicks that changed something, with Interaction.state set
  clicks: number
  // A click left the page before the guard could stop it (it went back): stop clicking anything.
  blocked?: string
  // Controls whose navigation the guard cancelled ("Get Cursor" inside the demo): skipped, the rest
  // of the component is still explored.
  skipped: string[]
  grow?: Element // a click changed content outside it: explore this bigger part instead
}

const MAX_GROW = 2

export async function exploreComponent(component: Component, x: ExploreContext): Promise<Explored> {
  // A demo that plays itself would move on from each state before it's read: its tour is held.
  // Only then: holding every long timer would also stop a click's own delayed result.
  if (x.autoplay) holdClock(true)
  try {
    let clicks = 0
    for (let grown = 0; ; grown++) {
      const explored = await explore(component, x)
      clicks += explored.clicks
      if (!explored.grow || explored.blocked || grown >= MAX_GROW) return { ...explored, clicks }
      component = { ...component, root: explored.grow }
    }
  } finally {
    if (x.autoplay) holdClock(false)
  }
}

async function explore(component: Component, x: ExploreContext): Promise<Explored> {
  const where = indexPath(x.section, component.root)
  const rootNow = () => (component.root.isConnected ? component.root : (atPath(x.section, where) ?? component.root))
  const name = label(component.root)
  const states: State[] = []
  const edges: Edge[] = []
  const seen = new Map<string, Seen>()
  const items: Interaction[] = []
  const unexplored: string[] = []
  const skipped: string[] = []
  const leaves = new Set<string>() // Control.key of controls that try to open another page
  let clicks = 0
  let blocked: string | undefined

  // The controls on screen, scanned again only after the component changed: a scan looks at every
  // element's cursor, and the explorer asks several times per click. Any click (ours) or mutation
  // clears it; the probe's own marking attributes don't.
  let scanned: Control[] | null = null
  const changes = new MutationObserver(() => (scanned = null))
  changes.observe(x.section, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'disabled', 'open', ...STATE_ATTRS] })
  changes.observe(document.body, { childList: true })

  // Menus, popovers and dialogs a control opens are usually rendered on <body> (Radix, Headless UI,
  // MUI portals), outside the component. Whatever opened there since exploring started is part of
  // the state: in its look, its tree, and its controls (a menu's items). A portal container that was
  // there all along but empty counts once it has content.
  const atStart = new Map(Array.from(document.body.children).map((el) => [el, visible(el) ? el.childElementCount : -1]))
  const portals = (): Element[] =>
    Array.from(document.body.children).filter((el) => {
      if (el.tagName === 'JEV-INSPECTOR' || el.tagName === 'SCRIPT' || containsDeep(el, x.section) || !visible(el)) return false
      const before = atStart.get(el)
      return before === undefined || before === -1 || (before === 0 && el.childElementCount > 0)
    })
  const parts = () => [rootNow(), ...portals()]
  const controlsNow = (): Control[] => {
    if (changes.takeRecords().length) scanned = null
    return (scanned ??= [...controlsIn(rootNow()), ...portals().flatMap((portal) => controlsIn(portal).map((c) => ({ ...c, key: `portal|${c.key}` })))])
  }

  // Pressed on its own background first, like a visitor's first click into it: a mock window that
  // turns "active" on the first press (its traffic-light dots light up) would otherwise never look
  // like S0 again. No click event, so no control's handler runs.
  rootNow().scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  pointer(rootNow(), [...ENTER, 'pointerdown', 'mousedown', 'pointerup', 'mouseup'])
  await settle()
  await quiet(x.section)
  // What still changes by itself now, under the conditions of exploring (with a demo's tour held):
  // changes there during a click aren't the click's doing. Without the hold, what the idle watch saw
  // moving counts too (a timer slower than this short watch).
  const restless = await restlessIn(x.section, RESTLESS_MS)
  const noise = x.autoplay ? restless : new Set([...x.moved, ...restless])
  const s0: State = { id: 'S0', look: await sample(parts()), path: [], controls: new Set() }
  states.push(s0)
  // The known state this look is: the same key, or the nearest one a residue or two away.
  const known = (look: Look): State | null => {
    const exact = states.find((s) => s.look.key === look.key)
    if (exact) return exact
    let best: State | null = null
    let bestDistance = Infinity
    for (const s of states) {
      if (s.look.marks !== look.marks) continue // another selection: another state
      const d = distance(s.look.lines, look.lines)
      if (d < bestDistance) [best, bestDistance] = [s, d]
    }
    return bestDistance <= Math.floor(look.lines.length * SAME_SHARE) ? best : null
  }
  // S0 is the main tree, unless the component isn't how the main tree caught it any more (a demo's
  // autoplay moved on, the first press woke it up, the main tree ran out of nodes): then S0 gets its
  // own tree, folded against the main tree's.
  const main = x.layers.nodeOf(component.root)
  if (main) remember(main, 'main', seen)
  const base = x.layers.read(rootNow(), STATE_NODES)
  if (base) {
    const prints = new Map<CapturedNode, Print>()
    if (!main || fingerprints(main, prints).fp !== fingerprints(base.tree, prints).fp) s0.tree = fold(base.tree, seen)
    remember(base.tree, 'S0', seen)
    for (const asset of base.assets) x.media.add(asset, 'when the component\'s states were explored')
  }

  // Every state's controls are queued for that state. Those it brought up (that agent's tabs) go
  // first. Those that were on screen in the state before too (the sidebar rows) wait in `again`:
  // usually they do the same thing from anywhere, but another agent's "Files" tab can hold other
  // files. A control that has led to the same state from two different states is taken to do that
  // from everywhere, and isn't clicked again.
  // `kind`: tag and classes, without the parent: chat cards in different wrappers are one kind.
  type Item = { from: State; control: string; name: string; kind: string; retried?: boolean }
  const fresh: Item[] = []
  const again: Item[] = []
  const looks = new Map<string, number>()
  const enqueue = (state: State, parent?: State) => {
    for (const c of controlsNow()) {
      state.controls.add(c.key)
      const n = looks.get(`${state.id}|${c.look}`) ?? 0
      looks.set(`${state.id}|${c.look}`, n + 1)
      if (n >= MAX_SAME_LOOK) continue
      ;(parent?.controls.has(c.key) ? again : fresh).push({ from: state, control: c.key, name: c.name, kind: `${c.el.tagName}.${stableClasses(c.el).join('.')}` })
    }
  }
  enqueue(s0)
  const settled = (control: string) => {
    const led = edges.filter((e) => e.control === control)
    return new Set(led.map((e) => e.from)).size >= 2 && new Set(led.map((e) => e.to)).size === 1
  }
  // A control of the state it's in comes first: a sidebar row lands in that agent, so its tabs are
  // explored right there, before the explorer travels back for the next row. Depth before breadth,
  // and no moves while there's something to click where it is.
  const take = (list: Item[]): Item | undefined => {
    const i = list.findIndex((item) => item.from === current)
    return list.splice(i >= 0 ? i : 0, 1)[0]
  }
  // Controls that look alike usually act alike: once two of a look have changed nothing (chat cards
  // with nothing behind them), the rest of that look are left alone.
  const outcomes = new Map<string, { still: number; moved: number }>()
  const idle = (kind: string) => {
    const o = outcomes.get(kind)
    return !!o && o.still >= 2 && !o.moved
  }
  const nextItem = (): Item | undefined => {
    while (fresh.length) {
      const item = take(fresh)!
      if (!idle(item.kind)) return item
    }
    while (again.length) {
      const item = take(again)!
      if (!settled(item.control) && !idle(item.kind)) return item
    }
  }

  const find = (key: string) => controlsNow().find((c) => c.key === key)
  const here = async () => known(await sample(parts()))

  // Breadth-first over known transitions (same-state ones don't move anywhere).
  const route = (from: State, to: State): Edge[] | null => {
    const back = new Map<State, Edge>()
    const todo = [from]
    while (todo.length) {
      const s = todo.shift()!
      if (s === to) {
        const steps: Edge[] = []
        for (let at = to; at !== from; at = back.get(at)!.from) steps.unshift(back.get(at)!)
        return steps
      }
      for (const e of edges) if (e.from === s && e.to !== s && e.to !== from && !back.has(e.to)) {
        back.set(e.to, e)
        todo.push(e.to)
      }
    }
    return null
  }

  // Clicks without measuring: a step on the way to another state.
  const press = async (key: string): Promise<boolean> => {
    const c = find(key)
    if (!c) return false
    c.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    x.onFocus?.({ el: c.el, action: 'move', area: rootNow() })
    guard(true)
    scanned = null
    pointer(c.el, [...ENTER, ...PRESS])
    await settle()
    pointer(c.el, LEAVE)
    await quiet(rootNow(), PHASE_WINDOW_MS) // the component only: another part of the page may never sit still
    return !document.documentElement.hasAttribute(PROBE_BLOCKED_ATTR)
  }

  // Known transitions from here. Without a route (or from a state never seen), a control on screen
  // that has led somewhere the target can be reached from: a sidebar row back to a known agent, then
  // its route. A different one each try.
  const moveTo = async (target: State): Promise<State | null> => {
    for (let attempt = 0; attempt < MOVE_TRIES; attempt++) {
      const now = await here()
      if (now === target) return now
      const steps = now && route(now, target)
      if (steps) {
        for (const step of steps) if (!(await press(step.control))) break
        continue
      }
      const onScreen = new Set(controlsNow().map((c) => c.key))
      const ways = edges
        .filter((e) => onScreen.has(e.control) && (e.to === target || route(e.to, target)))
        .sort((a, b) => Number(b.to === target) - Number(a.to === target))
      if (!ways.length) {
        escape()
        await settle()
        continue
      }
      await press(ways[attempt % ways.length].control)
    }
    return here()
  }

  let current: State | null = s0
  for (let next = nextItem(); next && clicks < MAX_CLICKS && performance.now() < x.deadline; next = nextItem()) {
    if (leaves.has(next.control)) continue
    if (current !== next.from) current = await moveTo(next.from)
    // Couldn't get back there. A control that is on screen here too is played from here instead;
    // otherwise it waits for one more try, when more ways around are known.
    if (!current || !find(next.control)) {
      if (!next.retried) again.push({ ...next, retried: true })
      else unexplored.push(`${next.name} (in ${next.from.id}; could not get back there)`)
      continue
    }
    const from: State = current
    if (edges.some((e) => e.from === from && e.control === next.control)) continue // already played from here
    const control = find(next.control)!
    const scope = [rootNow(), ...allIn(rootNow(), MAX_ELEMENTS)]
    scanned = null
    x.onFocus?.({ el: control.el, action: 'click', area: rootNow() })
    const played = await play({ el: control.el, kind: 'click', signal: component.signal, similar: 0 }, x.section, scope, x.media)
    clicks++
    pointer(control.el, LEAVE)
    if (played.blocked && played.navigated) {
      blocked = played.blocked
      break
    }
    if (played.blocked) {
      leaves.add(next.control)
      skipped.push(played.blocked)
      await quiet(rootNow())
      current = await here()
      continue
    }
    await quiet(rootNow())
    // It changed content just outside the component (a file list's preview pane next to it): the
    // component is bigger than it looked. Start over with the part that holds both.
    const outside = clickChanges(x.section, control.el, [...played.touched, ...played.added], noise).filter((el) => !containsDeep(rootNow(), el) && !containsDeep(el, rootNow()))
    if (outside.length) {
      await moveTo(s0)
      const result: ComponentStates = { target: name, signal: component.signal, states: [], transitions: [], unexplored: [], restored: false }
      changes.disconnect()
      return { result, items: [], clicks, skipped, grow: commonAncestor(x.section, rootNow(), outside) }
    }
    const look = await sample(parts())
    let to = known(look)
    if (!to && states.length >= MAX_STATES) {
      unexplored.push(`${next.name} (in ${from.id}; state limit reached)`)
      current = null
      continue
    }
    if (!to) {
      to = { id: `S${states.length}`, look, path: [...from.path, next.name], controls: new Set() }
      const read = x.layers.read(rootNow(), STATE_NODES)
      if (read) {
        to.tree = fold(read.tree, seen)
        remember(read.tree, to.id, seen)
        const referenced = JSON.stringify(to.tree)
        // Icons in folded parts aren't referenced from this state, so they aren't listed again.
        for (const asset of read.assets) if (asset.kind !== 'svg' || referenced.includes(`inline ${asset.target}"`) || referenced.includes(`inline ${asset.target} `)) x.media.add(asset, played.when)
      }
      for (const portal of portals()) {
        const opened = x.layers.read(portal, PORTAL_NODES)
        if (!opened) continue
        to.portals = [...(to.portals ?? []), { target: label(portal), tree: fold(opened.tree, seen) }]
        remember(opened.tree, to.id, seen)
        for (const asset of opened.assets) x.media.add(asset, played.when)
      }
      states.push(to)
      x.onState?.(states.length)
      enqueue(to, from)
    }
    edges.push({ from, to, control: next.control, name: next.name })
    const outcome = outcomes.get(next.kind) ?? { still: 0, moved: 0 }
    outcome[to === from ? 'still' : 'moved']++
    outcomes.set(next.kind, outcome)
    current = to
    if (to !== from && played.changed) items.push({ ...played.item, state: { component: name, from: from.id, to: to.id } })
  }
  for (const left of [...fresh, ...again.filter((item) => !settled(item.control))].filter((item) => !idle(item.kind))) unexplored.push(`${left.name} (in ${left.from.id}; ${blocked ? 'stopped after a click left the page' : `${clicks >= MAX_CLICKS ? 'click' : 'time'} limit reached`})`)

  const restored = !blocked && (await moveTo(s0)) === s0
  // Each state's path: the shortest route from S0 now that every transition is known, not the order
  // the explorer happened to find it in.
  for (const state of states.slice(1)) {
    const steps = route(s0, state)
    if (steps) state.path = steps.map((step) => step.name)
  }
  const order = (state: State) => states.indexOf(state)
  const transitions: StateTransition[] = edges
    .filter((e) => e.from !== e.to)
    .sort((a, b) => order(a.from) - order(b.from) || order(a.to) - order(b.to))
    .map((e) => ({ from: e.from.id, to: e.to.id, control: e.name }))
  const result: ComponentStates = {
    target: name,
    signal: component.signal,
    states: states.map((s): ComponentState => ({ id: s.id, path: s.path, tree: s.tree, portals: s.portals })),
    transitions,
    unexplored: unexplored.slice(0, 20),
    restored,
  }
  changes.disconnect()
  return { result, items, clicks, blocked, skipped }
}
