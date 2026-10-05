// The capture's one screenshot: the section's initial look, or the whole section stitched top to
// bottom when it's taller than the screen. Scroll-story phases and hovers/clicks get no screenshots;
// the images they bring on screen are downloaded instead (see media.ts).
import type { Capture } from '../shared/types'

export interface Shot {
  file: string // name in public/reference/
  dataUrl: string
  dpr: number // pixels per CSS pixel, for the preview's "actual size"
  detail: string
}

const STITCH_MAX_VIEWPORTS = 10
const STITCH_MAX_PIXELS = 16_000 // tallest canvas we draw into; taller sections are scaled down
const SNAP_GAP_MS = 550 // chrome.tabs.captureVisibleTab allows two calls per second

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function initialShot(capture: Capture): Shot | undefined {
  const dataUrl = capture.fullScreenshot ?? capture.screenshot
  if (!dataUrl) return undefined
  return {
    file: `section.${dataUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png'}`,
    dataUrl,
    dpr: capture.viewport.dpr,
    detail: capture.fullScreenshot ? 'The whole section top to bottom, stitched while scrolling' : 'The section as it looked when you picked it',
  }
}

// ---------- full-height screenshot ----------

// Scrolls the section through the viewport a screen at a time and stitches the pieces. Fixed and
// sticky elements outside the section (headers, cookie bars, chat bubbles) are hidden meanwhile, or
// they would repeat on every piece. `shoot` captures a viewport rect (CSS px) as a PNG data URL.
export async function captureFullSection(
  root: Element,
  shoot: (rect: { x: number; y: number; w: number; h: number }) => Promise<string | undefined>,
): Promise<string | undefined> {
  const vh = window.innerHeight
  const startY = window.scrollY
  const first = root.getBoundingClientRect()
  const height = Math.min(first.height, vh * STITCH_MAX_VIEWPORTS)
  if (height <= vh * 1.05 || first.width < 1) return undefined
  const top = first.top + startY

  const hidden: [HTMLElement, string][] = []
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*')).slice(0, 6000)) {
    if (root.contains(el) || el.contains(root) || el.tagName === 'JEV-INSPECTOR') continue
    const position = getComputedStyle(el).position
    if (position === 'fixed' || position === 'sticky') {
      hidden.push([el, el.style.visibility])
      el.style.setProperty('visibility', 'hidden', 'important')
    }
  }

  const pieces: { at: number; dataUrl: string }[] = []
  try {
    let at = 0
    while (at < height - 1) {
      window.scrollTo({ top: top + at, behavior: 'instant' })
      await nextFrame()
      await nextFrame()
      await wait(SNAP_GAP_MS)
      const r = root.getBoundingClientRect()
      const bottom = Math.min(height, vh - r.top) // section-relative bottom of what's on screen
      if (bottom <= at + 1) break
      const dataUrl = await shoot({ x: r.left, y: r.top + at, w: r.width, h: bottom - at })
      if (!dataUrl) return undefined
      pieces.push({ at, dataUrl })
      at = bottom
    }
  } finally {
    for (const [el, visibility] of hidden) el.style.visibility = visibility
    window.scrollTo({ top: startY, behavior: 'instant' })
  }
  if (pieces.length < 2) return undefined

  const bitmaps = await Promise.all(pieces.map(async (p) => createImageBitmap(await (await fetch(p.dataUrl)).blob())))
  const pixelsPerCss = bitmaps[0].width / first.width
  const scale = Math.min(1, STITCH_MAX_PIXELS / (height * pixelsPerCss))
  const canvas = new OffscreenCanvas(Math.round(bitmaps[0].width * scale), Math.round(height * pixelsPerCss * scale))
  const ctx = canvas.getContext('2d')!
  bitmaps.forEach((bitmap, i) => ctx.drawImage(bitmap, 0, Math.round(pieces[i].at * pixelsPerCss * scale), Math.round(bitmap.width * scale), Math.round(bitmap.height * scale)))
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  return blobToDataUrl(blob)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// The clipboard only takes PNG.
export async function toPng(dataUrl: string): Promise<Blob> {
  const blob = await (await fetch(dataUrl)).blob()
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}
