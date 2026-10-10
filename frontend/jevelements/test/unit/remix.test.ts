import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrompt } from '../../src/shared/prompt'
import { designDna } from '../../src/shared/remix'
import { FAMILY_PLAYBOOKS, MOVES, remixPlan, sectionShape, TYPE_PLAYBOOKS } from '../../src/shared/remix-moves'
import type { SectionAnalysis, SectionPart } from '../../src/shared/types'
import { minimalCapture, node } from './fixtures'

// Like the Cursor changelog: a heading, four flat cards (date + title), one orange link, no section fill.
function changelog() {
  const card = (date: string, title: string) =>
    node({
      tag: 'a',
      classes: ['card'],
      attrs: { href: '/changelog/x' },
      styles: { 'background-color': '#f2f1ed', 'border-radius': '4px', padding: '16px' },
      children: [node({ tag: 'span', text: date, styles: { color: '#8a8984' } }), node({ tag: 'p', text: title })],
    })
  return minimalCapture({
    url: 'https://cursor.com/',
    root: node({
      tag: 'section',
      classes: ['changelog'],
      box: { x: 0, y: 0, w: 1440, h: 320 },
      styles: { color: '#26251e', 'font-family': '"CursorGothic", sans-serif', 'font-size': '16px', 'padding-top': '48px', 'padding-left': '50px' },
      children: [
        node({ tag: 'h2', text: 'Changelog', styles: { 'font-size': '22px' } }),
        node({ tag: 'div', classes: ['grid'], styles: { display: 'grid', gap: '10px' }, children: [card('Oct 6', 'Remote control'), card('Sep 23', 'Rollouts'), card('Sep 10', 'Projects'), card('Sep 2', 'Machines')] }),
        node({ tag: 'a', classes: ['more'], attrs: { href: '/changelog' }, text: "See what's new", styles: { color: '#f54e00' } }),
      ],
    }),
    parts: [
      { name: 'h2', kind: 'heading', box: { x: 50, y: 48, w: 200, h: 30 }, text: 'Changelog' },
      { name: 'div.grid', kind: 'list', box: { x: 50, y: 100, w: 1340, h: 120 }, parts: [{ name: 'a.card', kind: 'group', box: { x: 50, y: 100, w: 330, h: 120 }, repeats: 4, items: ['Oct 6 Remote control', 'Sep 23 Rollouts', 'Sep 10 Projects', 'Sep 2 Machines'] }] },
    ],
  })
}

const testimonial = (repeats: number, items: string[], media: boolean): SectionPart[] => [
  { name: 'h2', kind: 'heading', box: { x: 0, y: 0, w: 600, h: 40 } },
  { name: 'figure.quote', kind: 'group', box: { x: 0, y: 80, w: 400, h: 240 }, repeats, items, parts: media ? [{ name: 'img', kind: 'media', box: { x: 0, y: 0, w: 40, h: 40 } }] : [] },
]

test('designDna reads colors by role', () => {
  const dna = designDna(changelog())
  const colors = dna.lines[0]
  assert.match(colors, /\| background \| the page behind the section/)
  assert.match(colors, /\| surface \| `#f2f1ed` \| 4 elements/)
  assert.match(colors, /\| text \| `#26251e` \| 5 elements with text/)
  assert.match(colors, /\| muted text \| `#8a8984` \| 4 elements with text/)
  assert.match(colors, /\| accent text \| `#f54e00` \| 1 element with text/)
  assert.equal(dna.padding, '48px 0px 0px 50px')
})

test('designDna lists type, shape and the element inventory', () => {
  const text = designDna(changelog()).lines.join('\n')
  assert.match(text, /\*\*CursorGothic\*\*/)
  assert.match(text, /- 22px \/ 400: 1 element/)
  assert.match(text, /Radii: 4px \(4 elements\)/)
  assert.match(text, /Shadows: none \(flat\)/)
  assert.match(text, /1 heading, 10 text blocks, 5 links/)
  assert.match(text, /Badges, pills or tags: none; icons: none/)
})

test('sectionShape reads the repeated items and the header', () => {
  assert.deepEqual(sectionShape(changelog()), { items: 4, item: 'a.card', columns: 4, media: false, uneven: false, header: true })
  const quotes = sectionShape(minimalCapture({ parts: testimonial(6, ['Short.', 'A much longer quote that runs on.', 'Mid length one'], true) }))
  assert.equal(quotes.items, 6)
  assert.equal(quotes.media, true)
  assert.equal(quotes.uneven, true)
})

// The analysis as the backend sends it when it is sure of the type (nameFromType).
const sure = (type: string): SectionAnalysis => ({
  model: 'test',
  sectionType: { value: type, confidence: 0.9 },
  layout: { value: 'other', confidence: null },
  theme: { value: 'light', confidence: null },
  scope: { value: 'single-section', confidence: 0.9 },
  collapse: { value: 'other', confidence: null },
  repeatedGroup: null,
  complexity: 1,
  features: {},
  nameFromType: true,
  name: type,
  componentName: null,
  promptSection: `## Section analysis\n- Type: **${type}**`,
})
const quotes = testimonial(6, ['Short.', 'A much longer quote that runs on.'], true)
const heroParts: SectionPart[] = [
  { name: 'h1', kind: 'heading', box: { x: 0, y: 0, w: 600, h: 60 } },
  { name: 'a.button', kind: 'control', box: { x: 0, y: 80, w: 140, h: 44 }, repeats: 2, items: ['Start', 'Demo'] },
  { name: 'img', kind: 'media', box: { x: 700, y: 0, w: 600, h: 400 } },
]
const offered = (type: string, parts: SectionPart[]) => remixPlan(minimalCapture({ analysis: sure(type), parts })).offered.map((m) => m.id)

