import { appZip } from '@/lib/archive'
import { isCaptureId } from '@/lib/store'

type Context = { params: Promise<{ id: string }> }

// The capture as a ready Next.js app (`<name>/` with public/ and PROMPT.md), downloaded as <name>.zip.
// No token, like the single-file route: the extension starts it as a plain download, and the capture id
// is an unguessable UUID.
export async function GET(_request: Request, { params }: Context) {
  const { id } = await params
  const app = isCaptureId(id) ? await appZip(id) : null
  if (!app) return new Response('Not found', { status: 404 })
  return new Response(new Uint8Array(app.zip), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(app.zip.length),
      'Content-Disposition': `attachment; filename="${app.name}.zip"`,
    },
  })
}
