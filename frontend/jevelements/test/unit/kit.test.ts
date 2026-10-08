import assert from 'node:assert/strict'
import { test } from 'node:test'
import { componentNames, readableName } from '../../src/shared/kit'

test('readableName skips utility classes', () => {
  assert.equal(readableName(['flex', 'pricing']), 'pricing')
  assert.equal(readableName(['css-1x2y', 'w-full']), null)
})

test('readableName strips a trailing Section', () => {
  assert.equal(readableName(['featureGridSection']), 'feature-grid')
})

test('componentNames maps a kit name to file and component', () => {
  assert.deepEqual(componentNames('hero-section'), { file: 'hero-section', component: 'HeroSection' })
})

test('componentNames prefixes Section when the name starts with a digit', () => {
  assert.equal(componentNames('3d-section').component, 'Section3dSection')
})
