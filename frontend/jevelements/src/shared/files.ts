// File helpers shared by the service worker (downloads media), the content script (page-context
// fallback, uploads) and the prompt (file names, inline data: files).

export const MAX_FILE_BYTES = 250 * 1024 * 1024

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff2': 'woff2',
  'application/font-woff': 'woff',
  'application/x-font-woff': 'woff',
  'application/x-font-ttf': 'ttf',
  'application/x-font-otf': 'otf',
}
// Files a canvas or WebGL scene loads: 3D models, Lottie/Rive animations, HDR environments,
// compressed textures, shaders. Servers often send these as octet-stream, so the URL names the type.
const SCENE_EXTENSIONS: Record<string, string> = {
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
  'application/json': 'json',
}
const KNOWN_EXT = /\.(png|jpe?g|webp|avif|gif|svg|ico|mp4|webm|mov|m4v|ogv|json|lottie|riv|glb|gltf|bin|drc|splinecode|hdr|exr|ktx2|basis|usdz|fbx|obj|glsl|frag|vert|wgsl|woff2?|ttf|otf)$/i

// The content type decides the extension: image CDNs and next/image serve WebP or AVIF from URLs
// that end in .png, or have no extension at all. Scene files go by the URL first: a .gltf is JSON.
export function extensionFor(type: string, src: string): string | null {
  const mime = type.split(';')[0].trim().toLowerCase()
  if (EXTENSIONS[mime]) return EXTENSIONS[mime]
  if (src.startsWith('data:') || src.startsWith('blob:')) return SCENE_EXTENSIONS[mime] ?? null
  try {
    const url = new URL(src)
    const inner = url.searchParams.get('url') // /_next/image?url=/hero.png
    const ext = (KNOWN_EXT.exec(url.pathname) ?? KNOWN_EXT.exec(inner ?? ''))?.[1].toLowerCase()
    return ext === 'jpeg' ? 'jpg' : (ext ?? SCENE_EXTENSIONS[mime] ?? null)
  } catch {
    return null
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
