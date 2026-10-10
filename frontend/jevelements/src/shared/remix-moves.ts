// The remix's vocabulary: layout moves (MOVES), and which of them suit each kind of section
// (PLAYBOOKS). A remix first settles what section it is (the capture's analysis, or the agent's own
// reading when that is unsure), then picks only from that section's moves: a hero never becomes a
// marquee, a pricing table never hides tiers in a carousel. A new section type is one PLAYBOOKS entry;
// a new move is one MOVES entry, offered wherever a playbook lists it.
import type { Capture, SectionPart } from './types'

// ---------- Layout moves ----------

// 'header' moves rearrange the heading block, 'items' moves rearrange the repeated items, and
// 'section' moves recompose a section around one block (heroes, CTAs, bars). A remix uses at most one
// header move and one items or section move. fits() reads the section's shape, to narrow a playbook's
// moves to the ones its content can carry.
export interface Move {
  id: string
  kind: 'header' | 'items' | 'section'
  name: string
  does: string // what changes
  build: string // how to build it, including the small screen
  fits: (shape: Shape) => boolean
  when: string // fits(), in words
  only?: boolean // offered only where a playbook lists it, never on shape alone
}

export interface Shape {
  items: number // the most repeated part's count (0 when nothing repeats)
  item: string | null // its name, like the tree's element lines
  columns: number // about how many items sit in a row
  media: boolean // each item shows an image or video
  uneven: boolean // the items' text lengths differ a lot
  header: boolean // a heading block above or beside the items
}

