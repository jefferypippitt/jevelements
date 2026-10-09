// Subset of the extension's Capture type (frontend/jevelements/src/shared/types.ts) that the backend reads.
// Keep in sync with the frontend when those fields change.

export interface CapturedNode {
  tag: string
  id?: string
  classes?: string[]
  attrs: Record<string, string>
  text?: string
  box: { x: number; y: number; w: number; h: number }
  styles: Record<string, string>
  states?: { state: string; declarations: string }[]
  note?: string
  children: CapturedNode[]
}

export interface Capture {
  url: string
  title: string
  selector: string
  viewport: { w: number; h: number; dpr: number }
  root: CapturedNode
  assets: { kind: string; src: string; width: number; height: number }[]
  responsive: { media: string; selector: string; declarations: string }[]
  keyframes: string[]
  libraries?: { name: string; version?: string }[]
  runtime?: {
    three: unknown[]
    webgl: unknown[]
    lottie: unknown[]
    gsap?: { tweens: unknown[] }
    physics?: { engine: string; bodies: unknown[] }[]
    transitions?: { library: string }[]
  }
  scrollStory?: { phases: { kind: string }[]; pinned: unknown[] }
  interactions?: { items: { kind: string; target: string; appeared: string[] }[]; components?: { target: string; states: unknown[] }[] }
  placement?: Placement
}

// Where the section sits on the page (frontend content/placement.ts). Missing from older extensions;
// the root's page-coordinate box still gives the top.
export interface Placement {
  pageHeight: number
  before: string[] // nearest bands above, closest first: their heading or tag
  after: string[] // nearest bands below, closest first
}

export function isCapture(value: unknown): value is Capture {
  const c = value as Capture | null
  return !!c && typeof c.url === 'string' && typeof c.root?.tag === 'string' && Array.isArray(c.root.children)
}

const OUTLINE_BUDGET = 14_000
const OUTLINE_HEAD = 10_000
const OUTLINE_TAIL = 3_000
const KEY_STYLES = ['display', 'position', 'grid-template-columns', 'grid-column', 'grid-row', 'flex-direction', 'overflow-x', 'animation', 'transition', 'background-image']
const KEY_ATTRS = ['href', 'type', 'role', 'aria-label', 'placeholder', 'alt']

export interface CaptureState {
  page: string
  captured: string
  placement: string
  content: string
  signals: string
  siblingGroups: string
  outline: string
}

// Named fields so each question can point at the part it needs. The outline keeps its head and its
// tail: a long section's call to action usually sits at the bottom, and cutting from the top only drops it.
export function captureState(capture: Capture, siblingGroups: string): CaptureState {
  return {
    page: `${capture.url} (${capture.title})`,
    captured: `${capture.selector}, ${capture.root.box.w}x${capture.root.box.h}px in a ${capture.viewport.w}x${capture.viewport.h} viewport`,
    placement: placementOf(capture),
    content: contentOf(capture.root),
    signals: [
      `Images/media: ${capture.assets.filter((asset) => asset.kind !== 'svg').length}, inline SVGs: ${capture.assets.filter((asset) => asset.kind === 'svg').length}`,
      `Responsive rules: ${capture.responsive.length}, keyframe animations: ${capture.keyframes.length}`,
      `Libraries: ${capture.libraries?.map((library) => library.name).join(', ') || 'none detected'}`,
      `three.js scenes: ${capture.runtime?.three.length ?? 0}, raw WebGL canvases: ${capture.runtime?.webgl.length ?? 0}, Lottie animations: ${capture.runtime?.lottie.length ?? 0}, GSAP tweens: ${capture.runtime?.gsap?.tweens.length ?? 0}`,
      ...(capture.runtime?.physics?.length || capture.runtime?.transitions?.length
        ? [
            `Physics: ${capture.runtime?.physics?.map((world) => `${world.engine} (${world.bodies.length} bodies)`).join(', ') || 'none'}. Page transitions: ${capture.runtime?.transitions?.map((transition) => transition.library).join(', ') || 'none'}`,
          ]
        : []),
      `Interactions played on the page: ${
        capture.interactions?.items.map((item) => `${item.kind} ${item.target}${item.appeared.length ? ' (reveals content)' : ''}`).join(', ') || 'none that changed anything'
      }`,
      ...(capture.interactions?.components?.length
        ? [`Components with states of their own (explored click by click): ${capture.interactions.components.map((component) => `${component.target} (${component.states.length} states)`).join(', ')}`]
        : []),
      `Scroll story: ${capture.scrollStory ? `${capture.scrollStory.phases.filter((phase) => phase.kind === 'change').length} phases that change on scroll, ${capture.scrollStory.pinned.length} pinned elements` : 'not recorded'}`,
    ].join('\n'),
    siblingGroups,
    outline: clipOutline(outlineOf(capture.root)),
  }
}

