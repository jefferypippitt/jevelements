// Service worker: toggles the on-page picker (toolbar icon or keyboard shortcut), takes cropped
// screenshots, downloads the section's media and uploads it to the backend, calls the backend's
// classifier, names the app zip, and injects the page probe when it's missing. Content scripts
// can't call chrome.tabs.captureVisibleTab or chrome.scripting, and their fetches are bound by the
// host page's CORS rules, so all of that happens here.
import { captureForAnalysis } from '../shared/analyze'
import { extensionFor, fromBase64, MAX_FILE_BYTES, toBase64 } from '../shared/files'
import { sendToInspector } from '../shared/inject'
import { getSettings } from '../shared/storage'
import type {
  AnalyzeMessage,
  AnalyzeResponse,
  BackgroundMessage,
  ProjectMessage,
  ProjectResponse,
  SaveMediaMessage,
  SaveMediaResponse,
  ScreenshotMessage,
  ScreenshotResponse,
  UploadMessage,
  UploadResult,
} from '../shared/types'

const ANALYZE_TIMEOUT_MS = 45_000
const DOWNLOAD_TIMEOUT_MS = 90_000 // background videos can be tens of MB
const UPLOAD_TIMEOUT_MS = 120_000
const DEFAULT_TITLE = 'JevElements: pick a section (Alt+Shift+E)'

type Reply = ScreenshotResponse | AnalyzeResponse | SaveMediaResponse | UploadResult | ProjectResponse | boolean

// There's no popup to show errors in, so a failure is reported on the toolbar icon itself.
async function toggleInspector(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) return
  try {
    await sendToInspector(tab.id, { type: 'jev:toggle' })
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' })
    await chrome.action.setTitle({ tabId: tab.id, title: DEFAULT_TITLE })
  } catch (err) {
    const restricted = /^(chrome|edge|about|chrome-extension|devtools):|chromewebstore\.google\.com/.test(tab.url ?? '')
    const reason = restricted
      ? "Chrome doesn't allow extensions on this page. Try a regular website."
      : `Couldn't start the picker: ${errorText(err)}. Try reloading the page.`
    console.warn('[jevelements]', reason)
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#737373' })
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' })
    await chrome.action.setTitle({ tabId: tab.id, title: `JevElements: ${reason}` })
  }
}

chrome.action.onClicked.addListener((tab) => void toggleInspector(tab))

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-inspector' && tab) void toggleInspector(tab)
})

// The drawer lives in the page, so a page load mid-capture takes it (and the capture) with it. While a
// capture runs, its tab is marked in session storage; when that tab finishes loading a page, the
// content script there is told. If it's still the capturing page (a same-document route change), it
// ignores the message; otherwise it opens the drawer to say what happened, and clears the mark.
const capturingKey = (tabId: number) => `capturing:${tabId}`

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return
  void (async () => {
    const key = capturingKey(tabId)
    const { [key]: from } = await chrome.storage.session.get(key)
    if (typeof from !== 'string') return
    try {
      await sendToInspector(tabId, { type: 'jev:interrupted', from, to: tab.url ?? '' })
    } catch {
      await chrome.storage.session.remove(key) // a page extensions can't run on: nothing to tell
    }
  })()
})

chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove(capturingKey(tabId)))

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse: (res: Reply) => void) => {
  const reply = (work: Promise<Reply>) => {
    work.then(sendResponse, (err) => sendResponse({ error: errorText(err) }))
    return true // keep the channel open for the async response
  }
  switch (message.type) {
    case 'jev:screenshot':
      return reply(captureCropped(sender.tab, message).then((dataUrl) => ({ dataUrl })))
    case 'jev:analyze':
      return reply(analyze(message))
    case 'jev:save-media':
      return reply(saveMedia(message))
    case 'jev:upload':
      return reply(uploadChunk(message))
    case 'jev:project':
      return reply(saveProject(message))
    case 'jev:inject-probe': {
      const tabId = sender.tab?.id
      if (tabId === undefined) return false
      return reply(
        chrome.scripting
          .executeScript({ target: { tabId, frameIds: [sender.frameId ?? 0] }, world: 'MAIN', files: ['probe.js'] })
          .then(() => true, () => false),
      )
    }
    case 'jev:capturing': {
      const tabId = sender.tab?.id
      if (tabId === undefined) return false
      const key = capturingKey(tabId)
      const work = message.active ? chrome.storage.session.set({ [key]: sender.tab?.url ?? '' }) : chrome.storage.session.remove(key)
      return reply(work.then(() => true))
    }
    default: {
      const unhandled: never = message
      console.warn('[jevelements] unknown message', unhandled)
      return false
    }
  }
})

async function analyze({ capture }: AnalyzeMessage): Promise<AnalyzeResponse> {
  const { backendUrl, backendToken } = await getSettings()
  let res: Response
  try {
    res = await fetch(new URL('/api/analyze', backendUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(backendToken ? { Authorization: `Bearer ${backendToken}` } : {}),
      },
      body: JSON.stringify({ capture: captureForAnalysis(capture) }),
      signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
    })
  } catch {
    return { error: `backend not reachable at ${backendUrl} (start it with "pnpm dev" in backend/)` }
  }
  const body = (await res.json().catch(() => null)) as AnalyzeResponse | null
  if (!body || typeof body !== 'object') return { error: `Backend returned ${res.status}` }
  if (!res.ok && !('error' in body)) return { error: `Backend returned ${res.status}` }
  return body
}

