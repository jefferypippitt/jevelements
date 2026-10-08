import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extensionFor, fromBase64, toBase64 } from '../../src/shared/files'

test('extensionFor: the MIME type wins over the URL', () => {
  assert.equal(extensionFor('image/jpeg', 'https://x/a.png'), 'jpg')
})

test('extensionFor: falls back to the URL extension', () => {
  assert.equal(extensionFor('application/octet-stream', 'https://x/m.glb'), 'glb')
  assert.equal(extensionFor('application/octet-stream', 'https://x/a.jpeg'), 'jpg')
})

test('extensionFor: reads the inner url of a Next image URL', () => {
  assert.equal(extensionFor('', 'https://x/_next/image?url=%2Fhero.webp&w=640'), 'webp')
})

test('extensionFor: data URLs use the scene type table', () => {
  assert.equal(extensionFor('application/json', 'data:application/json,{}'), 'json')
})

test('extensionFor: unknown types and bad URLs give null', () => {
  assert.equal(extensionFor('text/plain', 'https://x/readme'), null)
  assert.equal(extensionFor('', 'not a url'), null)
})

test('base64 round-trips more than one chunk', () => {
  const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251)
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes)
})
