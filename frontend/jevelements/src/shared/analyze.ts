import type { Capture } from './types'

// The classifier only reads structure. Screenshots, SVG markup, inline image data and bulky
// runtime payloads (scene exports, Lottie JSON, canvas source code, saved file names) stay here. A stitched
// full-section JPEG is large enough that sending it makes chrome.runtime.sendMessage come back empty.
export function captureForAnalysis(capture: Capture): Capture {
  const assets = capture.assets.map((a) => (a.kind === 'svg' || a.src.startsWith('data:') ? { ...a, src: '' } : a))
  const runtime = capture.runtime && {
    ...capture.runtime,
    three: capture.runtime.three.map((t) => ({ ...t, sceneJson: undefined })),
    lottie: capture.runtime.lottie.map((l) => ({ ...l, json: undefined })),
  }
  const scrollStory = capture.scrollStory && { ...capture.scrollStory, media: undefined }
  const interactions = capture.interactions && { ...capture.interactions, media: undefined }
  const slim: Capture = { ...capture, assets, runtime, scrollStory, interactions }
  delete slim.screenshot
  delete slim.fullScreenshot
  delete slim.saved
  delete slim.code
  return slim
}