export const MOVES: Move[] = [
  {
    id: 'side-header',
    kind: 'header',
    name: 'Header beside',
    does: 'The heading block (title, intro, link) leaves the top and becomes a left column, left-aligned, about a third of the width; the items fill the column to its right.',
    build: 'A two-column grid. When the items are taller than the viewport, make the header column `position: sticky` so it stays in view while they scroll past. Below `md` it stacks back on top, left-aligned.',
    fits: (s) => s.header && s.items >= 2,
    when: 'a heading block and repeated items',
  },
  {
    id: 'header-row',
    kind: 'header',
    name: 'Header row',
    does: 'The heading block splits into one row: the title left-aligned on the left, the intro and link pushed to the right edge, aligned to the title\'s baseline or bottom. The items stay below.',
    build: 'Flex with `justify-between` and `items-end`, the intro capped at about 40ch. Below `md` it stacks, left-aligned.',
    fits: (s) => s.header,
    when: 'a heading block',
  },
  {
    id: 'header-center',
    kind: 'header',
    name: 'Header centered',
    does: 'A heading block that sits left-aligned, beside the items or split across a row, moves to the top and centers: title, intro and link stacked and center-aligned, the intro capped at about 60ch. The items stay below.',
    build: 'One column above the items, `text-align: center` and `margin-inline: auto` on the heading block, with the original gap to the items. The link, if any, centers under the intro. It stays centered on small screens.',
    fits: (s) => s.header && s.items >= 2,
    when: 'a heading block that isn\'t centered, and repeated items',
  },
  {
    id: 'header-split',
    kind: 'header',
    name: 'Header bookends',
    does: 'The heading block splits around the items: the title stays on top, left-aligned on its own row, and the intro and link move below the items as the closing line, so the section opens with its title and closes with the invitation to read on.',
    build: 'The title before the items, the intro and link after them, each keeping its styles and the original gap to the items. Move them in the markup, not with `order`, so the reading order matches the screen. The same on small screens.',
    fits: (s) => s.header && s.items >= 2,
    when: 'a heading block with an intro or link, above repeated items',
  },
  {
    id: 'bento',
    kind: 'items',
    name: 'Bento grid',
    does: 'The items move from an even grid into an asymmetric bento: one or two cells span two columns or rows (the first item, or the one with the most content or the largest image), the rest fill around them in order, with no holes.',
    build: 'CSS grid with 4 or 6 columns and `grid-auto-flow: dense` only if the order still reads the same. A larger cell keeps the item\'s styling: its media grows to fill the extra space with `object-cover` at the same crop, its text keeps its size. Use the original gap. Below `md`, 2 columns with the featured cell full width; below `sm`, 1 column.',
    fits: (s) => s.items >= 3,
    when: '3 or more items',
  },
  {
    id: 'marquee',
    kind: 'items',
    name: 'Marquee',
    does: 'The items leave the grid and run in one row that scrolls sideways forever. With 8 or more items, two rows moving in opposite directions.',
    build: 'Render the list twice in one flex track (the copy `aria-hidden` with `tabIndex={-1}` on its links), animate the track from `translateX(0)` to `translateX(-50%)` with linear timing and `infinite`, at a calm speed (about 40px per second), so the loop has no visible jump. Each item keeps its original width. Pause on hover and on focus within. Fade both edges with `mask-image` (a transparent-to-black mask, no new color). With `prefers-reduced-motion`, no animation: a single row with native horizontal scroll and snap. The same marquee on small screens.',
    fits: (s) => s.items >= 4,
    when: '4 or more items',
  },
  {
    id: 'carousel',
    kind: 'items',
    name: 'Snap carousel',
    does: 'The items sit in one row that the reader swipes or steps through, with the next item peeking in at the edge.',
    build: 'A horizontal `overflow-x: auto` track with `scroll-snap-type: x mandatory`, items at their original width. Add previous/next buttons and a position indicator (dots or "2 / 6"), styled only from the section tokens below, with `lucide-react` chevrons in the text color and `aria-label`s; arrow keys step too. Disable a button at either end. Hide the scrollbar.',
    fits: (s) => s.items >= 3,
    when: '3 or more items',
  },
  {
    id: 'pinned-scroll',
    kind: 'items',
    name: 'Pinned horizontal scroll',
    does: 'The section pins while the reader scrolls down, and the items slide past sideways in one row until the last one is in view.',
    build: 'GSAP ScrollTrigger (`pin: true`, `scrub: true`, the track translated by its overflow width). The pin lasts as long as the track\'s overflow. With `prefers-reduced-motion` and below `md`, no pin: a native horizontal scroll with snap.',
    fits: (s) => s.items >= 4,
    when: '4 or more items',
  },
  {
    id: 'masonry',
    kind: 'items',
    name: 'Masonry',
    does: 'The items keep their width but take their natural height and pack into columns, so items with more text stand taller.',
    build: '`columns: 3` with `break-inside: avoid` and the original gap as `column-gap` and margin between items. CSS columns read top to bottom, so check the first row still starts with the first items. 2 columns below `lg`, 1 below `sm`.',
    fits: (s) => s.items >= 5 && s.uneven,
    when: '5 or more items whose text length differs',
  },
  {
    id: 'spotlight',
    kind: 'items',
    name: 'Spotlight',
    does: 'The first item becomes the feature, about half the width and the full height of the block; the other items line up beside it as a compact grid or list.',
    build: 'A two-column grid: the feature on the left, the rest in a nested grid on the right. The feature keeps its styling, with its media larger at the same crop; the others keep theirs at their original size. Below `md` the feature goes on top.',
    fits: (s) => s.items >= 3,
    when: '3 or more items',
  },
  {
    id: 'offset-columns',
    kind: 'items',
    name: 'Offset columns',
    does: 'The same grid, but every other column sits lower (about half an item), so the grid reads as a staggered wall instead of rows.',
    build: 'Split the items into columns in order (item 1 in column 1, item 2 in column 2, …), and give the even columns a top margin. Optionally, a gentle scroll parallax between columns (under 80px of travel, off with `prefers-reduced-motion`). One column below `md`, without the offset.',
    fits: (s) => s.items >= 3 && s.columns >= 2,
    when: '3 or more items in 2 or more columns',
  },
  {
    id: 'sticky-stack',
    kind: 'items',
    name: 'Stacking cards',
    does: 'The items line up in one column, and as the reader scrolls each one sticks and the next slides over it, so they pile up like a deck.',
    build: 'Each item is `position: sticky` with a top offset that grows by about 16–24px per item, so the edges of the earlier ones stay visible. Optionally, covered items scale down slightly (to 0.95) as the next arrives. Items need a solid surface: if the original items are flat, give each the section\'s background color. No scaling with `prefers-reduced-motion`.',
    fits: (s) => s.items >= 3 && s.items <= 6,
    when: '3 to 6 items',
  },
  {
    id: 'rows',
    kind: 'items',
    name: 'Rows',
    does: 'Each item becomes a full-width row with its parts laid out side by side (for example name and role | quote | logo), and the rows stack, separated by a divider.',
    build: 'Each row is a grid with the item\'s parts as columns, in their original order. Use the original border color for the dividers (or the item surface, if the items had one). Below `md`, each row stacks its parts.',
    fits: (s) => s.items >= 3,
    when: '3 or more items',
  },
  {
    id: 'zigzag',
    kind: 'items',
    name: 'Zigzag',
    does: 'Each item becomes a row with its media and its text side by side, the media alternating left and right from row to row.',
    build: 'A two-column grid per item, with `order` swapped on even rows (keep the DOM order media then text, or text then media, as in the original). Media keeps its aspect ratio and crop at the larger size. Below `md`, every row stacks with the media on top.',
    fits: (s) => s.items >= 2 && s.media,
    when: 'items with an image or video',
  },
  {
    id: 'tabs',
    kind: 'items',
    name: 'Tabs',
    does: 'The items\' titles become a row (or column) of tabs, and one item\'s full content shows at a time, swapping with a short crossfade.',
    build: 'A `role="tablist"` of buttons, each labelled with its item\'s title, styled from the section tokens; the selected tab uses the text color, the rest the muted color. Every item stays in the DOM (inactive ones `hidden`), the first selected. Arrow keys move between tabs. Below `md`, the tabs scroll sideways.',
    fits: (s) => s.items >= 3 && s.items <= 6 && s.media,
    when: '3 to 6 items with an image or video',
  },
  {
    id: 'timeline',
    kind: 'items',
    name: 'Timeline',
    does: 'The items line up along a vertical line, in order, each with a marker on the line, alternating left and right of it.',
    build: 'A centered 1px line in the original border color (or muted text color), a small marker per item in the same color, items in a two-column grid alternating sides. If the items carry step numbers, those sit on the markers\' row. Below `md`, the line moves to the left edge and every item sits to its right.',
    fits: (s) => s.items >= 3,
    when: '3 or more items in a sequence',
  },
  {
    id: 'columns-list',
    kind: 'items',
    name: 'Two-column list',
    does: 'A single list splits into two columns, read down the first column and then the second.',
    build: '`columns: 2` with `break-inside: avoid` on each item and the original gap, or two flex columns holding the first and second half in order. One column below `md`.',
    fits: (s) => s.items >= 4,
    when: '4 or more items in one list',
  },
  {
    id: 'lead-item',
    kind: 'items',
    name: 'Lead item',
    does: 'One item (the first, or the one with the most to say) leads across the full content width, its parts laid out side by side (an avatar and name beside the quote, an image beside the text); the others follow in one row underneath at their original size.',
    build: 'The lead keeps its styling and text sizes, only wider, with its parts in a two-column grid. The rest sit in a grid of equal columns, or, with more than 4, an `overflow-x: auto` row with `scroll-snap-type: x mandatory`. Below `md`, the lead stacks its parts and the rest become a snap row.',
    fits: (s) => s.items >= 3,
    when: '3 or more items',
  },
  {
    id: 'card-deck',
    kind: 'items',
    name: 'Card deck',
    does: 'The items pile into one stack: the top card fully visible, the next two peeking out behind it, offset and slightly smaller. The reader clicks, swipes or uses the arrow keys to send the top card to the back and bring the next forward.',
    build: 'Cards absolutely positioned in a container as tall as the tallest item, the ones behind offset by about 12px and scaled to 0.96 and 0.92, with a transform transition of about 300ms. Previous/next buttons and a position indicator ("2 / 6"), styled only from the section tokens, with `lucide-react` chevrons; swipe with pointer events. Every item stays in the DOM, the ones behind `aria-hidden` and `inert`. With `prefers-reduced-motion`, the cards swap without the transition. Small screens: the same deck at full width.',
    fits: (s) => s.items >= 3 && s.items <= 10,
    when: '3 to 10 items',
  },
  {
    id: 'wall-fade',
    kind: 'items',
    name: 'Wall with fade',
    does: 'The items pack into a tall masonry wall that is cut off after about one and a half screen heights and fades into the section\'s background, with a "Show more" button over the fade that reveals the rest.',
    build: 'Columns as in `masonry` (3, then 2 below `lg`, 1 below `sm`). Cap the wall with `max-height` and `overflow: hidden`, and lay a gradient from transparent to the section\'s background color over its last ~160px (the only gradient the move adds). The button sits centered on the fade, styled from the section tokens, and toggles between "Show more" and "Show less" with `aria-expanded`; expanding lifts the cap with a height transition (none with `prefers-reduced-motion`). While collapsed, items wholly below the cap are `inert`.',
    fits: (s) => s.items >= 6,
    when: '6 or more items',
  },
  {
    id: 'split',
    kind: 'section',
    name: 'Split or stack',
    does: 'A centered, stacked section (text above the visual, or text alone) becomes a two-column split, text left and the visual or the call to action right; a split section becomes a centered stack.',
    build: 'Keep the text block\'s internal order. In a split, align the text column to the left; in a stack, center it and cap it at the original text width. Below `md`, the split stacks.',
    fits: (s) => s.items < 4,
    when: 'a section built around one block of text (hero, call to action, form)',
  },
  {
    id: 'reverse',
    kind: 'section',
    name: 'Mirror',
    does: 'The section\'s two sides swap: the visual moves to the side the text was on, and the text to the visual\'s side.',
    build: 'Swap the columns with `order` or by reversing the grid, never by reordering the DOM. Below `md`, the original stacking order.',
    fits: (s) => s.items < 4 && s.media,
    when: 'a two-sided section with an image or video',
  },
  {
    id: 'asymmetric',
    kind: 'section',
    name: 'Asymmetric',
    does: 'The text block splits across the width: the headline sits large at the top left, and the subline and actions drop to the right, under the headline\'s end, so the eye travels diagonally. A visual, if any, goes below at full content width.',
    build: 'A 12-column grid: the headline spans about 8 columns from the left, the subline and actions about 5 columns from the right, on the next row, aligned to its top. Text-align left throughout. Below `md`, everything stacks left-aligned.',
    fits: (s) => s.header && s.items < 4,
    when: 'a section led by a headline (hero, call to action, showcase)',
  },
  {
    id: 'media-stage',
    kind: 'section',
    name: 'Media stage',
    does: 'The visual moves below the text and becomes the stage: as wide as the content area (or bleeding off the right edge), at its original aspect ratio, with the text centered above it.',
    build: 'The text block first, centered and capped at its original width; the visual after it, scaled up with its aspect ratio locked (never cropped tighter). If the original visual animates or reacts to the pointer, it keeps doing so. Below `md`, the visual is full width.',
    fits: (s) => s.media && s.items < 4,
    when: 'a section with one main image, video or canvas',
  },
  {
    id: 'inline',
    kind: 'section',
    name: 'Inline',
    does: 'The heading and the action (button, form field) sit on one row: text on the left, the action on the right edge. If they already share a row, they stack, centered.',
    build: 'Flex with `justify-between` and `items-center`, the text capped at about 50ch. Below `md`, they stack, left-aligned, the action full width.',
    fits: (s) => s.items < 4,
    when: 'a short section with one action (call to action, newsletter, banner)',
  },
  {
    id: 'nav-arrange',
    kind: 'section',
    name: 'Bar rearranged',
    does: 'The bar\'s three groups (logo, links, actions) take a different arrangement: logo centered with the links split around it, or logo left with the links centered and the actions right, whichever differs from the original. The bar\'s height stays.',
    build: 'A three-column grid (`1fr auto 1fr`) for a centered group. The mobile menu works as in the original, with the same trigger and panel.',
    fits: () => true,
    when: 'a navigation bar',
    only: true,
  },
  {
    id: 'footer-arrange',
    kind: 'section',
    name: 'Footer rearranged',
    does: 'The footer\'s groups take a different arrangement: the brand block left with the link columns grouped to the right, or a centered stack (brand, one row of links, the legal line), whichever differs from the original. Every link and column title stays.',
    build: 'Keep the link groups in their order. The legal line stays last. Below `md`, the columns become two per row, then one.',
    fits: () => true,
    when: 'a footer',
    only: true,
  },
]

