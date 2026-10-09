// On-page inspector: highlights the hovered element, lets the user walk up/down the tree,
// and on click captures the element and shows the result in a drawer.
import { captureForAnalysis } from '../shared/analyze'
import { componentNames, kitBase, projectName } from '../shared/kit'
import { buildPrompt } from '../shared/prompt'
import { askExtension } from '../shared/reply'
import type { AnalyzeResponse, BackgroundMessage, Box, Capture, ProjectResponse, ScreenshotResponse } from '../shared/types'
import { captureTags, FLASH_MS, LABELS } from '../shared/ui'
import { captureElement, collectSectionMedia } from './extract'
import { loadOverlayFont } from './font'
import { renderPrompt } from './markdown'
import { mergeAssets, saveMedia } from './media'
import { findCanvasCode } from './code'
import { captureFullSection, initialShot, toPng, type Shot } from './frames'
import { compareSchemes } from './scheme'
import OVERLAY_CSS from './overlay.css?inline'
import { captureParts, PartsLayer } from './parts'
import { pagePlacement } from './placement'
import { inspectRuntime } from './runtime'
import { wantsScrollRecording } from './scroll'
import { endClickSweep, endSweep, hasClickTargets, hasSweepTargets, sweepClicks, sweepHover } from './sweep'
import { TextLog } from './timeline'
import { Trace } from './trace'

// Drawer motion. DRAWER_MS must match the .panel transition in overlay.css.
const DRAWER_MS = 450
const CLOSED_TRANSFORM = 'translateX(calc(100% + 2px))'
const SWIPE_CLOSE_RATIO = 0.25 // swiped past a quarter of the drawer's width
const SWIPE_FLICK_VELOCITY = 0.5 // px/ms: a quick flick closes it even when dragged a short way
const SPINNER_MIN_MS = 300 // a button's spinner shows at least this long

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

function describe(el: Element): string {
  let s = el.tagName.toLowerCase()
  if (el.id) s += `#${el.id}`
  const cls = Array.from(el.classList).slice(0, 2)
  if (cls.length) s += '.' + cls.join('.')
  return s
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png'
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: mime })
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, children: (Node | string)[] = []) {
  const node: HTMLElementTagNameMap[K] = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

// A lucide icon from its path data, built with DOM calls like everything else here.
function icon(paths: string[], className?: string) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  const attrs = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v)
  if (className) svg.setAttribute('class', className)
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

const enterIcon = () => icon(['M20 4v7a4 4 0 0 1-4 4H4', 'm9 10-5 5 5 5']) // lucide "corner-down-left"
const spinnerIcon = () => icon(['M21 12a9 9 0 1 1-6.219-8.56'], 'spin') // lucide "loader-circle", as in shadcn's Spinner
const checkIcon = () => icon(['M20 6 9 17l-5-5']) // lucide "check"
const alertIcon = () => icon(['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01']) // lucide "triangle-alert"

type MarkerState = 'active' | 'done' | 'error'

// One row of the capture log. Same composition as shadcn's Marker: icon slot + content.
// The active row shimmers, the way MarkerContent does while information is still being gathered.
interface StatusStep {
  label: string
  state: MarkerState
}

// The prompt to copy, and why the app zip failed, if it did (shown above the prompt).
interface Packaged {
  prompt: string
  note: string | null
}

function statusMarker(step: StatusStep) {
  const row = el('div', { className: 'marker' })
  row.dataset.state = step.state
  if (step.state === 'active') row.setAttribute('role', 'status')
  const glyph = step.state === 'active' ? spinnerIcon() : step.state === 'error' ? alertIcon() : checkIcon()
  const iconSlot = el('span', { className: 'marker-icon' }, [glyph])
  iconSlot.setAttribute('aria-hidden', 'true')
  const content = el('span', {
    className: step.state === 'active' ? 'marker-content shimmer' : 'marker-content',
    textContent: step.label,
  })
  row.append(iconSlot, content)
  return row
}

// Screenshot preview: every capture shows in the same fixed 4:3 frame (.preview in overlay.css).
// Inside it the image is scaled to fit the frame's width, but never past its real size, so small
// elements show at 1:1 instead of blown up into a banner. Long sections keep that width and scroll
// vertically; very wide strips (navbars) keep a readable height and scroll sideways. Anything
// smaller than the frame is centered.
const PREVIEW_PADDING = 12 // px, must match .preview padding
const PREVIEW_MIN_HEIGHT = 56 // px: wide strips never shrink below this