// ---------- media ----------

async function download(src: string): Promise<{ blob: Blob; ext: string }> {
  // The service worker has host access to every site, so cross-origin media loads without CORS.
  const res = await fetch(src, { credentials: 'include', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (/text\/html/i.test(type)) throw new Error('got an HTML page instead of a file (hotlink protection or login)')
  const blob = await res.blob()
  if (!blob.size) throw new Error('empty file')
  if (blob.size > MAX_FILE_BYTES) throw new Error(`too large (${Math.round(blob.size / 1048576)} MB)`)
  const ext = extensionFor(blob.type || type, src)
  if (!ext) throw new Error(`unknown file type ${JSON.stringify(type)}`)
  return { blob, ext }
}

// Downloads one file and hands it straight to the backend: the page never holds the bytes.
async function saveMedia({ src, captureId, name, upload, folder = 'media' }: SaveMediaMessage): Promise<SaveMediaResponse> {
  let file: { blob: Blob; ext: string }
  try {
    file = await download(src)
  } catch (err) {
    return { error: `download failed: ${errorText(err)}` }
  }
  const fileName = `${name}.${file.ext}`
  return { file: fileName, upload: upload ? await put(captureId, folder, fileName, file.blob) : undefined }
}

function uploadChunk({ captureId, folder, name, base64, offset }: UploadMessage): Promise<UploadResult> {
  return put(captureId, folder, name, fromBase64(base64), offset)
}

async function put(captureId: string, folder: string, name: string, body: Blob | Uint8Array<ArrayBuffer>, offset = 0): Promise<UploadResult> {
  const { backendUrl, backendToken } = await getSettings()
  const path = `/api/captures/${captureId}/files/${folder}/${encodeURIComponent(name)}${offset ? `?offset=${offset}` : ''}`
  let res: Response
  try {
    res = await fetch(new URL(path, backendUrl), {
      method: 'PUT',
      headers: backendToken ? { Authorization: `Bearer ${backendToken}` } : {},
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
  } catch {
    return { error: `backend not reachable at ${backendUrl}`, unreachable: true }
  }
  if (!res.ok) {
    const reason = ((await res.json().catch(() => null)) as { error?: string } | null)?.error
    return { error: `backend upload failed: ${reason ?? `HTTP ${res.status}`}` }
  }
  return { archive: new URL(`/api/captures/${captureId}/zip`, backendUrl).href }
}

async function saveProject({ captureId, name, component, file, prompt }: ProjectMessage): Promise<ProjectResponse> {
  const { backendUrl, backendToken } = await getSettings()
  let res: Response
  try {
    res = await fetch(new URL(`/api/captures/${captureId}/project`, backendUrl), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(backendToken ? { Authorization: `Bearer ${backendToken}` } : {}) },
      body: JSON.stringify({ name, component, file, prompt }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
  } catch {
    return { error: `backend not reachable at ${backendUrl}` }
  }
  const body = (await res.json().catch(() => null)) as ProjectResponse | null
  if (!res.ok || !body) return { error: (body && 'error' in body && body.error) || `Backend returned ${res.status}` }
  return body
}

// captureVisibleTab shoots whatever tab is in front, so a capture keeps going only while its own tab is.
async function captureCropped(tab: chrome.tabs.Tab | undefined, { rect, viewportWidth }: ScreenshotMessage): Promise<string> {
  if (tab?.id === undefined) throw new Error('screenshots are only taken for a page tab')
  const tabId = tab.id
  const inFront = async () => {
    const now = await chrome.tabs.get(tabId)
    return now.active && now.windowId === tab.windowId
  }
  if (!(await inFront())) throw new Error('the tab is in the background; switch back to it to continue')
  const full = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  if (!(await inFront())) throw new Error('the tab was switched during the screenshot')
  const bitmap = await createImageBitmap(await (await fetch(full)).blob())

  // The screenshot is in device pixels; scale covers devicePixelRatio and browser zoom.
  const scale = bitmap.width / viewportWidth
  const left = Math.max(0, rect.x) * scale
  const top = Math.max(0, rect.y) * scale
  const right = Math.min(bitmap.width, (rect.x + rect.w) * scale)
  const bottom = Math.min(bitmap.height, (rect.y + rect.h) * scale)
  const width = Math.round(right - left)
  const height = Math.round(bottom - top)
  if (width <= 0 || height <= 0) throw new Error('Element is not visible in the viewport')

  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d')!.drawImage(bitmap, left, top, width, height, 0, 0, width, height)
  const type = 'image/png'
  const blob = await canvas.convertToBlob({ type })

  return dataUrl(new Uint8Array(await blob.arrayBuffer()), type)
}

// Service workers can't make blob: URLs, so the screenshot is handed over as a data URL.
function dataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${toBase64(bytes)}`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