export function sectionShape(capture: Capture): Shape {
  const all: SectionPart[] = []
  const walk = (parts: SectionPart[] | undefined) => parts?.forEach((p) => (all.push(p), walk(p.parts)))
  walk(capture.parts)
  const repeated = all.filter((p) => (p.repeats ?? 0) > 1).sort((a, b) => b.repeats! - a.repeats!)[0]
  const lengths = repeated?.items?.map((t) => t.length).filter((n) => n > 0) ?? []
  const media = repeated ? (repeated.kind === 'media' || (repeated.parts ?? []).some(function has(p): boolean { return p.kind === 'media' || (p.parts ?? []).some(has) })) : all.some((p) => p.kind === 'media')
  return {
    items: repeated?.repeats ?? 0,
    item: repeated?.name ?? null,
    columns: repeated && repeated.box.w > 0 ? Math.max(1, Math.min(repeated.repeats!, Math.round(capture.root.box.w / repeated.box.w))) : 0,
    media,
    uneven: lengths.length > 1 && Math.max(...lengths) > 1.5 * Math.min(...lengths),
    header: all.some((p) => p.kind === 'heading' || p.kind === 'header'),
  }
}

// ---------- Playbooks: the moves that suit each kind of section ----------

export interface Playbook {
  job: string // what a reader does with the section
  keep: string[] // what holds on top of the foundations, for this kind of section
  moves: string[] // the moves that suit it, best first
  never: string[] // tempting moves that break it
  why: string // why those break it
}

