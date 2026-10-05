import { analyzeCapture } from '@/lib/analyze'
import { isCapture } from '@/lib/capture'
import { authorized, corsHeaders } from '@/lib/http'

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: Request) {
  const headers = corsHeaders(request)

  if (!authorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400, headers })
  }
  const capture = (body as { capture?: unknown })?.capture
  if (!isCapture(capture)) {
    return Response.json({ error: 'Expected { capture } from the JevElements extension' }, { status: 400, headers })
  }

  try {
    const analysis = await analyzeCapture(capture, { abortSignal: request.signal })
    return Response.json({ analysis }, { headers })
  } catch (err) {
    console.error('[analyze] jev evaluation failed', err)
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `Analysis failed: ${message}` }, { status: 502, headers })
  }
}
