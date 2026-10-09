import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrompt } from '../../src/shared/prompt'
import type { SectionAnalysis } from '../../src/shared/types'
import { minimalCapture, richCapture } from './fixtures'

const headings = (prompt: string) => prompt.split('\n').filter((line) => /^#{1,2} /.test(line))

const choice = { value: 'other', confidence: null }
const analysis: SectionAnalysis = {
  model: 'test',
  sectionType: { value: 'hero', confidence: 0.9 },
  layout: choice,
  theme: choice,
  scope: { value: 'single-section', confidence: 0.9 },
  collapse: choice,
  repeatedGroup: null,
  complexity: 1,
  features: {},
  nameFromType: true,
  componentName: 'HeroSection',
  promptSection: '## Section analysis\n- Type: **hero**',
}

test('buildPrompt is deterministic', () => {
  assert.equal(buildPrompt(richCapture()), buildPrompt(richCapture()))
})

test('minimal capture snapshot', (t) => {
  t.assert.snapshot(buildPrompt(minimalCapture()))
})

test('rich capture snapshot', (t) => {
  t.assert.snapshot(buildPrompt(richCapture()))
})

test('minimal prompt heading order', () => {
  assert.deepEqual(headings(buildPrompt(minimalCapture())), [
    '# Task: Recreate this UI section 1:1',
    '## Source',
    '## Step 1: set up the Next.js app',
    '## Stack & output',
    '## Fonts',
    '## Structure & exact styles',
    '## Responsive behavior',
    '## Capture caveats',
    '## Acceptance checklist',
  ])
})

test('conditional sections appear only with data', () => {
  const rich = buildPrompt(richCapture())
  const minimal = buildPrompt(minimalCapture())
  for (const heading of ['## SVGs', "## Canvas source code (from the page's scripts)"]) {
    assert.ok(rich.includes(heading), heading)
    assert.ok(!minimal.includes(heading), heading)
  }
  assert.ok(rich.split('\n').some((line) => line.startsWith('## Interactions')))
  assert.ok(!minimal.split('\n').some((line) => line.startsWith('## Interactions')))
})

test('source line carries the title', () => {
  assert.ok(buildPrompt(minimalCapture()).includes('- Page: https://example.com/ (`"Example"`)'))
})

test('page text reaches the prompt', () => {
  const rich = buildPrompt(richCapture())
  for (const text of ['Get started', 'Pricing', 'GSAP', '3.12.5']) assert.ok(rich.includes(text), text)
})

test('saved files use local paths', () => {
  const rich = buildPrompt(richCapture())
  assert.ok(rich.includes('public/capture/hero.png'))
  const unsaved = buildPrompt({ ...richCapture(), saved: undefined })
  assert.ok(!unsaved.includes('/capture/hero.png'))
})

test('oversized SVG is not pasted inline', () => {
  const huge = 'x'.repeat(41_000)
  const prompt = buildPrompt(
    minimalCapture({
      assets: [{ kind: 'svg', src: `<svg>${huge}</svg>`, target: 'svg.big', width: 10, height: 10 }],
    }),
  )
  assert.ok(prompt.includes('too large to paste'))
  assert.ok(!prompt.includes(huge))
})

test('analysis section is inserted verbatim', () => {
  const prompt = buildPrompt(minimalCapture({ analysis }))
  assert.ok(prompt.includes(analysis.promptSection))
})

test('naming follows the analysis', () => {
  const prompt = buildPrompt(minimalCapture({ analysis }))
  assert.ok(prompt.includes('components/hero-section.tsx'))
  assert.ok(prompt.includes('HeroSection'))
})

test('unpackaged prompt never points at public/ files', () => {
  const prompt = buildPrompt(
    minimalCapture({
      assets: [{ kind: 'image', src: 'https://example.com/hero.png', target: 'img.hero', alt: 'Hero', width: 800, height: 400 }],
      fonts: [{ family: 'Inter', weights: ['400'], styles: ['normal'], links: [], faces: ['@font-face { font-family: Inter; src: url(https://example.com/inter.woff2) }'], files: ['https://example.com/inter.woff2'] }],
      saved: { files: {}, uploaded: [], failed: [{ src: 'https://example.com/gone.png', reason: 'HTTP 404' }] },
    }),
  )
  for (const text of ['public/capture', 'public/fonts', '/capture/', 'Never hotlink', 'nothing hotlinked', 'not in the zip', "backend wasn't running"]) {
    assert.ok(!prompt.includes(text), text)
  }
  assert.ok(prompt.includes('https://example.com/hero.png'))
  assert.ok(prompt.includes('https://example.com/inter.woff2'))
})
