// The extension calls the backend from its service worker (origin chrome-extension://<id>).
export function corsHeaders(request: Request, methods = 'POST, OPTIONS'): HeadersInit {
  const origin = request.headers.get('origin') ?? ''
  if (!origin.startsWith('chrome-extension://')) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  }
}

// Optional shared secret so a deployed backend can't be used by anyone who finds the URL.
export function authorized(request: Request): boolean {
  const token = process.env.JEV_API_TOKEN
  return !token || request.headers.get('authorization') === `Bearer ${token}`
}
