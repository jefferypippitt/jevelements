// Registers Inter for the overlay. @font-face rules inside a shadow root are ignored, so the face is added
// to document.fonts instead. The content build inlines the woff2 as a data URL; decoding it to bytes
// means the host page's CSP font-src can't block it.
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'

// Must match the name in --font-ui (theme.css).
const OVERLAY_FONT_FAMILY = 'JevElements Inter'

let loaded = false

export function loadOverlayFont() {
  if (loaded) return
  loaded = true
  try {
    const base64 = interUrl.slice(interUrl.indexOf(',') + 1)
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const face = new FontFace(OVERLAY_FONT_FAMILY, bytes, { weight: '100 900' })
    document.fonts.add(face)
    void face.load().catch((err) => console.warn('[jevelements] could not load Inter', err))
  } catch (err) {
    console.warn('[jevelements] could not load Inter', err)
  }
}