test('every playbook names real moves and a real family', () => {
  const known = new Set(MOVES.map((m) => m.id))
  for (const [name, p] of Object.entries({ ...FAMILY_PLAYBOOKS, ...TYPE_PLAYBOOKS })) {
    for (const id of [...(p.moves ?? []), ...(p.never ?? [])]) assert.ok(known.has(id), `${name}: ${id}`)
    for (const id of p.moves ?? []) assert.ok(!(p.never ?? []).includes(id), `${name} both offers and bans ${id}`)
  }
  for (const [type, p] of Object.entries(TYPE_PLAYBOOKS)) assert.ok(FAMILY_PLAYBOOKS[p.family], `${type}: ${p.family}`)
})

test('a hero never gets a marquee, a testimonials grid can', () => {
  const hero = offered('hero', heroParts)
  assert.deepEqual(hero, ['asymmetric', 'split', 'reverse', 'media-stage'])
  const heroPrompt = buildPrompt(minimalCapture({ analysis: sure('hero'), parts: heroParts }), 'remix')
  assert.ok(heroPrompt.includes('A **hero** section, from the capture\'s analysis. A reader comes here to grasp the promise'))
  assert.ok(heroPrompt.includes('**Never for a hero section:** `marquee`'))
  assert.ok(!heroPrompt.includes('- **`marquee`: Marquee**'))
  assert.ok(heroPrompt.includes('- [ ] The headline is read first and stays the largest text.'))

  const grid = offered('testimonials', quotes)
  for (const id of ['side-header', 'bento', 'marquee', 'masonry', 'carousel']) assert.ok(grid.includes(id), id)
  assert.ok(!grid.includes('split'))
  assert.ok(buildPrompt(minimalCapture({ analysis: sure('testimonials'), parts: quotes }), 'remix').includes('A **testimonials** section (social proof)'))
})

test('pricing keeps its tiers side by side; a family-only reading uses the family playbook', () => {
  const plan = remixPlan(minimalCapture({ analysis: sure('pricing'), parts: quotes }))
  assert.deepEqual(plan.offered.map((m) => m.id), ['header-row', 'side-header', 'rows'])
  assert.ok(plan.never.some((m) => m.id === 'carousel'))
  const family = remixPlan(minimalCapture({ analysis: { ...sure('feature-grid'), name: 'features' }, parts: quotes }))
  assert.equal(family.section, 'features')
  assert.ok(!family.offered.some((m) => m.id === 'marquee'))
})

test('an unsure section is classified first, from the playbook table', () => {
  const plan = remixPlan(minimalCapture({ analysis: { ...sure('hero'), nameFromType: false }, parts: heroParts }))
  assert.equal(plan.sure, false)
  assert.equal(plan.guess, 'hero')
  const prompt = buildPrompt(minimalCapture({ parts: quotes }), 'remix')
  assert.ok(prompt.includes("The capture wasn't classified. Before anything else, decide what this section is"))
  assert.ok(prompt.includes('### Section playbooks'))
  for (const type of Object.keys(TYPE_PLAYBOOKS)) assert.ok(prompt.includes(`- **${type}** (`), type)
  assert.ok(prompt.includes('- [ ] The summary names the kind of section you decided on'))
})

test('a sure section without a playbook chooses by shape', () => {
  const plan = remixPlan(minimalCapture({ analysis: sure('card'), parts: quotes }))
  assert.equal(plan.playbook, null)
  assert.ok(plan.fit.some((m) => m.id === 'bento'))
  assert.ok(!plan.offered.some((m) => m.only))
})

test('the remix keeps the foundations and only moves the layout', () => {
  const remix = buildPrompt(changelog(), 'remix')
  assert.ok(remix.includes('# Task: Remix this UI section\'s layout'))
  assert.ok(remix.includes('- **Move:** auto'))
  assert.ok(remix.includes("Keep the section's text content exactly as written"))
  assert.ok(remix.includes('Never round to the nearest step'))
  assert.ok(remix.includes('### Layout moves'))
  for (const move of MOVES) assert.ok(remix.includes(`- **\`${move.id}\`: ${move.name}**`), move.id) // unclassified: every move
  assert.ok(remix.includes('| accent text | `#f54e00` | 1 element with text, first `a.more` |\n\n**Type**'))
  assert.ok(remix.includes('grep -rnE "badge|pill|chip|uppercase|gradient|blur|backdrop|shadow-" components'))
  for (const gone of ['public/remix', 'token sheet', 'Strength', 'fictional', 'Never load the files']) assert.ok(!remix.includes(gone), gone)
})

test('each remix round gets its own folder and a log entry', () => {
  const remix = buildPrompt(changelog(), 'remix')
  assert.ok(remix.includes('### Another round'))
  assert.ok(remix.includes('`components/remix-<n>/changelog-section.tsx`, exporting `ChangelogSectionRemix<n>`'))
  assert.ok(remix.includes('`remix-log.md`'))
  assert.ok(remix.includes("choose from this section's moves that no earlier round used"))
  assert.ok(remix.includes("never a previous round's files"))
})
