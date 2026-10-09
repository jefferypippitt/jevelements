// Where the captured section sits on the page, for the classifier: the page height (the root's box is
// already in page coordinates) and the nearest full-width bands above and below, named by their first
// heading. A big headline with a visual is a hero at the top of the page and a feature section further
// down; what sits around it tells the two apart.
import { stableClasses } from '../shared/dom'
import type { Placement } from '../shared/types'

const NEAR = 2 // bands listed on each side
const MIN_HEIGHT = 32 // px: thinner siblings are spacers and dividers
const MIN_WIDTH_SHARE = 0.5 // of the viewport: narrower siblings are columns, not page bands
const HEADING_CHARS = 60

type Step = 'previousElementSibling' | 'nextElementSibling'

export function pagePlacement(target: Element): Placement {
  const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
  return { pageHeight, before: neighbours(target, 'previousElementSibling'), after: neighbours(target, 'nextElementSibling') }
}

// Siblings of the section, then of each ancestor, closest first, until NEAR bands are found.
function neighbours(target: Element, step: Step): string[] {
  const bands: string[] = []
  for (let at: Element | null = target; at && at !== document.body && bands.length < NEAR; at = at.parentElement) {
    for (let sibling = at[step]; sibling && bands.length < NEAR; sibling = sibling[step]) {
      const r = sibling.getBoundingClientRect()
      if (r.height < MIN_HEIGHT || r.width < window.innerWidth * MIN_WIDTH_SHARE) continue
      bands.push(bandName(sibling))
    }
  }
  return bands
}

function bandName(el: Element): string {
  const heading = el.matches('h1, h2, h3') ? el : el.querySelector('h1, h2, h3')
  const text = heading?.textContent?.replace(/\s+/g, ' ').trim()
  if (heading && text) return `${heading.tagName.toLowerCase()} "${text.length > HEADING_CHARS ? `${text.slice(0, HEADING_CHARS)}…` : text}"`
  if (el.matches('nav, header') || el.querySelector(':scope > nav')) return 'navigation bar'
  if (el.matches('footer')) return 'footer'
  const media = el.querySelectorAll('img, svg').length
  const words = (el.textContent ?? '').trim().split(/\s+/).filter(Boolean).length
  if (media >= 4 && words < media * 2) return `${media} images or logos with little text`
  const cls = stableClasses(el).slice(0, 2)
  return el.tagName.toLowerCase() + (cls.length ? `.${cls.join('.')}` : '')
}