// Where on the page: the opening screen, the middle, or the end, and what sits around it.
export function placementOf(capture: Capture): string {
  const { y, h } = capture.root.box
  const screen = capture.viewport.h || 900
  const lines: string[] = []
  const pageHeight = capture.placement?.pageHeight ?? 0
  if (pageHeight > 0) {
    const share = (value: number) => Math.round((Math.min(value, pageHeight) / pageHeight) * 100)
    lines.push(`Spans ${px(y)} to ${px(y + h)} of a ${px(pageHeight)} page (${share(y)}% to ${share(y + h)}% down).`)
    if (pageHeight - (y + h) < screen / 2) lines.push('It ends at the bottom of the page.')
  } else {
    lines.push(`Starts ${px(y)} from the top of the page.`)
  }
  lines.push(y < screen / 2 ? 'It starts in the first screen, before any scrolling.' : `It starts ${(y / screen).toFixed(1)} screens down.`)
  if (capture.placement) {
    const near = (list: string[], where: string) =>
      lines.push(list.length ? `${where}: ${list.map((band) => JSON.stringify(band)).join(', then ')}.` : `${where}: nothing.`)
    near(capture.placement.before, 'Directly above it')
    near(capture.placement.after, 'Directly below it')
  }
  return lines.join(' ')
}

function px(value: number): string {
  return `${Math.round(value).toLocaleString('en-US')}px`
}