function layoutPreview(frame: HTMLElement, image: HTMLImageElement, cssWidth: number, cssHeight: number, caption: HTMLElement) {
  let available = 0
  let scale = 1
  // Two passes at most: if the first size makes a vertical scrollbar appear, it narrows the frame's
  // content box, so fit again to the narrower width.
  for (let pass = 0; pass < 2 && available !== frame.clientWidth - PREVIEW_PADDING * 2; pass++) {
    available = frame.clientWidth - PREVIEW_PADDING * 2
    scale = Math.min(1, available / cssWidth)
    if (cssHeight * scale < PREVIEW_MIN_HEIGHT) scale = Math.min(1, PREVIEW_MIN_HEIGHT / cssHeight)
    image.style.width = `${Math.round(cssWidth * scale)}px`
    image.style.height = `${Math.round(cssHeight * scale)}px`
  }

  const scrolls = frame.scrollWidth > frame.clientWidth || frame.scrollHeight > frame.clientHeight
  const size = `${Math.round(cssWidth)}×${Math.round(cssHeight)}`
  const zoom = scale === 1 ? 'Actual size' : `${Math.round(scale * 100)}%`
  caption.textContent = [size, zoom, scrolls ? 'Scroll to see all' : ''].filter(Boolean).join(' · ')
}
// A PNG of one area of the section screenshot. The screenshot covers the visible part of the section,
// in device pixels; `box` is relative to the section's top-left corner, in CSS pixels.
async function cropScreenshot(shot: string, sectionRect: DOMRect, box: Box): Promise<string | undefined> {
  const bitmap = await createImageBitmap(dataUrlToBlob(shot))
  const left = Math.max(0, sectionRect.left)
  const top = Math.max(0, sectionRect.top)
  const scale = bitmap.width / (Math.min(sectionRect.right, window.innerWidth) - left)
  const x = (sectionRect.left + box.x - left) * scale
  const y = (sectionRect.top + box.y - top) * scale
  const w = Math.min(box.w * scale, bitmap.width - x)
  const h = Math.min(box.h * scale, bitmap.height - y)
  if (x < 0 || y < 0 || w < 4 || h < 4) return undefined
  const canvas = new OffscreenCanvas(Math.round(w), Math.round(h))
  canvas.getContext('2d')!.drawImage(bitmap, x, y, w, h, 0, 0, Math.round(w), Math.round(h))
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => resolve(undefined)
    reader.readAsDataURL(blob)
  })
}

// Canvas, WebGL and embed pixels can't be read as DOM, so keep a snapshot of each from the screenshot.
// Canvases whose pixels the capture could read directly (see extract.ts) already have one.
async function addSnapshots(capture: Capture, shot: string, sectionRect: DOMRect) {
  const read = new Set(capture.assets.filter((a) => a.kind === 'canvas').map((a) => a.target))
  for (const embed of capture.embeds) {
    if (!embed.box.w || !embed.box.h || read.has(embed.target)) continue
    try {
      const src = await cropScreenshot(shot, sectionRect, embed.box)
      if (src) capture.assets.push({ kind: 'canvas', src, target: embed.target, width: embed.box.w, height: embed.box.h })
    } catch (err) {
      console.warn('[jevelements] could not snapshot', embed.target, err)
    }
  }
}

type ButtonVariant = 'primary' | 'outline' | 'ghost'

// Same variants and size as the popup's shadcn <Button>; styles live in overlay.css.
function button(variant: ButtonVariant, text: string, onclick: () => void) {
  return el('button', { type: 'button', className: `btn btn-${variant}`, textContent: text, onclick })
}

// Temporarily swap a button's label, e.g. "Copy prompt" → "Copied".
function flash(btn: HTMLButtonElement, text: string) {
  const original = btn.textContent
  btn.textContent = text
  setTimeout(() => (btn.textContent = original), FLASH_MS)
}

// A button for async work (shadcn Button with a Spinner): while `task` runs it shows a spinner before
// the label and is disabled, then it briefly shows the label `task` returns (e.g. "Copied").
// The spinner stays at least SPINNER_MIN_MS so instant work doesn't just flicker.
function asyncButton(variant: ButtonVariant, text: string, task: () => Promise<string>) {
  const btn = button(variant, text, async () => {
    btn.disabled = true
    btn.setAttribute('aria-busy', 'true')
    btn.prepend(spinnerIcon())
    const done = () => {
      btn.querySelector('.spin')?.remove()
      btn.disabled = false
      btn.removeAttribute('aria-busy')
    }
    try {
      const [result] = await Promise.all([task(), new Promise((resolve) => setTimeout(resolve, SPINNER_MIN_MS))])
      done()
      flash(btn, result)
    } catch (err) {
      done()
      throw err
    }
  })
  return btn
}

export class Inspector {
  private host: HTMLElement
  private shadow: ShadowRoot
  private highlight: HTMLDivElement
  private label: HTMLDivElement
  private parts: PartsLayer // the hovered element's parts, in dotted boxes
  private toolbar: HTMLDivElement
  private current: Element | null = null
  private childTrail: Element[] = []
  private active = false
  private drawers: HTMLDivElement[] = [] // open result drawers, bottom → top
  private resultBody: HTMLDivElement | null = null
  private resultActions: HTMLDivElement | null = null
  private textLog: TextLog | null = null // text the page animates while the picker is open
  private capturing = false

