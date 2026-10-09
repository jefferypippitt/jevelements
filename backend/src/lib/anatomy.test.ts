import assert from 'node:assert/strict'
import { test } from 'node:test'
import { familyOf, rollUpFamily, SECTION_TYPE_CRITERIA, SECTION_TYPES, topTypes } from './anatomy'
import { finish, type Judgment } from './analyze'
import { contentOf, placementOf, type Capture, type CapturedNode } from './capture'

const node = (tag: string, text?: string, children: CapturedNode[] = [], attrs: Record<string, string> = {}): CapturedNode => ({
  tag,
  text,
  attrs,
  box: { x: 0, y: 0, w: 100, h: 20 },
  styles: {},
  children,
})

const judgment = (sectionType: Judgment['sectionType'], scope = 'single-section'): Judgment => ({
  model: 'jev-test',
  sectionType,
  layout: { value: 'card-grid', confidence: 0.9 },
  theme: { value: 'light', confidence: 0.9 },
  scope: { value: scope, confidence: 0.9 },
  collapse: { value: 'stack', confidence: 0.9 },
  repeatedGroup: null,
  complexity: 1,
  features: { hasCarousel: 0, hasTabs: 0, hasAccordion: 0, hasForm: 0, hasDropdown: 0, hasMobileMenu: 0, isSticky: 0, hasBackgroundMedia: 0, hasAnimation: 0 },
})

test('every section type has a family and criteria the model sees without it', () => {
  for (const [type, spec] of Object.entries(SECTION_TYPES)) {
    assert.equal(familyOf(type), spec.family)
    assert.ok(!('family' in SECTION_TYPE_CRITERIA[type as keyof typeof SECTION_TYPE_CRITERIA]))
  }
  assert.equal(familyOf('not-a-type'), 'other')
})

test('rollUpFamily sums a vote split between feature patterns', () => {
  const family = rollUpFamily({ 'feature-grid': 0.4, 'feature-rows': 0.3, 'bento-grid': 0.15, hero: 0.1, other: 0.05 })
  assert.equal(family?.value, 'features')
  assert.ok(Math.abs((family?.probability ?? 0) - 0.85) < 1e-9)
  assert.ok((family?.confidence ?? 0) > 0.8)
  assert.equal(rollUpFamily(undefined), null)
})

test('topTypes lists the likeliest types inside one family', () => {
  const probabilities = { 'feature-grid': 0.4, 'feature-rows': 0.3, 'how-it-works': 0.02, hero: 0.28 }
  assert.deepEqual(topTypes(probabilities, 'features').map((alt) => alt.type), ['feature-grid', 'feature-rows'])
})

test('finish names a sure type after the type', () => {
  const analysis = finish(judgment({ value: 'pricing', confidence: 0.95, probabilities: { pricing: 0.97, cta: 0.03 } }), [])
  assert.equal(analysis.name, 'pricing')
  assert.equal(analysis.componentName, 'PricingSection')
  assert.match(analysis.promptSection, /Type: \*\*pricing\*\* \(a conversion section\)/)
})

test('finish falls back to the family when the vote split inside it', () => {
  const analysis = finish(
    judgment({ value: 'feature-grid', confidence: 0.35, probabilities: { 'feature-grid': 0.45, 'feature-rows': 0.3, 'bento-grid': 0.15, hero: 0.1 } }),
    [],
  )
  assert.equal(analysis.name, 'features')
  assert.equal(analysis.componentName, 'FeaturesSection')
  assert.equal(analysis.nameFromType, true)
  assert.match(analysis.promptSection, /a \*\*features\*\* section .*Closest patterns: feature-grid 45%, feature-rows 30%, bento-grid 15%/)
})

test('finish does not name a capture split between families', () => {
  const analysis = finish(judgment({ value: 'hero', confidence: 0.2, probabilities: { hero: 0.4, 'feature-showcase': 0.35, cta: 0.25 } }), [])
  assert.equal(analysis.name, null)
  assert.equal(analysis.componentName, null)
})

test('finish does not name a multi-section capture', () => {
  const analysis = finish(judgment({ value: 'hero', confidence: 0.9, probabilities: { hero: 1 } }, 'multi-section'), [])
  assert.equal(analysis.name, null)
})

test('contentOf lists heading levels, actions and cues', () => {
  const root = node('section', undefined, [
    node('h2', 'Simple pricing'),
    node('div', undefined, [node('h3', 'Pro'), node('span', '$29/mo'), node('a', undefined, [node('span', 'Start trial')], { href: '/x' })]),
    node('div', undefined, [node('h3', 'Team'), node('span', '$99/mo')]),
    node('p', '© 2026 Acme'),
    node('input', undefined, [], { type: 'email', placeholder: 'you@company.com' }),
  ])
  const content = contentOf(root)
  assert.match(content, /Headings: h2 "Simple pricing", h3 "Pro", h3 "Team"/)
  assert.match(content, /Buttons and links: "Start trial"/)
  assert.match(content, /Form fields: email "you@company.com"/)
  assert.match(content, /2 price-like texts/)
  assert.match(content, /1 copyright notices/)
})

test('placementOf says how far down the page the section starts', () => {
  const capture = {
    url: 'https://example.com',
    title: 'Example',
    selector: 'section',
    viewport: { w: 1440, h: 900, dpr: 1 },
    root: { ...node('section'), box: { x: 0, y: 2700, w: 1440, h: 800 } },
    assets: [],
    responsive: [],
    keyframes: [],
  } satisfies Capture
  assert.match(placementOf(capture), /Starts 2,700px from the top of the page\. It starts 3\.0 screens down\./)
  const placed = placementOf({ ...capture, placement: { pageHeight: 9000, before: ['h1 "Ship faster"'], after: [] } })
  assert.match(placed, /Spans 2,700px to 3,500px of a 9,000px page \(30% to 39% down\)/)
  assert.match(placed, /Directly above it: "h1 \\"Ship faster\\"".*Directly below it: nothing\./)
})
