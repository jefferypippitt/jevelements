import assert from 'node:assert/strict'
import { clipOutline } from './capture'
import { choiceConfidence, describeGroup, featureBand, findSiblingGroups, pascalComponent } from './judgment'
import type { CapturedNode } from './capture'

function node(partial: Partial<CapturedNode> & Pick<CapturedNode, 'tag'>): CapturedNode {
  return {
    tag: partial.tag,
    attrs: partial.attrs ?? {},
    box: partial.box ?? { x: 0, y: 0, w: 200, h: 40 },
    styles: partial.styles ?? {},
    children: partial.children ?? [],
    id: partial.id,
    classes: partial.classes,
    text: partial.text,
  }
}

const fourteen = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`option-${index}`, index === 0 ? 0.4 : 0.6 / 13]))
const peaked = choiceConfidence(fourteen, 14)
assert.ok(peaked !== null && peaked < 0.6, `a 40% share of 14 options is not a confident name, got ${peaked}`)

const strong = choiceConfidence({ hero: 0.8, other: 0.2 }, 14)
assert.ok(strong !== null && strong >= 0.6, `an 80% share should clear the naming floor, got ${strong}`)

assert.equal(featureBand(0.8), 'act')
assert.equal(featureBand(0.5), 'review')
assert.equal(featureBand(0.2), 'omit')

assert.equal(pascalComponent('hero'), 'HeroSection')
assert.equal(pascalComponent('logo-cloud'), 'LogoCloudSection')
assert.equal(pascalComponent('faq'), 'FaqSection')

const cards = node({
  tag: 'div',
  classes: ['grid'],
  children: [0, 1, 2].map((index) =>
    node({ tag: 'article', classes: ['card'], text: index === 0 ? 'Fast builds' : undefined, box: { x: 0, y: 0, w: 280, h: 180 } }),
  ),
})
const groups = findSiblingGroups(cards)
assert.equal(groups.length, 1)
assert.equal(groups[0]?.count, 3)
assert.match(describeGroup(groups[0]!), /3 similar `article.card`/)

const mixed = node({
  tag: 'div',
  children: [node({ tag: 'h2' }), node({ tag: 'p' }), node({ tag: 'a' })],
})
assert.equal(findSiblingGroups(mixed).length, 0)

const long = `${'a'.repeat(10_000)}MIDDLE${'z'.repeat(4_000)}`
const clipped = clipOutline(long)
assert.ok(clipped.startsWith('a'.repeat(100)))
assert.ok(clipped.endsWith('z'.repeat(100)))
assert.match(clipped, /middle of outline omitted/)
assert.ok(!clipped.includes('MIDDLE'))

console.log('judgment checks passed')