type Entry = Partial<Playbook> & { family: string }

const LOOSE = ['marquee', 'carousel', 'pinned-scroll', 'masonry', 'bento', 'tabs', 'sticky-stack', 'card-deck', 'wall-fade']

// By family (backend/src/lib/anatomy.ts FAMILIES): the fallback when only the family is sure, and the
// base each type in it builds on.
export const FAMILY_PLAYBOOKS: Record<string, Playbook> = {
  navigation: {
    job: 'find the way around the site',
    keep: ['The bar stays one row at desktop, at the top, at its original height.', 'The mobile menu opens and closes as in the original.'],
    moves: ['nav-arrange', 'inline'],
    never: LOOSE,
    why: 'navigation has to sit still and stay where people expect it',
  },
  hero: {
    job: 'grasp the promise and take the first step',
    keep: ['The headline is read first and stays the largest text.', 'The primary action stays visible on first load at the captured viewport.', 'The main visual stays as prominent as in the original.'],
    moves: ['asymmetric', 'split', 'reverse', 'media-stage'],
    never: LOOSE,
    why: 'a hero is read in one glance: putting its parts in motion or out of view buries the promise',
  },
  'social-proof': {
    job: 'see that other people trust this',
    keep: ['Each proof stays whole: a quote with its name, role and avatar, a number with its label, a logo at its size and treatment.'],
    moves: ['side-header', 'header-row', 'header-center', 'marquee', 'bento', 'masonry', 'carousel', 'lead-item', 'rows'],
    never: [],
    why: '',
  },
  features: {
    job: 'understand what the product does',
    keep: ["Each feature's title, text and visual stay together."],
    moves: ['side-header', 'header-row', 'header-center', 'bento', 'spotlight', 'tabs', 'sticky-stack', 'zigzag', 'offset-columns', 'rows'],
    never: ['marquee'],
    why: 'features are read, and a moving row cannot be read',
  },
  conversion: {
    job: 'decide and act',
    keep: ['The primary action stays the most visible element.', 'Every option and field stays visible.'],
    moves: ['inline', 'split', 'reverse', 'asymmetric', 'header-row'],
    never: ['marquee', 'carousel', 'masonry', 'pinned-scroll', 'sticky-stack', 'card-deck', 'wall-fade'],
    why: 'a decision needs every option in view and the action obvious',
  },
  faq: {
    job: 'scan the questions and open the one that matters',
    keep: ['Every question stays visible and scannable, and each answer stays with its question.', 'Opening and closing works as in the original.'],
    moves: ['side-header', 'columns-list', 'header-row', 'header-center', 'tabs'],
    never: ['marquee', 'carousel', 'bento', 'masonry', 'pinned-scroll', 'sticky-stack', 'card-deck', 'wall-fade'],
    why: 'questions are scanned top to bottom, so they all have to stay in view, in order',
  },
  content: {
    job: 'browse and pick something to open',
    keep: ["Each card's image, title and details stay together."],
    moves: ['spotlight', 'lead-item', 'bento', 'side-header', 'header-row', 'header-center', 'header-split', 'carousel', 'rows', 'offset-columns', 'masonry'],
    never: [],
    why: '',
  },
  footer: {
    job: 'find a link or the legal details',
    keep: ['Every link group keeps its title and links, in order.', 'The legal line stays last.'],
    moves: ['footer-arrange'],
    never: LOOSE,
    why: 'a footer is navigated, not browsed',
  },
}

