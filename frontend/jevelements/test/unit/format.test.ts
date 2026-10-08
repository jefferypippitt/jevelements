import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hex, literal, truncateText } from '../../src/probe/format'

test('literal formats an object with a function', () => {
  assert.equal(literal({ y: 40, ease: 'power3.out', f: () => 1 }), '{ y: 40, ease: "power3.out", f: /* function */ }')
})

test('literal cuts long strings at 300 characters', () => {
  assert.equal(literal('a'.repeat(400)).length, 300 + 3)
})

test('literal cuts long arrays', () => {
  assert.ok(literal(Array.from({ length: 20 }, (_, i) => i)).endsWith(', …]'))
})

test('literal cuts deep nesting', () => {
  assert.ok(literal({ a: { b: { c: { d: 1 } } } }).includes('{…}'))
})

test('literal prints NaN', () => {
  assert.equal(literal(NaN), 'NaN')
})

test('hex converts 0..1 channels', () => {
  assert.equal(hex(1, 0, 0.5), '#ff0080')
})

test('truncateText notes how much was cut', () => {
  const out = truncateText('abcdef', 3)
  assert.ok(out.startsWith('abc'))
  assert.ok(out.includes('3 more characters'))
})
