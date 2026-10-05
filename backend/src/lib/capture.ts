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
  runtime?: { three: unknown[]; webgl: unknown[]; lottie: unknown[]; gsap?: { tweens: unknown[] } }
  scrollStory?: { phases: { kind: string }[]; pinned: unknown[] }
  interactions?: { items: { kind: string; target: string; appeared: string[] }[] }
}

export function isCapture(value: unknown): value is Capture {
  const c = value as Capture | null
  return !!c && typeof c.url === 'string' && typeof c.root?.tag === 'string' && Array.isArray(c.root.children)
}

const OUTLINE_BUDGET = 14_000
const OUTLINE_HEAD = 10_000
const OUTLINE_TAIL = 3_000
const KEY_STYLES = ['display', 'position', 'grid-template-columns', 'flex-direction', 'overflow-x', 'animation', 'transition', 'background-image']
const KEY_ATTRS = ['href', 'type', 'role', 'aria-label', 'placeholder', 'alt']

export interface CaptureState {
  page: string
  captured: string
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
    signals: [
      `Images/media: ${capture.assets.filter((asset) => asset.kind !== 'svg').length}, inline SVGs: ${capture.assets.filter((asset) => asset.kind === 'svg').length}`,
      `Responsive rules: ${capture.responsive.length}, keyframe animations: ${capture.keyframes.length}`,
      `Libraries: ${capture.libraries?.map((library) => library.name).join(', ') || 'none detected'}`,
      `three.js scenes: ${capture.runtime?.three.length ?? 0}, raw WebGL canvases: ${capture.runtime?.webgl.length ?? 0}, Lottie animations: ${capture.runtime?.lottie.length ?? 0}, GSAP tweens: ${capture.runtime?.gsap?.tweens.length ?? 0}`,
      `Interactions played on the page: ${
        capture.interactions?.items.map((item) => `${item.kind} ${item.target}${item.appeared.length ? ' (reveals content)' : ''}`).join(', ') || 'none that changed anything'
      }`,
      `Scroll story: ${capture.scrollStory ? `${capture.scrollStory.phases.filter((phase) => phase.kind === 'change').length} phases that change on scroll, ${capture.scrollStory.pinned.length} pinned elements` : 'not recorded'}`,
    ].join('\n'),
    siblingGroups,
    outline: clipOutline(outlineOf(capture.root)),
  }
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
