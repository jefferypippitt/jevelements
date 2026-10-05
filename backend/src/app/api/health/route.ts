import { connection } from 'next/server'

// Dev-only check that the provider keys are configured. Hidden in production.
export async function GET() {
  await connection() // read env at request time, not build time
  if (process.env.NODE_ENV !== 'development') {
    return new Response(null, { status: 404 })
  }
  return Response.json({
    typesafe: !!process.env.TYPESAFE_API_KEY,
    gateway: !!process.env.AI_GATEWAY_API_KEY,
  })
}
