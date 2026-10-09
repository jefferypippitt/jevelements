import assert from 'node:assert/strict'
import { test } from 'node:test'
import { componentNames, kitBase, readableName } from '../../src/shared/kit'
import type { SectionAnalysis } from '../../src/shared/types'
import { minimalCapture } from './fixtures'

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

const analysis = (fields: Partial<SectionAnalysis>): SectionAnalysis => ({
  model: 'jev-test',
  sectionType: { value: 'feature-grid', confidence: 0.3 },
  layout: { value: 'card-grid', confidence: 0.9 },
  theme: { value: 'light', confidence: 0.9 },
  scope: { value: 'single-section', confidence: 0.9 },
  collapse: { value: 'stack', confidence: 0.9 },
  repeatedGroup: null,
  complexity: 1,
  features: {},
  nameFromType: false,
  componentName: null,
  promptSection: '',
  ...fields,
})

test('kitBase names the kit after the family when only the family is sure', () => {
  const capture = minimalCapture({ analysis: analysis({ nameFromType: true, name: 'features', componentName: 'FeaturesSection' }) })
  assert.equal(kitBase(capture), 'features-section')
})

test('kitBase names the kit after a sure type', () => {
  const capture = minimalCapture({ analysis: analysis({ sectionType: { value: 'how-it-works', confidence: 0.9 }, nameFromType: true, name: 'how-it-works' }) })
  assert.equal(kitBase(capture), 'how-it-works-section')
})

test('kitBase still reads the type from an older backend without name', () => {
  const capture = minimalCapture({ analysis: analysis({ sectionType: { value: 'hero', confidence: 0.9 }, nameFromType: true }) })
  assert.equal(kitBase(capture), 'hero-section')
})
