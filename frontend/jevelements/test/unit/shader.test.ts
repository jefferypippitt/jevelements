import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isWgsl } from '../../src/shared/shader'

test('isWgsl recognises a WGSL fragment shader', () => {
  assert.equal(isWgsl('@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }'), true)
})

test('isWgsl rejects GLSL', () => {
  assert.equal(isWgsl('void main() { gl_FragColor = vec4(1.0); }'), false)
})
