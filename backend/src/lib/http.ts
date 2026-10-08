// The extension calls the backend from its service worker (origin chrome-extension://<id>).
export function corsHeaders(request: Request, methods = 'POST, OPTIONS'): HeadersInit {
  const origin = request.headers.get('origin') ?? ''
  if (!extensionOrigin(origin)) return {}
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

// Browsers attach Origin to cross-site requests, so a web page can't pass for the extension.
// Requests without Origin (curl, scripts) still go through authorized().
export function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  return origin === null || extensionOrigin(origin)
}

// Any extension by default; JEV_EXTENSION_ID pins it to one install.
function extensionOrigin(origin: string): boolean {
  const id = process.env.JEV_EXTENSION_ID?.trim()
  return id ? origin === `chrome-extension://${id}` : origin.startsWith('chrome-extension://')
}

// A JSON body must say so: a text/plain POST is the one kind a web page can send cross-site without a preflight.
export function sentJson(request: Request): boolean {
  return /^application\/json\b/i.test(request.headers.get('content-type') ?? '')
}