// By section type (backend/src/lib/anatomy.ts SECTION_TYPES). Fields left out come from the family;
// keep adds to the family's.
export const TYPE_PLAYBOOKS: Record<string, Entry> = {
  navbar: { family: 'navigation', moves: ['nav-arrange'] },
  'announcement-bar': { family: 'navigation', job: 'notice one message', keep: ['It stays one thin line.'], moves: ['inline'] },
  hero: { family: 'hero' },
  'logo-cloud': { family: 'social-proof', job: 'recognize familiar names', moves: ['marquee', 'side-header', 'header-row', 'header-center', 'columns-list'] },
  testimonials: { family: 'social-proof', job: 'read what customers say', moves: ['side-header', 'bento', 'marquee', 'wall-fade', 'lead-item', 'card-deck', 'masonry', 'carousel', 'spotlight', 'offset-columns', 'header-row', 'header-center', 'header-split', 'rows'] },
  stats: {
    family: 'social-proof',
    job: 'take in a few numbers at a glance',
    keep: ['The numbers stay the largest text.'],
    moves: ['side-header', 'header-row', 'header-center', 'rows', 'bento'],
    never: ['marquee', 'carousel', 'pinned-scroll', 'tabs', 'masonry', 'card-deck', 'wall-fade'],
    why: 'numbers are read all at once, at a glance',
  },
  'case-study': {
    family: 'social-proof',
    job: 'follow one customer story to its result',
    keep: ['The result metrics stay next to the quote.'],
    moves: ['split', 'reverse', 'asymmetric', 'side-header'],
    never: ['marquee', 'carousel', 'masonry', 'card-deck', 'wall-fade'],
    why: 'one story is read through, not browsed',
  },
  problem: { family: 'features', job: 'recognize their own problem', moves: ['side-header', 'header-row', 'header-center', 'rows', 'bento', 'sticky-stack', 'split'] },
  'feature-grid': { family: 'features', moves: ['side-header', 'bento', 'spotlight', 'lead-item', 'offset-columns', 'tabs', 'sticky-stack', 'rows', 'header-row', 'header-center', 'header-split', 'carousel', 'zigzag'] },
  'feature-rows': { family: 'features', keep: ["Each feature's text stays beside its visual."], moves: ['sticky-stack', 'tabs', 'spotlight', 'side-header', 'bento', 'header-row', 'zigzag'] },
  'bento-grid': { family: 'features', moves: ['side-header', 'header-row', 'header-center', 'spotlight', 'offset-columns', 'tabs', 'sticky-stack'] },
  'feature-showcase': { family: 'features', keep: ['The visual stays the focus.'], moves: ['asymmetric', 'split', 'reverse', 'media-stage', 'tabs'] },
  'how-it-works': {
    family: 'features',
    job: 'follow the steps in order',
    keep: ['The steps stay in order, with their numbers.'],
    moves: ['timeline', 'sticky-stack', 'pinned-scroll', 'side-header', 'header-row', 'rows', 'zigzag', 'carousel'],
    never: ['marquee', 'masonry', 'bento', 'offset-columns', 'wall-fade'],
    why: 'the steps are a sequence, so the layout has to read in order',
  },
  integrations: { family: 'features', job: 'check that their tools are supported', moves: ['marquee', 'side-header', 'header-row', 'header-center', 'bento', 'wall-fade', 'offset-columns', 'columns-list'], never: [], why: '' },
  'use-cases': { family: 'features', job: 'find the use that matches theirs', moves: ['tabs', 'carousel', 'card-deck', 'spotlight', 'bento', 'sticky-stack', 'side-header', 'header-row', 'header-center', 'zigzag'] },
  comparison: {
    family: 'features',
    job: 'compare options line by line',
    keep: ['Every row and column stays aligned, so values can be compared across.'],
    moves: ['side-header', 'header-row'],
    never: ['marquee', 'carousel', 'masonry', 'bento', 'tabs', 'sticky-stack', 'pinned-scroll', 'card-deck', 'wall-fade'],
    why: 'a comparison only works while its rows and columns line up',
  },
  pricing: {
    family: 'conversion',
    job: 'compare the plans and pick one',
    keep: ['Every tier stays visible and side by side at desktop, with prices, features and buttons lined up across tiers.', 'The highlighted tier stays highlighted, and a billing toggle keeps working.'],
    moves: ['header-row', 'side-header', 'rows'],
    never: ['marquee', 'carousel', 'masonry', 'tabs', 'sticky-stack', 'pinned-scroll', 'bento', 'spotlight', 'card-deck', 'wall-fade', 'lead-item'],
    why: 'plans are compared side by side: hiding, moving or resizing tiers breaks the comparison',
  },
  cta: { family: 'conversion', moves: ['inline', 'split', 'asymmetric', 'reverse', 'media-stage'] },
  'contact-form': { family: 'conversion', keep: ['Every field keeps its label, order and validation.'], moves: ['split', 'reverse', 'side-header'] },
  newsletter: { family: 'conversion', moves: ['inline', 'split', 'reverse'] },
  faq: { family: 'faq', keep: ['Tabs only when the questions come in groups, one tab per group.'] },
  'blog-list': { family: 'content', job: 'pick a post to read' },
  team: { family: 'content', job: 'put faces to the company', keep: ["Each person's photo, name and role stay together."], moves: ['offset-columns', 'side-header', 'header-row', 'header-center', 'carousel', 'card-deck', 'marquee', 'bento', 'rows'] },
  footer: { family: 'footer' },
}

