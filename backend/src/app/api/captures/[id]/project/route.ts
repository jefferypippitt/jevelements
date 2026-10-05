import { authorized, corsHeaders } from '@/lib/http'
import { isCaptureId, isProjectMeta, MAX_PROMPT_CHARS, saveProject } from '@/lib/store'

type Context = { params: Promise<{ id: string }> }

const METHODS = 'PUT, OPTIONS'

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request, METHODS) })
}

// The extension names the app (hero-section → components/hero-section.tsx exporting HeroSection) and
// sends the prompt once the capture is classified; the zip route builds the app from it.
export async function PUT(request: Request, { params }: Context) {
  const headers = corsHeaders(request, METHODS)
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })

  const { id } = await params
  if (!isCaptureId(id)) return Response.json({ error: 'Bad capture id' }, { status: 400, headers })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400, headers })
  }
  if (!isProjectMeta(body)) {
    return Response.json(
      { error: `Expected { name, component, file, prompt }: kebab-case name and file, PascalCase component, prompt up to ${MAX_PROMPT_CHARS} characters` },
      { status: 400, headers },
    )
  }

  const { name, component, file, prompt } = body
  await saveProject(id, { name, component, file, prompt })
  return Response.json({ name, zip: new URL(`/api/captures/${id}/zip`, request.url).href }, { headers })
}
