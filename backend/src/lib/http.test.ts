import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedOrigin, corsHeaders, sentJson } from './http'

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/x', { headers })
}

function withExtensionId<T>(id: string | undefined, fn: () => T): T {
  const previous = process.env.JEV_EXTENSION_ID
  if (id === undefined) delete process.env.JEV_EXTENSION_ID
  else process.env.JEV_EXTENSION_ID = id
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.JEV_EXTENSION_ID
    else process.env.JEV_EXTENSION_ID = previous
  }
}

test('allowedOrigin accepts no origin and any extension origin by default', () => {
  withExtensionId(undefined, () => {
    assert.equal(allowedOrigin(req()), true)
    assert.equal(allowedOrigin(req({ origin: 'chrome-extension://abc' })), true)
    assert.equal(allowedOrigin(req({ origin: 'https://evil.example' })), false)
    assert.equal(allowedOrigin(req({ origin: 'null' })), false)
  })
})

test('allowedOrigin pins one extension when JEV_EXTENSION_ID is set', () => {
  withExtensionId('abc', () => {
    assert.equal(allowedOrigin(req({ origin: 'chrome-extension://abc' })), true)
    assert.equal(allowedOrigin(req({ origin: 'chrome-extension://xyz' })), false)
  })
})

test('sentJson requires an application/json content type', () => {
  assert.equal(sentJson(req({ 'content-type': 'application/json' })), true)
  assert.equal(sentJson(req({ 'content-type': 'application/json; charset=utf-8' })), true)
  assert.equal(sentJson(req({ 'content-type': 'text/plain' })), false)
  assert.equal(sentJson(req()), false)
  assert.equal(sentJson(req({ 'content-type': 'application/jsonp' })), false)
})

test('corsHeaders only answers extension origins', () => {
  withExtensionId(undefined, () => {
    assert.deepEqual(corsHeaders(req({ origin: 'https://evil.example' })), {})
    const headers = corsHeaders(req({ origin: 'chrome-extension://abc' })) as Record<string, string>
    assert.equal(headers['Access-Control-Allow-Origin'], 'chrome-extension://abc')
  })
})
