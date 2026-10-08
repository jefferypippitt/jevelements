import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emulateColorScheme, mentionsColorScheme } from '../../src/shared/runtime'

test('emulateColorScheme rewrites the query to always or never match', () => {
  assert.equal(emulateColorScheme('(prefers-color-scheme: dark)', 'dark'), '(width >= 0px)')
  assert.equal(emulateColorScheme('(prefers-color-scheme: dark)', 'light'), '(width < 0px)')
})

test('mentionsColorScheme is stable across repeated calls', () => {
  // The regex is shared and global, so a stale lastIndex would flip the answer on a later call.
  for (let i = 0; i < 3; i++) assert.equal(mentionsColorScheme('(prefers-color-scheme: dark)'), true)
})

test('mentionsColorScheme ignores unrelated queries', () => {
  assert.equal(mentionsColorScheme('(min-width: 600px)'), false)
})