const CONTENT_LIST = 12
const PRICE = /([$€£¥₹]\s?\d|\/\s?(mo|month|yr|year|user|seat)\b|per (month|year|user|seat)\b)/i
const STAT = /^[~+<>]?[$€£]?\d[\d.,]*\s?(%|[kmb]|x|\+|\/\d+|ms|s|hrs?)?\+?$/i
const STEP = /^(0?[1-9]|step\s*\d+)[.:)]?$/i
const DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}\b|\b\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{4}\b|\b\d+ min(ute)?s? read\b/i
const QUOTE = /^["“„«]/
const QUESTION = /\?\s*$/

const COUNT_LABELS = {
  prices: 'price-like texts',
  stats: 'stand-alone numbers or metrics',
  quotes: 'quotes',
  steps: 'step numbers',
  dates: 'dates or read times',
  questions: 'question-like headings or buttons',
  media: 'images or videos',
  svgs: 'inline SVGs',
  copyright: 'copyright notices',
  tables: 'tables',
}

// Evidence code can find, so the model doesn't have to dig it out of a long outline: the headings with
// their levels, the button and link texts, form fields, and counts of prices, stats, quotes, steps and dates.
export function contentOf(root: CapturedNode): string {
  const headings: string[] = []
  const actions = new Set<string>()
  const fields: string[] = []
  const counts = Object.fromEntries(Object.keys(COUNT_LABELS).map((key) => [key, 0])) as Record<keyof typeof COUNT_LABELS, number>

  const visit = (node: CapturedNode) => {
    const tag = node.tag
    if (/^h[1-6]$/.test(tag)) {
      const text = textOf(node)
      if (text) headings.push(`${tag} ${JSON.stringify(text.slice(0, 70))}`)
      if (QUESTION.test(text)) counts.questions++
      return
    }
    if (tag === 'svg') {
      counts.svgs++
      return
    }
    if (tag === 'a' || tag === 'button' || node.attrs.role === 'button') {
      const text = textOf(node) || node.attrs['aria-label'] || ''
      if (text && text.length <= 40) actions.add(text)
      if (QUESTION.test(text)) counts.questions++
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const type = tag === 'input' ? node.attrs.type || 'text' : tag
      if (type !== 'hidden') fields.push(node.attrs.placeholder ? `${type} "${node.attrs.placeholder.slice(0, 30)}"` : type)
    }
    if (tag === 'img' || tag === 'video' || tag === 'canvas') counts.media++
    if (tag === 'table') counts.tables++
    if (tag === 'blockquote') counts.quotes++
    const own = node.text?.trim() ?? ''
    if (own) {
      if (PRICE.test(own)) counts.prices++
      if (STAT.test(own)) counts.stats++
      if (STEP.test(own)) counts.steps++
      if (DATE.test(own)) counts.dates++
      if (QUOTE.test(own) && own.length > 30) counts.quotes++
      if (own.includes('©')) counts.copyright++
    }
    node.children.forEach(visit)
  }
  visit(root)

  const list = (items: string[]) => items.slice(0, CONTENT_LIST).join(', ') + (items.length > CONTENT_LIST ? `, … (${items.length} in all)` : '')
  const found = (Object.keys(counts) as (keyof typeof counts)[]).filter((key) => counts[key] > 0).map((key) => `${counts[key]} ${COUNT_LABELS[key]}`)
  return [
    `Headings: ${headings.length ? list(headings) : 'none'}`,
    `Buttons and links: ${actions.size ? list([...actions].map((text) => JSON.stringify(text))) : 'none'}`,
    ...(fields.length ? [`Form fields: ${list(fields)}`] : []),
    `Also found: ${found.length ? found.join(', ') : 'nothing notable'}`,
  ].join('\n')
}

// An element's text including its descendants' (the tree keeps each node's own text only).
function textOf(node: CapturedNode): string {
  const parts: string[] = []
  let length = 0
  const visit = (n: CapturedNode) => {
    if (length > 120) return
    const text = n.text?.trim()
    if (text) {
      parts.push(text)
      length += text.length
    }
    n.children.forEach(visit)
  }
  visit(node)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function outlineOf(root: CapturedNode): string {
  const lines: string[] = []
  const visit = (node: CapturedNode, depth: number) => {
    let line = '  '.repeat(depth) + node.tag
    if (node.id) line += `#${node.id}`
    if (node.classes?.length) line += '.' + node.classes.join('.')
    line += ` [${node.box.w}x${node.box.h}]`
    const attrs = KEY_ATTRS.filter((name) => node.attrs[name]).map((name) => `${name}="${node.attrs[name].slice(0, 60)}"`)
    if (attrs.length) line += ` {${attrs.join(' ')}}`
    const styles = KEY_STYLES.filter((name) => node.styles[name]).map((name) => `${name}:${node.styles[name].slice(0, 60)}`)
    if (styles.length) line += ` (${styles.join('; ')})`
    if (node.states?.length) line += ` states:${node.states.map((state) => state.state).join(',')}`
    if (node.text) line += ` "${node.text.slice(0, 80)}"`
    if (node.note) line += ` -- ${node.note.slice(0, 120)}`
    lines.push(line)
    node.children.forEach((child) => visit(child, depth + 1))
  }
  visit(root, 0)
  return lines.join('\n')
}

export function clipOutline(text: string): string {
  if (text.length <= OUTLINE_BUDGET) return text
  return `${text.slice(0, OUTLINE_HEAD)}\n… (middle of outline omitted)\n${text.slice(-OUTLINE_TAIL)}`
}