  constructor() {
    loadOverlayFont()
    this.host = document.createElement('jev-inspector')
    this.shadow = this.host.attachShadow({ mode: 'open' })
    this.highlight = el('div', { className: 'highlight' })
    this.label = el('div', { className: 'label' })
    // Built with DOM calls, never innerHTML: sites that enforce Trusted Types (GitHub, …) throw on it.
    const kbd = (key: string | Node) => el('kbd', {}, [key])
    const group = (...children: (Node | string)[]) => el('span', { className: 'group' }, children)
    const sep = () => el('span', { className: 'sep' })
    const enter = kbd(enterIcon())
    enter.title = 'Enter'
    this.toolbar = el('div', { className: 'toolbar' }, [
      el('span', { className: 'brand', textContent: 'JevElements' }),
      sep(),
      group(kbd('Click'), el('span', { className: 'or', textContent: '/' }), enter, 'Capture'),
      sep(),
      group(kbd('↑'), kbd('↓'), 'Parent / child'),
      sep(),
      group(kbd('Esc'), 'Exit'),
    ])
    this.shadow.append(el('style', { textContent: OVERLAY_CSS }), this.highlight, this.label)
    this.parts = new PartsLayer(this.shadow)
    // The overlay hangs off <html>, outside the page's app, but a page that re-renders the whole
    // document (a framework recovering from a hydration error, a script tidying <html>'s children)
    // can still drop it while the capture clicks around. Put back, the drawer carries on as it was.
    const reattach = new MutationObserver(() => {
      if (!this.host.isConnected && (this.active || this.capturing || this.drawers.length)) {
        console.warn('[jevelements] the page removed the overlay; putting it back')
        document.documentElement.appendChild(this.host)
      }
      reattach.observe(document.documentElement, { childList: true }) // a new <html> if the page swapped it
    })
    reattach.observe(document, { childList: true })
    reattach.observe(document.documentElement, { childList: true })
  }

  toggle() {
    if (this.active) this.stop()
    else this.start()
  }

  start() {
    if (this.active || this.capturing) return
    this.active = true
    this.closePanel()
    if (!this.host.isConnected) document.documentElement.appendChild(this.host)
    this.shadow.append(this.toolbar)
    this.textLog?.stop()
    this.textLog = new TextLog()
    this.textLog.start()
    window.addEventListener('mousemove', this.onMove, true)
    window.addEventListener('click', this.onClick, true)
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'])
      window.addEventListener(type, this.swallow, true)
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('scroll', this.reposition, true)
    window.addEventListener('resize', this.reposition, true)
  }

  stop() {
    if (!this.active) return
    this.active = false
    // A capture still needs the text log (runCapture stops it); otherwise the picker was dismissed.
    if (!this.capturing) {
      this.textLog?.stop()
      this.textLog = null
    }
    window.removeEventListener('mousemove', this.onMove, true)
    window.removeEventListener('click', this.onClick, true)
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'])
      window.removeEventListener(type, this.swallow, true)
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('scroll', this.reposition, true)
    window.removeEventListener('resize', this.reposition, true)
    this.toolbar.remove()
    this.highlight.style.display = 'none'
    this.label.style.display = 'none'
    this.parts.clear()
    this.current = null
    this.childTrail = []
  }

