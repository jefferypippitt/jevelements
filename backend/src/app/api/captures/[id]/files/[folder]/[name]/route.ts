import { allowedOrigin, authorized, corsHeaders } from '@/lib/http'
import { NOT_STORED, storesLocally } from '@/lib/local'
import { filePath, MAX_FILE_BYTES, readCaptureFile, saveFile } from '@/lib/store'

type Context = { params: Promise<{ id: string; folder: string; name: string }> }

const METHODS = 'GET, PUT, OPTIONS'

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  json: 'application/json',
  js: 'text/javascript; charset=utf-8',
  glb: 'model/gltf-binary',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  gltf: 'model/gltf+json',
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request, METHODS) })
}

// The extension uploads one file per request, as the raw body; `?offset=N` appends a later chunk.
export async function PUT(request: Request, { params }: Context) {
  const headers = corsHeaders(request, METHODS)
  if (!storesLocally()) return Response.json({ error: NOT_STORED }, { status: 404, headers })
  if (!allowedOrigin(request)) return Response.json({ error: 'Forbidden origin' }, { status: 403, headers })
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })

  const { id, folder, name } = await params
  const file = filePath(id, [folder, name])
  if (!file) return Response.json({ error: 'Bad capture id or file name' }, { status: 400, headers })

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_FILE_BYTES) return Response.json({ error: 'File too large' }, { status: 413, headers })
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (!bytes.length) return Response.json({ error: 'Empty file' }, { status: 400, headers })
  if (bytes.length > MAX_FILE_BYTES) return Response.json({ error: 'File too large' }, { status: 413, headers })

  const offset = Number(new URL(request.url).searchParams.get('offset') ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0) return Response.json({ error: 'Bad offset' }, { status: 400, headers })
  if (!(await saveFile(file, bytes, offset))) return Response.json({ error: 'Chunk out of order' }, { status: 409, headers })
  return Response.json({ saved: `${folder}/${name}`, bytes: bytes.length }, { headers })
}

// No token: opened as plain links, and the capture id is an unguessable UUID.
export async function GET(_request: Request, { params }: Context) {
  if (!storesLocally()) return new Response('Not found', { status: 404 })
  const { id, folder, name } = await params
  const file = filePath(id, [folder, name])
  const body = file && (await readCaptureFile(file))
  if (!body) return new Response('Not found', { status: 404 })
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': String(body.length),
      'X-Content-Type-Options': 'nosniff',
      // Files come from arbitrary sites; an SVG opened here must not run script on the backend's origin.
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'; media-src 'self'; sandbox",
    },
  })
}
