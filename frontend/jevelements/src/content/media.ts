// Saves the real files the section shows, so the rebuild never needs a placeholder: every image and
// video (including the ones the scroll story and hovers swap in), the canvas snapshots, the textures,
// models and animation files that canvases and WebGL scenes draw from, the scripts holding canvas code,
// the one screenshot, and the frames of the hover and click sweeps. The backend ships them in the
// public/ folder of the app zip.
//
// The service worker downloads each URL (it has host access to every site, so CORS doesn't apply) and
// uploads it straight to the backend. What it can't get (hotlink protection that wants the site's
// Referer, cookies, blob: URLs) is read again here, in the page's own context, and sent on in chunks.
// Without a running backend nothing is saved, and the inspector says so.
import { extensionFor, fromBase64, MAX_FILE_BYTES, toBase64 } from '../shared/files'
import { askExtension } from '../shared/reply'
import type { Asset, BackgroundMessage, Capture, SaveMediaResponse, SavedFiles, UploadMessage, UploadResult } from '../shared/types'
import type { Shot } from './frames'

const MEDIA_KINDS = new Set<Asset['kind']>(['image', 'background', 'mask', 'video', 'poster'])
// Files the page's scripts loaded for a canvas, WebGL scene or animation (fonts and stream manifests aren't saved).
const SCENE_FILE_RE = /\.(riv|lottie|glb|gltf|bin|drc|splinecode|hdr|exr|ktx2|basis|usdz|fbx|obj|glsl|frag|vert|wgsl)(\?|#|$)|lottie.*\.json|\.json.*lottie/i
const PAGE_FETCH_TIMEOUT_MS = 30_000
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024 // ~11 MB of base64 per message, well under Chrome's 64 MB cap
const CONCURRENCY = 4

// Adds media found after the first walk (lazy images that loaded while scrolling) and drops lazy-load
// placeholders that now have a real file for the same element.
export function mergeAssets(capture: Capture, fresh: Asset[]) {
  const key = (a: Asset) => a.kind + a.src
  const known = new Set(capture.assets.map(key))
  const added = fresh.filter((a) => !known.has(key(a)))
  if (!added.length) return
  const replaced = new Set(added.filter((a) => /^https?:/.test(a.src)).map((a) => a.target))
  capture.assets = [
    ...capture.assets.filter((a) => !(replaced.has(a.target) && a.src.startsWith('data:') && a.src.length < 2_000)),
    ...added,
  ]
}

function ask<T extends object>(message: BackgroundMessage): Promise<T | { error: string }> {
  return askExtension(message)
}

async function fetchInPage(src: string): Promise<{ blob: Blob; ext: string } | null> {
  try {
    const res = await fetch(src, { credentials: 'include', signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.size || blob.size > MAX_FILE_BYTES || /text\/html/.test(blob.type)) return null
    const ext = extensionFor(blob.type || (res.headers.get('content-type') ?? ''), src)
    return ext ? { blob, ext } : null
  } catch {
    return null // cross-origin without CORS
  }
}

// Bytes the page holds, sent to the backend through the service worker a chunk at a time.
async function upload(captureId: string, folder: UploadMessage['folder'], name: string, blob: Blob): Promise<UploadResult> {
  let result: UploadResult = { error: 'empty file' }
  for (let offset = 0; offset < blob.size; offset += UPLOAD_CHUNK_BYTES) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer())
    result = await ask<UploadResult>({ type: 'jev:upload', captureId, folder, name, base64: toBase64(bytes), offset })
    if ('error' in result) break
  }
  return result
}

// Decoded by hand: fetch(dataUrl) is blocked on pages whose CSP leaves data: out of connect-src.
function dataUrlBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'application/octet-stream'
  return new Blob([fromBase64(dataUrl.slice(comma + 1))], { type: mime })
}

// A file name the backend accepts that keeps the original's base name, so a .gltf still finds the
// scene.bin and textures it refers to by relative path.
function baseName(src: string): string {
  let last = ''
  try {
    last = decodeURIComponent(new URL(src).pathname.split('/').pop() ?? '')
  } catch {
    // keep the fallback
  }
  const stem = last.replace(/\.[^.]*$/, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^[^a-z0-9]+/i, '').slice(0, 60)
  return stem || 'file'
}

interface Job {
  src: string
  name: string // without extension: the downloaded type decides it
  assets: Asset[]
}

// Downloads and uploads everything, and records the names the prompt refers to (Asset.file,
// CodeRef.file, Capture.saved).
export async function saveMedia(capture: Capture, shot: Shot | undefined, onProgress?: (done: number, total: number) => void): Promise<void> {
  const saved: SavedFiles = { files: {}, uploaded: [], screenshot: shot?.file, failed: [] }
  try {
    await save(capture, shot, saved, onProgress)
  } finally {
    capture.saved = saved
  }
}