  // navigator.clipboard can be unavailable or denied on some pages; fall back to execCommand.
  // Resolves false when neither worked, so the button can say so instead of claiming "Copied".
  private async copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      const scratch = el('textarea', { value: text })
      scratch.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
      this.shadow.append(scratch)
      scratch.select()
      const copied = document.execCommand('copy')
      scratch.remove()
      return copied
    }
  }

  // Copy to clipboard; if the page blocks image clipboard writes, save the file instead.
  private async copyScreenshot(shot: string, fileName: string): Promise<string> {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPng(shot) })])
      return LABELS.copied
    } catch {
      this.download(dataUrlToBlob(shot), `jevelements-${fileName}`)
      return LABELS.downloaded
    }
  }

  private download(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob)
    el('a', { href: url, download: fileName }).click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  // ---------- hover / selection ----------

  private isOwn(target: EventTarget | null) {
    return target === this.host
  }

  private onMove = (e: MouseEvent) => {
    if (!e.isTrusted) return
    let target = e.target as Element | null
    if (target === document.documentElement) target = document.body // empty page area: pick <body>, not <html>
    if (!target || this.isOwn(target) || target === this.current) return
    this.childTrail = []
    this.select(target)
  }

  private select(target: Element) {
    this.current = target
    this.parts.show(target)
    this.reposition()
  }

  private reposition = () => {
    if (!this.current) return
    const r = this.current.getBoundingClientRect()
    Object.assign(this.highlight.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    })
    this.parts.place()
    const parts = this.parts.count
    const size = `${Math.round(r.width)}×${Math.round(r.height)}${parts ? ` · ${parts} part${parts === 1 ? '' : 's'}` : ''}`
    this.label.replaceChildren(describe(this.current), ' ', el('span', { className: 'dim', textContent: size }))
    const labelTop = r.top > 26 ? r.top - 24 : Math.min(r.bottom + 4, window.innerHeight - 24)
    Object.assign(this.label.style, { display: 'block', left: `${Math.max(4, r.left)}px`, top: `${labelTop}px` })
  }

  // The picker only reacts to the user: the capture dispatches synthetic pointer events of its own (play.ts, sweep.ts).
  private swallow = (e: Event) => {
    if (!e.isTrusted) return
    if (this.isOwn(e.target)) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  private onClick = (e: MouseEvent) => {
    if (!e.isTrusted) return
    if (this.isOwn(e.target)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (this.current) void this.capture(this.current)
  }

  private onKey = (e: KeyboardEvent) => {
    const handled = ['Escape', 'ArrowUp', 'ArrowDown', 'Enter']
    // Only the user's own keys: the capture's undo step dispatches a synthetic Escape (play.ts).
    if (!e.isTrusted || !handled.includes(e.key)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.key === 'Escape') return this.stop()
    if (!this.current) return
    if (e.key === 'ArrowUp') {
      const parent = this.current.parentElement
      if (parent && parent !== document.documentElement) {
        this.childTrail.push(this.current)
        this.select(parent)
      }
    } else if (e.key === 'ArrowDown') {
      const child = this.childTrail.pop() ?? this.current.firstElementChild
      if (child) this.select(child)
    } else if (e.key === 'Enter') {
      void this.capture(this.current)
    }
  }

  // ---------- capture ----------

  // The gathering log: finished steps stay put, the current one shimmers.
  private showStatus(steps: StatusStep[]) {
    this.showPanel([el('div', { className: 'markers' }, steps.map(statusMarker))])
  }

  // The background worker marks the tab while a capture runs, so if the page goes away mid-capture
  // the next page can say why the drawer vanished (see interrupted()).
  private async capture(target: Element) {
    if (this.capturing) return // one capture at a time: a second one would fight the first over the page
    this.capturing = true
    await this.markCapturing(true)
    try {
      await this.runCapture(target)
    } finally {
      this.capturing = false
      void this.markCapturing(false)
    }
  }

  private async markCapturing(active: boolean) {
    const message: BackgroundMessage = { type: 'jev:capturing', active }
    await askExtension(message)
  }

  // The tab loaded a new page while a capture was running on the previous one. This is the new page's
  // inspector: the capture is gone with the old page, so say what happened and offer the way back.
  interrupted(from: string, to: string) {
    if (this.capturing) return // still the capturing page: a same-document route change
    void this.markCapturing(false)
    this.stop()
    this.closePanel()
    const where = (url: string) => {
      try {
        const u = new URL(url)
        return u.host + u.pathname
      } catch {
        return url
      }
    }
    const reloaded = from === to
    const step: StatusStep = { label: reloaded ? 'Capture stopped: the page reloaded' : `Capture stopped: the page changed to ${where(to)}`, state: 'error' }
    const note = reloaded
      ? 'Reloading the page ends a capture that is running. Pick the section again.'
      : `The capture of ${where(from)} was still running when the tab opened another page, which ends it. Go back and pick the section again.`
    const goBack = !reloaded && button('primary', 'Go back', () => history.back())
    const pick = button(reloaded ? 'primary' : 'outline', LABELS.newSection, () => this.start())
    this.showPanel([el('div', { className: 'markers' }, [statusMarker(step)]), el('p', { className: 'note', textContent: note })], goBack ? [goBack, pick] : [pick])
  }

  private async runCapture(target: Element) {
    this.stop()
    const rect = target.getBoundingClientRect()
    const screenshot = await this.screenshot(target)

    const frame: StatusStep = { label: screenshot ? 'Captured the frame' : 'Frame unavailable', state: 'done' }
    let steps: StatusStep[] = [frame, { label: 'Reading structure', state: 'active' }]
    this.showStatus(steps)
    await nextFrame()

    try {
      // The section's parts as the picker showed them, read before hovers and clicks change anything.
      const parts = captureParts(target)
      const placement = pagePlacement(target)
      const [{ capture, recordScroll, recordInteractions }, runtime] = await Promise.all([
        captureElement(
          target,
          (phase) => {
            if (phase !== 'watching') return
            steps = [frame, { label: 'Read the structure', state: 'done' }, { label: 'Watching motion', state: 'active' }]
            this.showStatus(steps)
          },
          this.textLog ?? undefined,
        ),
        inspectRuntime(target),
      ])
      capture.screenshot = screenshot
      if (parts.length) capture.parts = parts
      capture.placement = placement
      if (runtime) {
        capture.runtime = runtime
        capture.libraries = runtime.libraries
        for (const embed of capture.embeds) if (runtime.offscreen?.includes(embed.target)) embed.offscreen = true
      }
      if (screenshot) await addSnapshots(capture, screenshot, rect)

      steps = [frame, { label: 'Read the structure', state: 'done' }, { label: 'Watched motion', state: 'done' }]
      if (wantsScrollRecording(capture, runtime, target)) {
        const recorded = steps
        const progress = (text: string) => this.showStatus([...recorded, { label: text, state: 'active' }])
        progress('Recording the scroll story')
        const story = await recordScroll({
          runtime,
          onProgress: (done, total) => progress(`Recording the scroll story (${Math.min(99, Math.round((done / total) * 100))}%)`),
        })
        if (story) {
          // Images the story swapped in and out, and image sequences drawn onto a canvas.
          mergeAssets(capture, story.media ?? [])
          story.media = undefined
          capture.scrollStory = story
          capture.scrollRecorded = story.phases.some((p) => p.kind === 'change') || story.pinned.length > 0 || story.continuous.length > 0
        }
        // Lazy images and videos load as they scroll into view.
        mergeAssets(capture, collectSectionMedia(target))
        const phases = story?.phases.filter((p) => p.kind === 'change').length ?? 0
        steps = [...recorded, { label: phases ? `Recorded ${phases} scroll phase${phases === 1 ? '' : 's'}` : 'Recorded scroll', state: 'done' }]
      }

      {
        const played = steps
        const progress = (text: string) => this.showStatus([...played, { label: text, state: 'active' }])
        progress('Playing hover & click')
        // Pink rings on the page around what is being played, and around any popup it opens.
        const trace = new Trace(this.shadow)
        // States found beyond each component's first, counted across every component explored.
        let earlier = 0
        let current = 0
        const report = await recordInteractions({
          onProgress: (done, total) => progress(`Playing hover & click (${done + 1}/${total})`),
          onExplore: (_component, states) => {
            if (states === 1) [earlier, current] = [earlier + current, 0] // the next component starts
            else current = states - 1
            progress(`Exploring the states (${earlier + current} found)`)
          },
          onFocus: (focus) => trace.show(focus),
        }).finally(() => trace.stop())
        mergeAssets(capture, report.media ?? [])
        report.media = undefined
        capture.interactions = report
        const tested = report.tested.hover + report.tested.click
        const found = report.items.length
        const states = (report.components ?? []).reduce((sum, c) => sum + c.states.length - 1, 0)
        const explored = states ? `, ${states} component state${states === 1 ? '' : 's'}` : ''
        steps = [...played, { label: tested ? `Played ${tested} interaction${tested === 1 ? '' : 's'}, ${found} changed something${explored}` : 'No hover or click targets', state: 'done' }]
        // Content revealed by clicks (tab panels, accordions) can bring its own images.
        mergeAssets(capture, collectSectionMedia(target))
      }

      // What follows the pointer's position (a shader, a spotlight, a cursor follower, parallax, a tilt)
      // changes with every pixel the pointer moves, which hovering each control above can't see: the
      // pointer is swept over each canvas, and over the section when the page listens for the pointer,
      // left to right and top to bottom, with values and pixels read every frame. The trace shows it in green.
      if (hasSweepTargets(target)) {
        const before = steps
        const progress = (text: string) => this.showStatus([...before, { label: text, state: 'active' }])
        progress('Sweeping the pointer over the section')
        const trace = new Trace(this.shadow)
        const sweep = await sweepHover(target, {
          shoot: (r) => this.shootUnder(r),
          drawerEdge: () => this.drawerEdge(),
          onProgress: progress,
          onFocus: (focus) => trace.show(focus),
        }).finally(() => trace.stop())
        if (sweep.hovers.length) capture.hoverSweep = sweep.hovers
        const reacted = sweep.hovers.length
        const label = reacted
          ? `Mapped the pointer hover on ${sweep.hovers.map((h) => h.target).join(', ')}`
          : sweep.swept
            ? 'Swept the pointer: nothing follows it'
            : 'Off screen: pointer hover not swept'
        steps = [...before, { label, state: 'done' }]
      } else endSweep()

      // Clicks where nothing is a control: a canvas (a ripple, a burst, picking an object) or the
      // section's own background (click anywhere to change it). Clicked at a grid of points with
      // navigation and server writes blocked; the trace shows it in amber.
      if (hasClickTargets(target)) {
        const before = steps
        const progress = (text: string) => this.showStatus([...before, { label: text, state: 'active' }])
        progress('Click sweep over the section')
        const trace = new Trace(this.shadow)
        const sweep = await sweepClicks(target, {
          shoot: (r) => this.shootUnder(r),
          drawerEdge: () => this.drawerEdge(),
          onProgress: progress,
          onFocus: (focus) => trace.show(focus),
        }).finally(() => trace.stop())
        if (sweep.clicks.length) capture.clickSweep = sweep.clicks
        if (sweep.skipped.length && capture.interactions) capture.interactions.skipped.push(...sweep.skipped)
        const label = sweep.clicks.length
          ? `Mapped clicks on ${sweep.clicks.map((c) => c.target).join(', ')}`
          : sweep.swept
            ? 'Click sweep: clicking the free space does nothing'
            : 'Click sweep skipped'
        steps = [...before, { label, state: 'done' }]
      } else endClickSweep(target)

      // The section under the light and the dark OS colour scheme (emulated in the page, see scheme.ts),
      // after the sweeps: focus is cleared before each pass.
      {
        steps = [...steps, { label: 'Comparing light and dark mode', state: 'active' }]
        this.showStatus(steps)
        const schemes = await compareSchemes(target, { take: (r) => this.shootUnder(r), right: () => this.drawerEdge() })
        capture.schemes = schemes
        mergeAssets(capture, schemes.media ?? [])
        schemes.media = undefined
        const label = schemes.error ? `Light/dark check skipped: ${schemes.error}` : schemes.differs ? 'Dark mode changes the section' : 'Looks the same in light and dark mode'
        steps = [...steps.slice(0, -1), { label, state: schemes.error ? 'error' : 'done' }]
      }

      // Canvases drawn by code the capture couldn't watch (a Web Worker, or WebGL that started before
      // the probe): find that code in the page's scripts so the rebuild can port it.
      if (capture.embeds.some((e) => /WebGL|Canvas/.test(e.kind))) {
        steps = [...steps, { label: 'Finding the canvas code', state: 'active' }]
        this.showStatus(steps)
        capture.code = await findCanvasCode(target, capture)
        const found = capture.code.length
        steps = [...steps.slice(0, -1), { label: found ? `Found the canvas code in ${found} script${found === 1 ? '' : 's'}` : 'No canvas code found in the page scripts', state: 'done' }]
      }

      // The one screenshot is the initial look. Sections taller than the screen get it stitched top to
      // bottom instead, after the scroll story so one-time reveals were recorded first.
      if (rect.height > window.innerHeight * 1.05) {
        // The drawer would be in every shot, so the overlay is hidden until the last one is taken.
        steps = [...steps, { label: 'Screenshotting the full section', state: 'active' }]
        this.showStatus(steps)
        this.host.style.display = 'none'
        try {
          capture.fullScreenshot = await captureFullSection(target, (r) => this.shootRect(r))
        } finally {
          this.host.style.display = ''
        }
        steps = [...steps.slice(0, -1), { label: capture.fullScreenshot ? 'Screenshotted the full section' : 'Full section screenshot unavailable', state: 'done' }]
      }

      const shot = initialShot(capture)

      {
        const before = steps
        const progress = (text: string) => this.showStatus([...before, { label: text, state: 'active' }])
        progress('Saving images, video & canvas')
        await saveMedia(capture, shot, (done, total) => progress(`Saving images, video & canvas (${done}/${total})`))
        const saved = capture.saved
        const failed = saved?.failed.length ?? 0
        const files = saved?.uploaded.filter((p) => p.startsWith('capture/')).length ?? 0
        const named = new Set([...Object.values(saved?.files ?? {}), ...capture.assets.map((a) => a.file)].filter(Boolean)).size
        // No zip is expected from a deployed backend (it stores nothing), so this is not an error: the
        // prompt points at the files on the live site instead. Locally, the console says why.
        const unsaved = !saved?.archive && (named > 0 || failed > 0)
        const savedLabel = saved?.archive
          ? `Zipped ${files} file${files === 1 ? '' : 's'} for public/${failed ? `, ${failed} failed` : ''}`
          : unsaved
            ? 'Images and video linked from the live site'
            : 'No images or video'
        steps = [...before, { label: savedLabel, state: 'done' }]
      }

      // Always try the jev backend; if it isn't running, the local prompt is still complete.
      steps = [...steps, { label: 'Classifying the section', state: 'active' }]
      this.showStatus(steps)
      const res = await this.analyze(capture)
      if ('error' in res) console.info('[jevelements] jev analysis skipped:', res.error)
      else capture.analysis = res.analysis

      // The classification names the app, so the zip is packaged last.
      let packaged: Packaged = { prompt: buildPrompt(capture), note: null }
      if (capture.saved?.archive) {
        steps = [...steps.slice(0, -1), { label: `Packaging ${projectName(capture)}.zip`, state: 'active' }]
        this.showStatus(steps)
        packaged = await this.packageApp(capture, capture.saved.archive)
      }

      this.textLog?.stop()
      this.textLog = null
      this.renderResult(capture, packaged, shot)
    } catch (err) {
      console.error('[jevelements] capture failed', err)
      const message = err instanceof Error ? err.message : String(err)
      this.showStatus([...steps.filter((step) => step.state !== 'active'), { label: `Capture failed: ${message}`, state: 'error' }])
    } finally {
      // Success or failure, leave nothing of the capture on the page.
      this.textLog?.stop()
      this.textLog = null
      endSweep()
      endClickSweep(target)
    }
  }

  private async screenshot(target: Element): Promise<string | undefined> {
    if (!(await this.whenVisible())) {
      console.warn('[jevelements] screenshot skipped: the tab stayed in the background')
      return undefined
    }
    const r = target.getBoundingClientRect()
    this.host.style.display = 'none'
    await nextFrame()
    await nextFrame()
    try {
      const message: BackgroundMessage = {
        type: 'jev:screenshot',
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        viewportWidth: window.innerWidth,
      }
      const res: ScreenshotResponse = await askExtension(message)
      if ('error' in res) console.warn('[jevelements] screenshot failed:', res.error)
      else return res.dataUrl
    } finally {
      this.host.style.display = ''
    }
    return undefined
  }

  // A screenshot of a viewport rect for the sweeps, which take dozens. The drawer stays on screen the
  // whole time: the sweeps keep their shots left of it (drawerEdge), so only the overlay's pieces over
  // the rect are hidden for the shot, and only when there are any. The sweeps' own trace is drawn
  // outside what they shoot (trace.ts), so it stays on screen instead of blinking with every shot: an
  // unfilled ring that encloses the rect paints nothing over it.
  private async shootUnder(rect: { x: number; y: number; w: number; h: number }): Promise<string | undefined> {
    const over = Array.from(this.shadow.children).filter((child): child is HTMLElement => {
      if (!(child instanceof HTMLElement) || child.classList.contains('panel') || child.style.visibility === 'hidden') return false
      const r = child.getBoundingClientRect()
      const ring = child.classList.contains('outside') && (child.classList.contains('trace') || child.classList.contains('trace-area'))
      if (ring && r.left < rect.x && r.top < rect.y && r.right > rect.x + rect.w && r.bottom > rect.y + rect.h) return false
      return r.width > 0 && r.height > 0 && r.left < rect.x + rect.w && r.right > rect.x && r.top < rect.y + rect.h && r.bottom > rect.y
    })
    for (const child of over) child.style.visibility = 'hidden'
    if (over.length) {
      await nextFrame()
      await nextFrame()
    }
    try {
      return await this.shootRect(rect)
    } finally {
      for (const child of over) child.style.visibility = ''
    }
  }

  // Where the open drawers start, from the left of the viewport; the whole width when none is open.
  private drawerEdge(): number {
    return Math.min(window.innerWidth, ...this.drawers.map((d) => d.getBoundingClientRect().left))
  }

  // One piece of the full-section screenshot (the caller hides the overlay for the whole run).
  private async shootRect(rect: { x: number; y: number; w: number; h: number }): Promise<string | undefined> {
    const wasHidden = document.visibilityState !== 'visible'
    if (!(await this.whenVisible())) {
      console.warn('[jevelements] screenshot skipped: the tab stayed in the background')
      return undefined
    }
    if (wasHidden) {
      await nextFrame()
      await nextFrame()
    }
    try {
      const message: BackgroundMessage = { type: 'jev:screenshot', rect, viewportWidth: window.innerWidth }
      const res: ScreenshotResponse = await askExtension(message)
      if ('error' in res) console.warn('[jevelements] screenshot failed:', res.error)
      else return res.dataUrl
    } catch (err) {
      console.warn('[jevelements] screenshot failed', err)
    }
    return undefined
  }

  // A hidden tab can't be screenshotted (the service worker refuses), so wait a while for the user to come back.
  private async whenVisible(timeoutMs = 60_000): Promise<boolean> {
    if (document.visibilityState === 'visible') return true
    return new Promise((resolve) => {
      const done = (visible: boolean) => {
        clearTimeout(timer)
        document.removeEventListener('visibilitychange', onChange)
        resolve(visible)
      }
      const onChange = () => {
        if (document.visibilityState === 'visible') done(true)
      }
      const timer = window.setTimeout(() => done(false), timeoutMs)
      document.addEventListener('visibilitychange', onChange)
    })
  }

  private async analyze(capture: Capture): Promise<AnalyzeResponse> {
    const message: BackgroundMessage = { type: 'jev:analyze', capture: captureForAnalysis(capture) }
    return askExtension(message)
  }

  // Names the app, stores the prompt with it on the backend, and downloads <name>.zip: a ready Next.js
  // app with every saved file in public/. The prompt is built for that app, so it's built first.
  private async packageApp(capture: Capture, zip: string): Promise<Packaged> {
    const name = projectName(capture)
    const { file, component } = componentNames(kitBase(capture))
    capture.project = { name, zip }
    const prompt = buildPrompt(capture)
    const message: BackgroundMessage = { type: 'jev:project', captureId: capture.id, name, component, file, prompt }
    const res: ProjectResponse = await askExtension(message)
    if ('error' in res) {
      console.warn('[jevelements] app zip not packaged:', res.error)
      capture.project = undefined
      return { prompt: buildPrompt(capture), note: `Couldn't package the app zip (${res.error}). Make sure the backend is running and capture again.` }
    }
    // A plain link: the backend's Content-Disposition names the file, so no downloads permission is needed.
    el('a', { href: res.zip, download: `${res.name}.zip` }).click()
    return { prompt, note: null }
  }

  // ---------- drawers ----------

  // Results show in non-modal drawers from the right, like shadcn's Drawer with modal={false}: no
  // backdrop, the page stays usable, outside clicks don't close them. "View screenshot" opens a nested
  // drawer on top; the one behind shrinks and peeks out (shadcn's nested drawer). Swiping a drawer
  // right, its ✕, or Esc closes the topmost one.

  // Fill the result drawer, opening it if needed. Later calls only swap its content (loading → result).
  private showPanel(body: Node[], actions: Node[] = []) {
    if (!this.drawers.length) {
      const drawer = this.openDrawer('JevElements')
      this.resultBody = drawer.body
      this.resultActions = drawer.actions
    }
    this.resultBody!.replaceChildren(...body)
    this.resultActions!.replaceChildren(...actions)
  }

  private openDrawer(title: string) {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host)
    const body = el('div', { className: 'body' })
    const actions = el('div', { className: 'actions' })
    // ✕ closes the whole stack; Back (nested drawers), Esc and swiping close only the top drawer.
    const close = button('ghost', '✕', () => this.dismissDrawer(this.drawers[0]))
    close.classList.add('btn-icon')
    close.title = LABELS.close
    const panel = el('div', { className: 'panel' }, [el('header', {}, [el('h2', { textContent: title }), close]), body, actions])

    panel.style.transform = CLOSED_TRANSFORM
    this.shadow.append(panel)
    this.drawers.at(-1)?.classList.add('behind')
    this.drawers.push(panel)
    if (this.drawers.length === 1) window.addEventListener('keydown', this.onPanelKey, true)
    panel.getBoundingClientRect() // commit the off-screen position so the slide-in transitions
    panel.style.transform = ''
    this.enableSwipe(panel)
    return { panel, body, actions }
  }

  private enableSwipe(panel: HTMLDivElement) {
    let swiping = false
    let startX = 0
    let startTime = 0
    let offset = 0

    panel.addEventListener('pointerdown', (e) => {
      // Buttons click and the prompt scrolls/selects; everywhere else starts a swipe.
      if (e.button !== 0 || panel.classList.contains('behind') || (e.target as Element).closest('button, .typeset')) return
      swiping = true
      startX = e.clientX
      startTime = performance.now()
      offset = 0
      panel.setPointerCapture(e.pointerId)
      panel.classList.add('swiping')
    })
    panel.addEventListener('pointermove', (e) => {
      if (!swiping) return
      const dx = e.clientX - startX
      offset = dx > 0 ? dx : dx / 6 // resist dragging inward
      panel.style.transform = `translateX(${offset}px)`
    })
    const release = () => {
      if (!swiping) return
      swiping = false
      panel.classList.remove('swiping')
      const velocity = offset / Math.max(1, performance.now() - startTime) // px per ms
      if (offset > panel.offsetWidth * SWIPE_CLOSE_RATIO || (offset > 20 && velocity > SWIPE_FLICK_VELOCITY)) this.dismissDrawer(panel)
      else panel.style.transform = ''
    }
    panel.addEventListener('pointerup', release)
    panel.addEventListener('pointercancel', release)
  }

  // Slide a drawer (and any drawers stacked on it) out to the right, then remove them.
  private dismissDrawer(panel: HTMLDivElement) {
    const index = this.drawers.indexOf(panel)
    if (index < 0) return
    const closing = this.drawers.splice(index)
    for (const drawer of closing) drawer.style.transform = CLOSED_TRANSFORM
    this.drawers.at(-1)?.classList.remove('behind')
    if (!this.drawers.length) this.forgetResult()
    setTimeout(() => closing.forEach((drawer) => drawer.remove()), DRAWER_MS)
  }

  // Remove every drawer immediately (e.g. when picking again).
  private closePanel() {
    this.drawers.forEach((drawer) => drawer.remove())
    this.drawers = []
    this.forgetResult()
  }

  private forgetResult() {
    this.resultBody = null
    this.resultActions = null
    window.removeEventListener('keydown', this.onPanelKey, true)
  }

  private onPanelKey = (e: KeyboardEvent) => {
    const top = this.drawers.at(-1)
    // A synthetic Escape is the capture closing a menu it opened (play.ts), not the user.
    if (e.isTrusted && e.key === 'Escape' && !this.active && top) this.dismissDrawer(top)
  }

  // The result drawer leads with the rendered prompt. Copy still sends the original markdown.
  private renderResult(capture: Capture, { prompt, note }: Packaged, shot: Shot | undefined) {
    const children: Node[] = []
    const tags = captureTags(capture)
    if (tags.length) children.push(el('div', { className: 'tags' }, tags.map((tag) => el('span', { className: 'tag', textContent: tag }))))
    if (note) children.push(el('p', { className: 'note', textContent: note }))
    if (capture.runtime?.lateProbe && capture.embeds.some((e) => /WebGL|Canvas/.test(e.kind))) {
      children.push(
        el('p', {
          className: 'note',
          textContent: 'This page loaded before JevElements was active, so its 3D/WebGL code was only partly read. Reload the page and capture again to get the full scene and shaders.',
        }),
      )
    }

    children.push(renderPrompt(prompt))

    const copyPrompt = asyncButton('primary', LABELS.copyPrompt, async () => ((await this.copyText(prompt)) ? LABELS.copied : LABELS.copyFailed))
    const copyShot = shot && asyncButton('outline', LABELS.copyScreenshot, () => this.copyScreenshot(shot.dataUrl, shot.file))
    const viewShot = shot && button('outline', LABELS.viewScreenshot, () => this.openScreenshotDrawer(shot))
    const newSection = button('outline', LABELS.newSection, () => this.start())
    const row = (...items: (HTMLButtonElement | undefined | false | '')[]): Node[] => {
      const buttons = items.filter((b): b is HTMLButtonElement => !!b)
      return buttons.length ? [el('div', { className: 'row' }, buttons)] : []
    }

    this.showPanel(children, [copyPrompt, ...row(copyShot, viewShot), newSection])
  }

  // Nested drawer with one screenshot in a fixed preview frame (see layoutPreview).
  private openScreenshotDrawer(shot: Shot) {
    const { panel, body, actions } = this.openDrawer(LABELS.viewScreenshot)
    const image = el('img', { src: shot.dataUrl, alt: shot.detail })
    const frame = el('div', { className: 'preview' }, [image])
    const caption = el('p', { className: 'caption' })
    image.onload = () => {
      // Screenshots are in device pixels; dividing by devicePixelRatio gives the CSS size.
      const cssWidth = image.naturalWidth / shot.dpr
      const cssHeight = image.naturalHeight / shot.dpr
      const layout = () => layoutPreview(frame, image, cssWidth, cssHeight, caption)
      layout()
      new ResizeObserver(layout).observe(frame) // the drawer width follows the window (75vw)
    }
    image.onerror = () => frame.replaceChildren(el('p', { className: 'caption', textContent: "This page doesn't allow showing the screenshot here. Copy it instead." })) // page CSP may block data: images
    body.append(el('div', { className: 'stage' }, [frame, caption]))

    const copyShot = asyncButton('primary', LABELS.copyScreenshot, () => this.copyScreenshot(shot.dataUrl, shot.file))
    const back = button('outline', LABELS.back, () => this.dismissDrawer(panel))
    back.title = `${LABELS.back} (Esc)`
    actions.append(copyShot, back)
  }
}