export interface RemixPlan {
  section: string | null // the type ("testimonials") or, when only that is sure, the family ("social-proof")
  sure: boolean // false: the agent classifies the section first, from the playbook table
  guess: string | null // the analysis' best guess when it isn't sure
  playbook: Playbook | null // null for a sure section with no playbook (card, other): moves by shape
  shape: Shape
  offered: Move[] // the moves the prompt describes, best first
  fit: Move[] // the offered moves the section's shape can carry, best first
  never: Move[]
}

const byId = (ids: string[]): Move[] => ids.map((id) => MOVES.find((m) => m.id === id)).filter((m): m is Move => !!m)

export function playbookFor(name: string): Playbook | null {
  const type = TYPE_PLAYBOOKS[name]
  const family = FAMILY_PLAYBOOKS[type?.family ?? name]
  if (!family) return null
  return { ...family, ...type, keep: [...family.keep, ...(type?.keep ?? [])] }
}

// Whether the section is sure follows the backend's naming: the kit is named after the type, or the
// family, only when that reading is confident (analysis.nameFromType).
export function remixPlan(capture: Capture): RemixPlan {
  const shape = sectionShape(capture)
  const analysis = capture.analysis
  const section = analysis?.nameFromType ? (analysis.name ?? analysis.sectionType.value) : null
  if (!section) {
    return { section: null, sure: false, guess: analysis?.sectionType.value ?? null, playbook: null, shape, offered: MOVES, fit: MOVES.filter((m) => !m.only && m.fits(shape)), never: [] }
  }
  const playbook = playbookFor(section)
  const offered = playbook ? byId(playbook.moves) : MOVES.filter((m) => !m.only)
  const fit = offered.filter((m) => m.fits(shape))
  return { section, sure: true, guess: null, playbook, shape, offered, fit: fit.length || !playbook ? fit : offered, never: byId(playbook?.never ?? []) }
}