async function save(capture: Capture, shot: Shot | undefined, saved: SavedFiles, onProgress?: (done: number, total: number) => void): Promise<void> {
  const used = new Set<string>()
  const unique = (wanted: string) => {
    let name = wanted
    for (let n = 2; used.has(name); n++) name = `${wanted}-${n}`
    used.add(name)
    return name
  }

  // One file per distinct URL. HLS/DASH streams and YouTube/Vimeo backgrounds aren't files to save.
  const jobs = new Map<string, Job>()
  let count = 0
  for (const asset of capture.assets) {
    if (!MEDIA_KINDS.has(asset.kind) || asset.via || !/^(https?|data|blob):/.test(asset.src)) continue
    const job = jobs.get(asset.src)
    if (job) job.assets.push(asset)
    else {
      // Sequence frames keep their order in the name, so a canvas player can load seq1-0001 … seq1-0240.
      const seq = asset.sequence
      const name = seq ? `seq${seq.id}-${String(seq.index + 1).padStart(4, '0')}` : `${asset.kind}-${String(++count).padStart(2, '0')}`
      jobs.set(asset.src, { src: asset.src, name: unique(name), assets: [asset] })
    }
  }

  // What canvases, WebGL scenes and animations draw from: textures, models, Lottie/Rive files.
  const rt = capture.runtime
  const scene = [
    ...(rt?.three.flatMap((t) => t.textures) ?? []),
    ...(rt?.webgl.flatMap((g) => g.textures) ?? []),
    ...(rt?.lottie.map((l) => l.url ?? '') ?? []),
    ...capture.embeds.filter((e) => /Lottie|3D model/.test(e.kind)).map((e) => e.src ?? ''),
    ...capture.pageMedia.filter((u) => SCENE_FILE_RE.test(u)),
  ]
  for (const src of scene) {
    if (/^https?:/.test(src) && !jobs.has(src)) jobs.set(src, { src, name: unique(baseName(src)), assets: [] })
  }

  let uploading = true // cleared once the backend turns out not to be running
  const record = (path: string, result: UploadResult | undefined) => {
    if (!result) return
    if ('archive' in result) {
      saved.uploaded.push(path)
      saved.archive = result.archive
    } else {
      if (result.unreachable) uploading = false
      console.info('[jevelements] not uploaded:', path, result.error)
    }
  }
  const done = (src: string, file: string, assets: Asset[], result: UploadResult | undefined) => {
    assets.forEach((a) => (a.file = file))
    // data: and blob: sources stay off the map (their assets carry the name), so the capture stays small.
    if (/^https?:/.test(src)) saved.files[src] = file
    record(`capture/${file}`, result)
  }

  const saveOne = async ({ src, name, assets }: Job) => {
    // blob: URLs only exist in this page; everything else tries the service worker first.
    let reason = 'blob: URL could not be read'
    if (!src.startsWith('blob:')) {
      const res = await ask<SaveMediaResponse>({ type: 'jev:save-media', src, captureId: capture.id, name, upload: uploading })
      if (!('error' in res)) return done(src, res.file, assets, res.upload)
      reason = res.error
    }
    const got = await fetchInPage(src)
    if (!got) {
      saved.failed.push({ src, reason: src.startsWith('blob:') ? reason : `${reason}; from the page: not readable` })
      return
    }
    const file = `${name}.${got.ext}`
    done(src, file, assets, uploading ? await upload(capture.id, 'media', file, got.blob) : undefined)
  }

  // A few at a time: quick, without starting forty video downloads at once.
  const queue = Array.from(jobs.values())
  const total = queue.length
  let finished = 0
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await saveOne(next)
      onProgress?.(++finished, total)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))

  // Canvas snapshots are PNG data in the capture already: name them and upload them like the rest.
  let canvases = 0
  for (const asset of capture.assets) {
    if (asset.kind !== 'canvas' || !asset.src.startsWith('data:')) continue
    asset.file = `${unique(`canvas-${String(++canvases).padStart(2, '0')}`)}.png`
    record(`capture/${asset.file}`, uploading ? await upload(capture.id, 'media', asset.file, dataUrlBlob(asset.src)) : undefined)
  }

  // The scripts with the canvas code: public/reference/code/, for the agent to read and port.
  for (const code of capture.code ?? []) {
    if (!uploading || !code.text) continue
    code.file = `${unique(`code-${baseName(code.url).slice(0, 40)}`)}.js`
    record(`reference/code/${code.file}`, await upload(capture.id, 'code', code.file, new Blob([code.text], { type: 'text/javascript' })))
    if (!saved.uploaded.includes(`reference/code/${code.file}`)) code.file = undefined
  }
  for (const code of capture.code ?? []) code.text = undefined

  // Frames of the hover and click sweeps, canvas or section (sweep.ts): public/reference/, next to the
  // screenshot.
  const sweeps = [
    ['hover-sweep', (capture.hoverSweep ?? []).flatMap((h) => h.frames)],
    ['click-sweep', (capture.clickSweep ?? []).flatMap((c) => c.frames)],
  ] as const
  for (const [prefix, frames] of sweeps) {
    let n = 0
    for (const frame of frames) {
      if (frame.dataUrl && uploading) {
        const file = `${unique(`${prefix}-${String(++n).padStart(2, '0')}`)}.jpg`
        record(`reference/${file}`, await upload(capture.id, 'frames', file, dataUrlBlob(frame.dataUrl)))
        if (saved.uploaded.includes(`reference/${file}`)) frame.file = file
      }
      frame.dataUrl = undefined
    }
  }

  // The screenshot, so the agent can open it from public/reference/ as well as from the message.
  if (shot && uploading) record(`reference/${shot.file}`, await upload(capture.id, 'frames', shot.file, dataUrlBlob(shot.dataUrl)))
}
